import type { ProviderId } from '../shared/types';
import type { Bridge } from '../core/bridge';
import { BridgeError } from '../core/errors';
import type { SendPhase } from '../core/provider';

/** The agent's "brain": one web chat conversation on ChatGPT or Grok. */
export interface ChatBackend {
  readonly label: string;
  send(req: {
    prompt: string;
    /** Continue this web conversation; omitted for the first message. */
    chatUrl?: string;
    /** Sent instead of `prompt` if the conversation at chatUrl turns out to be gone. */
    fallbackPrompt?: string;
    signal?: AbortSignal;
    /** Partial reply text while the model is writing (when the backend can stream). */
    onProgress?: (text: string) => void;
    /** Where the request is (queued, sending, waiting for the reply, ...). */
    onPhase?: (phase: SendPhase) => void;
  }): Promise<{ text: string; chatUrl?: string }>;
}

/** Drives the browser in this process (desktop app, or a CLI run when no bridge is running). */
export class ProviderBackend implements ChatBackend {
  constructor(
    private bridge: Bridge,
    private provider: ProviderId,
    private model?: string,
  ) {}

  get label(): string {
    return `${this.bridge.providers[this.provider].name}${this.model ? ` (${this.model})` : ''}`;
  }

  async send(req: Parameters<ChatBackend['send']>[0]) {
    const result = await this.bridge.provider(this.provider).send({
      prompt: req.prompt,
      chatUrl: req.chatUrl,
      fallbackPrompt: req.fallbackPrompt,
      model: req.chatUrl ? undefined : this.model,
      signal: req.signal,
      onUpdate: req.onProgress,
      onPhase: req.onPhase,
    });
    if (result.aborted) throw new BridgeError('aborted', 'Stopped.');
    return { text: result.text, chatUrl: result.chatUrl };
  }
}

/**
 * Uses a bridge that is already running (desktop app or `local-ai-bridge serve`) through its MCP
 * endpoint, so the CLI agent works while the app holds the browser profiles.
 */
export class HttpBackend implements ChatBackend {
  private nextId = 1;

  constructor(
    private origin: string,
    private apiKey: string,
    private provider: ProviderId,
    private model?: string,
  ) {}

  get label(): string {
    return `${this.provider === 'chatgpt' ? 'ChatGPT' : 'Grok'}${this.model ? ` (${this.model})` : ''} via ${this.origin}`;
  }

  /** True if a bridge answers at this origin. */
  static async probe(origin: string): Promise<boolean> {
    try {
      const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1500) });
      return res.ok && ((await res.json()) as { name?: string }).name === 'local-ai-bridge';
    } catch {
      return false;
    }
  }

  async send(req: Parameters<ChatBackend['send']>[0]) {
    const args: Record<string, unknown> = { prompt: req.prompt };
    if (req.chatUrl) args.chat_url = req.chatUrl;
    else if (this.model && this.provider === 'chatgpt') args.model = this.model;
    let res: Response;
    // The running bridge does the browser work; from here only "sent" and "waiting" are visible.
    req.onPhase?.('sending');
    const waiting = setTimeout(() => req.onPhase?.('waiting'), 1_500);
    try {
      res = await fetch(`${this.origin}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: this.nextId++,
          method: 'tools/call',
          params: { name: this.provider === 'chatgpt' ? 'ask_chatgpt' : 'ask_grok', arguments: args },
        }),
        signal: req.signal,
      });
    } catch (e) {
      if (req.signal?.aborted) throw new BridgeError('aborted', 'Stopped.');
      throw new BridgeError('internal', `Bridge at ${this.origin} is not reachable: ${(e as Error).message}`);
    } finally {
      clearTimeout(waiting);
    }
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[]; structuredContent?: { reply?: string; chat_url?: string } };
      error?: { message?: string };
    };
    if (body.error) throw new BridgeError('internal', body.error.message ?? 'MCP error');
    if (body.result?.isError) throw new BridgeError('internal', body.result.content?.[0]?.text ?? 'Tool call failed');
    const sc = body.result?.structuredContent;
    return { text: sc?.reply ?? '', chatUrl: sc?.chat_url };
  }
}
