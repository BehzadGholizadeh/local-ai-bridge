import type http from 'node:http';
import { createHash } from 'node:crypto';
import { PROVIDER_IDS, type ProviderId } from '../../shared/types';
import type { Bridge } from '../bridge';
import { BridgeError, HTTP_STATUS } from '../errors';
import { fromOllamaImages, type Attachment } from '../attachments';
import { buildPrompt, openAiMessagesToTurns, type PromptTurn } from '../prompt';
import { resolveModel, runCompletion, unknownModel, type ResolvedModel } from './completion';
import { abortOnClose, estimateTokens, readJson, sendJson } from './http';

// Ollama-compatible endpoints (/api/*), so tools that only speak Ollama (Open WebUI, Continue's
// ollama provider, Raycast, Obsidian plugins, ...) can use the bridge. Models appear as
// "chatgpt:latest" and "grok:latest"; "chatgpt:<slug>" picks a ChatGPT model.

/** Reported by /api/version. Recent enough that clients don't refuse to talk to us. */
const OLLAMA_VERSION = '0.12.0';

function ollamaError(res: http.ServerResponse, err: BridgeError): void {
  sendJson(res, HTTP_STATUS[err.code], { error: err.message });
}

function modelEntry(provider: ProviderId) {
  const name = `${provider}:latest`;
  return {
    name,
    model: name,
    modified_at: new Date().toISOString(),
    size: 0,
    digest: createHash('sha256').update(name).digest('hex'),
    details: { parent_model: '', format: 'web', family: provider, families: [provider], parameter_size: '', quantization_level: '' },
  };
}

/** GET /api/version */
export function version(res: http.ServerResponse): void {
  sendJson(res, 200, { version: OLLAMA_VERSION });
}

/** GET /api/tags */
export function tags(bridge: Bridge, res: http.ServerResponse): void {
  const { enabledProviders } = bridge.settings.get();
  sendJson(res, 200, { models: PROVIDER_IDS.filter((id) => enabledProviders[id]).map(modelEntry) });
}

/** GET /api/ps: nothing is "loaded" in the Ollama sense. */
export function ps(res: http.ServerResponse): void {
  sendJson(res, 200, { models: [] });
}

/** POST /api/show */
export async function show(bridge: Bridge, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson(req);
  const name = body.model ?? body.name;
  const model = resolveModel(name);
  if (!model || !bridge.settings.get().enabledProviders[model.provider]) {
    return ollamaError(res, new BridgeError('bad_request', `model "${String(name)}" not found`));
  }
  const entry = modelEntry(model.provider);
  sendJson(res, 200, {
    modelfile: '',
    parameters: '',
    template: '{{ .Prompt }}',
    details: entry.details,
    model_info: { 'general.architecture': 'web', 'general.basename': model.provider, 'web.context_length': 128000 },
    capabilities: ['completion'],
    modified_at: entry.modified_at,
  });
}

/** POST /api/chat */
export async function chat(bridge: Bridge, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson(req);
  const model = resolveModel(body.model);
  if (!model) return ollamaError(res, unknownModel(body.model));
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return ollamaError(res, new BridgeError('bad_request', '"messages" must be a non-empty array.'));
  }
  const turns = openAiMessagesToTurns(body.messages);
  const attachments = fromOllamaImages(body.messages.map((m) => (m as { images?: unknown } | null)?.images));
  await respond(bridge, res, body, model, turns, attachments, 'chat');
}

/** POST /api/generate */
export async function generate(bridge: Bridge, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson(req);
  const model = resolveModel(body.model);
  if (!model) return ollamaError(res, unknownModel(body.model));
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim() && !(Array.isArray(body.images) && body.images.length)) {
    // Ollama treats an empty prompt as "load the model": answer immediately.
    return sendJson(res, 200, {
      model: String(body.model),
      created_at: new Date().toISOString(),
      response: '',
      done: true,
      done_reason: 'load',
    });
  }
  const turns: PromptTurn[] = [];
  if (typeof body.system === 'string' && body.system.trim()) turns.push({ role: 'system', content: body.system });
  turns.push({ role: 'user', content: prompt });
  await respond(bridge, res, body, model, turns, fromOllamaImages([body.images]), 'generate');
}

async function respond(
  bridge: Bridge,
  res: http.ServerResponse,
  body: Record<string, unknown>,
  model: ResolvedModel,
  turns: PromptTurn[],
  attachments: Attachment[],
  kind: 'chat' | 'generate',
): Promise<void> {
  const prompt = buildPrompt(turns, bridge.settings.get().systemPrompt);
  if (!prompt.trim() && !attachments.length) {
    return ollamaError(res, new BridgeError('bad_request', 'The messages contain no text.'));
  }
  const name = String(body.model);
  const started = process.hrtime.bigint();
  const signal = abortOnClose(res);
  // Ollama streams unless the client explicitly sends "stream": false.
  const stream = body.stream !== false;

  const piece = (text: string, done: boolean) => ({
    model: name,
    created_at: new Date().toISOString(),
    ...(kind === 'chat' ? { message: { role: 'assistant', content: text } } : { response: text }),
    done,
  });
  const final = (text: string) => ({
    ...piece(text, true),
    done_reason: 'stop',
    total_duration: Number(process.hrtime.bigint() - started),
    load_duration: 0,
    prompt_eval_count: estimateTokens(prompt),
    prompt_eval_duration: 0,
    eval_count: estimateTokens(text),
    eval_duration: Number(process.hrtime.bigint() - started),
    ...(kind === 'generate' ? { context: [] } : {}),
  });

  if (!stream) {
    try {
      const result = await runCompletion(bridge, { model, prompt, attachments, signal, via: 'ollama' });
      return sendJson(res, 200, final(result.text));
    } catch (e) {
      return ollamaError(res, BridgeError.from(e));
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  const line = (obj: unknown) => res.write(`${JSON.stringify(obj)}\n`);
  let full = '';
  try {
    await runCompletion(bridge, {
      model,
      prompt,
      signal,
      via: 'ollama',
      attachments,
      onDelta: (delta) => {
        full += delta;
        line(piece(delta, false));
      },
    });
    line({ ...final(''), eval_count: estimateTokens(full) });
  } catch (e) {
    line({ error: BridgeError.from(e).message });
  } finally {
    if (!res.writableEnded) res.end();
  }
}
