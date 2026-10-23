import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Bridge } from '../bridge';
import { BridgeError } from '../errors';
import { buildPrompt, openAiMessagesToTurns } from '../prompt';
import { resolveModel, runCompletion, unknownModel } from './completion';
import { abortOnClose, estimateTokens, readJson, sendError, sendJson } from './http';

const KEEPALIVE_MS = 15_000;

/** GET /v1/models */
export function models(bridge: Bridge, res: http.ServerResponse): void {
  const created = Math.floor(Date.now() / 1000);
  const { enabledProviders } = bridge.settings.get();
  const data = [
    { id: 'chatgpt', owned_by: 'chatgpt.com (web session)', enabled: enabledProviders.chatgpt },
    { id: 'grok', owned_by: 'grok.com (web session)', enabled: enabledProviders.grok },
  ]
    .filter((m) => m.enabled)
    .map(({ id, owned_by }) => ({ id, object: 'model', created, owned_by }));
  sendJson(res, 200, { object: 'list', data });
}

/** POST /v1/chat/completions. Each request opens a new web chat with the flattened messages. */
export async function chatCompletions(bridge: Bridge, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson(req);
  const model = resolveModel(body.model);
  if (!model) return sendError(res, unknownModel(body.model));
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return sendError(res, new BridgeError('bad_request', '"messages" must be a non-empty array.'));
  }
  const prompt = buildPrompt(openAiMessagesToTurns(body.messages), bridge.settings.get().systemPrompt);
  if (!prompt.trim()) return sendError(res, new BridgeError('bad_request', 'The messages contain no text.'));

  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`;
  const created = Math.floor(Date.now() / 1000);
  const signal = abortOnClose(res);

  if (!body.stream) {
    try {
      const result = await runCompletion(bridge, { model, prompt, signal, via: 'openai' });
      const p = estimateTokens(prompt);
      const c = estimateTokens(result.text);
      return sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: model.id,
        choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c },
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
  try {
    await runCompletion(bridge, { model, prompt, signal, via: 'openai', onDelta: (content) => chunk({ content }) });
    chunk({}, 'stop');
  } catch (e) {
    const err = BridgeError.from(e);
    res.write(`data: ${JSON.stringify({ error: { message: err.message, type: err.code, code: err.code } })}\n\n`);
  } finally {
    clearInterval(keepalive);
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}
