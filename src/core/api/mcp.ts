import type http from 'node:http';
import { PROVIDER_NAMES, type ProviderId } from '../../shared/types';
import type { Bridge } from '../bridge';
import { BridgeError } from '../errors';
import { buildPrompt } from '../prompt';
import { runCompletion } from './completion';
import { abortOnClose, readBody, sendJson } from './http';

// Model Context Protocol server over Streamable HTTP (POST /mcp), stateless: every request is
// a JSON-RPC message (or batch) answered with plain JSON. Clients that only speak stdio use
// dist/mcp-stdio.js, which forwards to this endpoint.

/** Newest first; the first one the client also supports is used. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

const askSchema = (provider: ProviderId) => ({
  type: 'object',
  properties: {
    prompt: { type: 'string', description: `The message to send to ${PROVIDER_NAMES[provider]}.` },
    ...(provider === 'chatgpt'
      ? {
          model: {
            type: 'string',
            description: 'Optional ChatGPT model slug for a new chat, e.g. "gpt-4o". Omit for the default model.',
          },
        }
      : {}),
    chat_url: {
      type: 'string',
      description:
        'Continue an earlier conversation: pass the chat_url returned by a previous call. Omit to start a new chat.',
    },
  },
  required: ['prompt'],
  additionalProperties: false,
});

const askOutputSchema = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'The reply, as Markdown.' },
    chat_url: { type: 'string', description: 'Pass this back as chat_url to continue the conversation.' },
  },
  required: ['reply'],
};

const TOOLS = [
  {
    name: 'ask_chatgpt',
    title: 'Ask ChatGPT',
    description:
      'Send a message to ChatGPT (chatgpt.com) through the user\'s signed-in browser session and return the reply as Markdown. ' +
      'Starts a new chat unless chat_url is given. Replies can take up to a few minutes; requests to the same site are answered one at a time.',
    inputSchema: askSchema('chatgpt'),
    outputSchema: askOutputSchema,
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'ask_grok',
    title: 'Ask Grok',
    description:
      'Send a message to Grok (grok.com) through the user\'s signed-in browser session and return the reply as Markdown. ' +
      'Starts a new chat unless chat_url is given.',
    inputSchema: askSchema('grok'),
    outputSchema: askOutputSchema,
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'status',
    title: 'Bridge status',
    description:
      'Show whether ChatGPT and Grok are ready, signed out, rate limited or need a security check. Call this when an ask_* tool fails.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

/** POST /mcp (GET is answered with 405: this server never opens a server-to-client stream). */
export async function handleMcp(bridge: Bridge, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const signal = abortOnClose(res);
  const messages = (Array.isArray(body) ? body : [body]) as JsonRpcRequest[];
  const responses = (await Promise.all(messages.map((m) => handleMessage(bridge, m, signal)))).filter(
    (r): r is JsonRpcResponse => r !== null,
  );
  if (!responses.length) {
    // Only notifications or client responses.
    res.writeHead(202).end();
    return;
  }
  sendJson(res, 200, Array.isArray(body) ? responses : responses[0]);
}

async function handleMessage(bridge: Bridge, msg: JsonRpcRequest, signal: AbortSignal): Promise<JsonRpcResponse | null> {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return null;
  if (msg.id === undefined) return null; // notification, e.g. notifications/initialized
  const id = msg.id;
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (msg.method) {
    case 'initialize': {
      const requested = String(msg.params?.protocolVersion ?? '');
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'local-ai-bridge', title: 'Local AI Bridge', version: bridge.version },
        instructions:
          'Ask ChatGPT or Grok through the user\'s own browser sessions. Use ask_chatgpt / ask_grok with a self-contained prompt; ' +
          'pass chat_url from a previous result to continue that conversation. If a call fails, call status and tell the user what to do ' +
          '(for example, sign in from the Local AI Bridge app).',
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call':
      return ok(await callTool(bridge, msg.params ?? {}, signal));
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

async function callTool(bridge: Bridge, params: Record<string, unknown>, signal: AbortSignal) {
  const name = String(params.name ?? '');
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const textResult = (text: string, isError = false) => ({ content: [{ type: 'text', text }], isError });

  if (name === 'status') return textResult(statusText(bridge));
  if (name !== 'ask_chatgpt' && name !== 'ask_grok') return textResult(`Unknown tool: ${name}`, true);

  const provider: ProviderId = name === 'ask_chatgpt' ? 'chatgpt' : 'grok';
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) return textResult('"prompt" is required.', true);
  const chatUrl = typeof args.chat_url === 'string' && args.chat_url.trim() ? args.chat_url.trim() : undefined;
  if (chatUrl && !isProviderUrl(bridge, provider, chatUrl)) {
    return textResult(`chat_url must be a ${PROVIDER_NAMES[provider]} conversation URL returned by an earlier call.`, true);
  }
  const slug = provider === 'chatgpt' && typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined;

  try {
    const result = await runCompletion(bridge, {
      model: { provider, slug, id: provider },
      prompt: chatUrl ? prompt : buildPrompt([{ role: 'user', content: prompt }], bridge.settings.get().systemPrompt),
      chatUrl,
      signal,
      via: 'mcp',
    });
    const reply = result.text || '(empty reply)';
    const footer = result.chatUrl ? `\n\n---\nchat_url: ${result.chatUrl}` : '';
    return {
      content: [{ type: 'text', text: reply + footer }],
      structuredContent: { reply, ...(result.chatUrl ? { chat_url: result.chatUrl } : {}) },
      isError: false,
    };
  } catch (e) {
    const err = BridgeError.from(e);
    return textResult(`${PROVIDER_NAMES[provider]} failed (${err.code}): ${err.message}`, true);
  }
}

/** Only let chat_url point at the provider's own site, never an arbitrary page. */
function isProviderUrl(bridge: Bridge, provider: ProviderId, url: string): boolean {
  try {
    return new URL(url).origin === new URL(bridge.selectors.get(provider).url).origin;
  } catch {
    return false;
  }
}

function statusText(bridge: Bridge): string {
  const settings = bridge.settings.get();
  const lines = bridge.statuses().map((s) => {
    if (!settings.enabledProviders[s.id]) return `${s.name}: disabled in Settings`;
    const guest = s.guest ? ' (guest, not signed in)' : '';
    return `${s.name}: ${s.state}${guest}${s.detail ? ` — ${s.detail}` : ''}`;
  });
  const api = bridge.apiInfo();
  lines.push(`API: ${api.running ? api.url : `not running${api.error ? ` (${api.error})` : ''}`}`);
  return lines.join('\n');
}
