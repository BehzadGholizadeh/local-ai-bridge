import type { ProviderId } from '../../shared/types';
import type { Bridge } from '../bridge';
import { BridgeError } from '../errors';
import type { SendResult } from '../provider';

/** While streaming, hold back the tail of the reply: re-rendered Markdown can still change there. */
const STREAM_HOLDBACK = 64;

export interface ResolvedModel {
  provider: ProviderId;
  slug?: string;
  /** The name to echo back to the client. */
  id: string;
}

/**
 * Maps a client's model name to a provider. Accepts the OpenAI style (chatgpt, chatgpt/<slug>,
 * gpt-*, o*, grok, grok-*) and the Ollama style (chatgpt:latest, chatgpt:<slug>, grok:latest).
 */
export function resolveModel(model: unknown): ResolvedModel | null {
  const id = String(model ?? '').trim();
  const m = id.replace(/:latest$/i, '').replace(/^(chatgpt|grok):/i, '$1/');
  const lower = m.toLowerCase();
  if (!lower || lower === 'chatgpt') return { provider: 'chatgpt', id: id || 'chatgpt' };
  if (lower.startsWith('chatgpt/')) return { provider: 'chatgpt', slug: m.slice(8) || undefined, id };
  if (lower === 'grok' || lower.startsWith('grok/') || lower.startsWith('grok-')) return { provider: 'grok', id };
  if (/^(gpt-|o\d|chatgpt-)/.test(lower)) return { provider: 'chatgpt', slug: m, id };
  return null;
}

export function unknownModel(model: unknown): BridgeError {
  return new BridgeError('bad_request', `Unknown model "${String(model)}". Use "chatgpt", "chatgpt/<model-slug>" or "grok".`);
}

export interface CompletionRequest {
  model: ResolvedModel;
  prompt: string;
  /** Continue this web conversation instead of opening a new chat. */
  chatUrl?: string;
  signal?: AbortSignal;
  /** Receives new text as it becomes stable. When set, every character is delivered exactly once. */
  onDelta?: (delta: string) => void;
  /** Label for the log line, e.g. "openai", "ollama", "mcp". */
  via: string;
}

/**
 * Sends one prompt to a provider (queued behind other requests to it) and returns the reply.
 * Shared by the OpenAI, Ollama and MCP front ends.
 */
export async function runCompletion(bridge: Bridge, req: CompletionRequest): Promise<SendResult> {
  const provider = bridge.provider(req.model.provider);
  const settings = bridge.settings.get();
  const slug = req.chatUrl
    ? undefined
    : req.model.slug ?? (req.model.provider === 'chatgpt' ? settings.chatgptModel || undefined : undefined);
  bridge.log.info(
    `${req.via} request → ${req.model.provider}${slug ? ` (${slug})` : ''}${req.chatUrl ? ' (continuing chat)' : ''}, stream=${!!req.onDelta}`,
  );

  const onDelta = req.onDelta;
  let sent = '';
  const emit = (text: string, final: boolean) => {
    if (!onDelta) return;
    let upTo = text.length;
    if (!final) {
      upTo = text.length - STREAM_HOLDBACK;
      upTo = Math.max(text.lastIndexOf(' ', upTo), text.lastIndexOf('\n', upTo));
    }
    if (upTo <= sent.length) return;
    const stable = text.slice(0, upTo);
    if (stable.startsWith(sent)) {
      onDelta(stable.slice(sent.length));
      sent = stable;
    } else if (final) {
      // The rendered Markdown changed in an already-sent part; send what is new after the common prefix.
      let i = 0;
      while (i < sent.length && sent[i] === text[i]) i++;
      onDelta(text.slice(Math.max(i, sent.length)));
      sent = text;
    }
  };

  try {
    const result = await provider.send({
      prompt: req.prompt,
      chatUrl: req.chatUrl,
      model: slug,
      signal: req.signal,
      onUpdate: onDelta ? (t) => emit(t, false) : undefined,
    });
    emit(result.text, true);
    return result;
  } catch (e) {
    const err = BridgeError.from(e);
    if (err.partial) emit(err.partial, true);
    throw err;
  }
}
