import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { ProviderId } from '../shared/types';
import type { Bridge } from './bridge';
import { BridgeError, HTTP_STATUS } from './errors';
import { buildPrompt, openAiMessagesToTurns } from './prompt';

const MAX_BODY = 10 * 1024 * 1024;
const KEEPALIVE_MS = 15_000;
/** While streaming, hold back the tail of the reply: re-rendered Markdown can still change there. */
const STREAM_HOLDBACK = 64;

interface ResolvedModel {
  provider: ProviderId;
  slug?: string;
  id: string;
}

/** Maps an OpenAI `model` string to a provider: chatgpt, chatgpt/<slug>, gpt-*, o*, grok, grok-*. */
export function resolveModel(model: unknown): ResolvedModel | null {
  const m = String(model ?? '').trim();
  const lower = m.toLowerCase();
  if (!lower || lower === 'chatgpt') return { provider: 'chatgpt', id: 'chatgpt' };
  if (lower.startsWith('chatgpt/')) return { provider: 'chatgpt', slug: m.slice(8) || undefined, id: m };
  if (lower === 'grok' || lower.startsWith('grok/') || lower.startsWith('grok-')) return { provider: 'grok', id: m };
  if (/^(gpt-|o\d|chatgpt-)/.test(lower)) return { provider: 'chatgpt', slug: m, id: m };
  return null;
}

/**
 * OpenAI-compatible HTTP API on 127.0.0.1. Each request starts a new web chat;
 * the full message list is flattened into one prompt.
 */
export class ApiServer {
  private server?: http.Server;
  error?: string;

  constructor(private bridge: Bridge) {}

  get running(): boolean {
    return !!this.server?.listening;
  }

  get url(): string {
    return `http://127.0.0.1:${this.bridge.settings.get().port}/v1`;
  }

  async start(): Promise<void> {
    const { port } = this.bridge.settings.get();
    this.error = undefined;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.bridge.log.error('API handler error:', e);
        if (!res.headersSent) sendError(res, BridgeError.from(e));
        else res.end();
      });
    });
    server.keepAliveTimeout = 65_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      this.error = code === 'EADDRINUSE' ? `Port ${port} is already in use. Pick another port in Settings.` : (e as Error).message;
      throw e;
    }
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const settings = this.bridge.settings.get();

    // Reject DNS-rebinding attempts: only loopback host names may address this server.
    const host = (req.headers.host ?? '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      return sendJson(res, 403, { error: { message: 'Forbidden host', type: 'forbidden' } });
    }
    // Web pages may only call the API from origins the user allowed.
    const origin = req.headers.origin;
    if (origin) {
      const allowed = settings.corsOrigins.includes('*') || settings.corsOrigins.includes(origin);
      if (!allowed) {
        return sendJson(res, 403, {
          error: { message: `Origin ${origin} is not allowed. Add it under Settings → Allowed origins.`, type: 'forbidden' },
        });
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && (route === '/' || route === '/health')) {
      return sendJson(res, 200, { ok: true, name: 'local-ai-bridge', providers: this.bridge.statuses() });
    }

    if (settings.apiKey && !checkKey(req.headers.authorization, settings.apiKey)) {
      return sendJson(res, 401, {
        error: { message: 'Invalid API key. Use the key from Settings → API key.', type: 'invalid_request_error', code: 'invalid_api_key' },
      });
    }

    if (req.method === 'GET' && route === '/v1/models') return this.models(res);
    if (req.method === 'GET' && route === '/v1/bridge/status') {
      return sendJson(res, 200, { api: this.bridge.apiInfo(), providers: this.bridge.statuses() });
    }
    if (req.method === 'POST' && route === '/v1/chat/completions') return this.chatCompletions(req, res);
    return sendJson(res, 404, { error: { message: `No route for ${req.method} ${route}`, type: 'not_found' } });
  }

  private models(res: http.ServerResponse): void {
    const created = Math.floor(Date.now() / 1000);
    const { enabledProviders } = this.bridge.settings.get();
    const data = [
      { id: 'chatgpt', owned_by: 'chatgpt.com (web session)', enabled: enabledProviders.chatgpt },
      { id: 'grok', owned_by: 'grok.com (web session)', enabled: enabledProviders.grok },
    ]
      .filter((m) => m.enabled)
      .map(({ id, owned_by }) => ({ id, object: 'model', created, owned_by }));
    sendJson(res, 200, { object: 'list', data });
  }

  private async chatCompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch (e) {
      return sendError(res, e instanceof BridgeError ? e : new BridgeError('bad_request', 'Body must be JSON.'));
    }
    const model = resolveModel(body.model);
    if (!model) {
      return sendError(
        res,
        new BridgeError('bad_request', `Unknown model "${String(body.model)}". Use "chatgpt", "chatgpt/<model-slug>" or "grok".`),
      );
    }
    if (!Array.isArray(body.messages) || !body.messages.length) {
      return sendError(res, new BridgeError('bad_request', '"messages" must be a non-empty array.'));
    }
    const prompt = buildPrompt(openAiMessagesToTurns(body.messages), this.bridge.settings.get().systemPrompt);
    if (!prompt.trim()) return sendError(res, new BridgeError('bad_request', 'The messages contain no text.'));

    let provider;
    try {
      provider = this.bridge.provider(model.provider);
    } catch (e) {
      return sendError(res, BridgeError.from(e));
    }

    const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`;
    const created = Math.floor(Date.now() / 1000);
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });
    const settings = this.bridge.settings.get();
    const slug = model.slug ?? (model.provider === 'chatgpt' ? settings.chatgptModel || undefined : undefined);
    this.bridge.log.info(`API request → ${model.provider}${slug ? ` (${slug})` : ''}, stream=${!!body.stream}`);

    if (!body.stream) {
      try {
        const result = await provider.send({ prompt, model: slug, signal: ac.signal });
        return sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model: model.id,
          choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
          usage: usage(prompt, result.text),
        });
      } catch (e) {
        return sendError(res, BridgeError.from(e));
      }
    }

    // Streaming (SSE). Headers go out immediately so clients see the connection is alive
    // while the request waits in the queue.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: model.id,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`,
      );
    chunk({ role: 'assistant', content: '' });
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);

    let sent = '';
    const emitUpTo = (text: string, final: boolean) => {
      let upTo = text.length;
      if (!final) {
        upTo = text.length - STREAM_HOLDBACK;
        const ws = text.lastIndexOf(' ', upTo);
        const nl = text.lastIndexOf('\n', upTo);
        upTo = Math.max(ws, nl);
      }
      if (upTo <= sent.length) return;
      const stable = text.slice(0, upTo);
      if (stable.startsWith(sent)) {
        chunk({ content: stable.slice(sent.length) });
        sent = stable;
      } else if (final) {
        // The rendered Markdown changed in an already-sent part; send what is new after the common prefix.
        let i = 0;
        while (i < sent.length && sent[i] === text[i]) i++;
        chunk({ content: text.slice(Math.max(i, sent.length)) });
        sent = text;
      }
    };

    try {
      const result = await provider.send({ prompt, model: slug, signal: ac.signal, onUpdate: (t) => emitUpTo(t, false) });
      emitUpTo(result.text, true);
      chunk({}, 'stop');
    } catch (e) {
      const err = BridgeError.from(e);
      if (err.partial) emitUpTo(err.partial, true);
      res.write(`data: ${JSON.stringify({ error: { message: err.message, type: err.code, code: err.code } })}\n\n`);
    } finally {
      clearInterval(keepalive);
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  }
}

function checkKey(header: string | undefined, key: string): boolean {
  const given = Buffer.from((header ?? '').replace(/^Bearer\s+/i, '').trim());
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function usage(prompt: string, completion: string) {
  // The web UIs don't report tokens; ~4 characters per token is a rough estimate.
  const p = Math.ceil(prompt.length / 4);
  const c = Math.ceil(completion.length / 4);
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new BridgeError('bad_request', 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendError(res: http.ServerResponse, err: BridgeError): void {
  sendJson(res, HTTP_STATUS[err.code], { error: { message: err.message, type: err.code, code: err.code } });
}
