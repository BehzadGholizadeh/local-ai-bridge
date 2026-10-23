import { EventEmitter } from 'node:events';
import { PROVIDER_IDS, type ChatMessage, type Conversation, type ProviderId, type SendInput } from '../shared/types';
import { checkCount, fromBase64, mimeFromName, type Attachment } from './attachments';
import type { Bridge } from './bridge';
import { BridgeError } from './errors';
import { buildPrompt, type PromptTurn } from './prompt';

const UPDATE_INTERVAL_MS = 100;

/**
 * Conversations in the desktop app. A message can go to several providers at once;
 * each provider keeps its own web conversation, which follow-ups continue.
 * Emits 'message' ({ conversationId, message }) and 'history'.
 */
export class ChatService extends EventEmitter {
  private running = new Map<string, AbortController>();

  constructor(private bridge: Bridge) {
    super();
  }

  isRunning(conversationId: string): boolean {
    return this.running.has(conversationId);
  }

  async send(input: SendInput): Promise<{ conversationId: string }> {
    const text = input.text.trim();
    const targets = [...new Set(input.targets)].filter((t) => PROVIDER_IDS.includes(t));
    const sent = input.attachments ?? [];
    checkCount(sent.length);
    const attachments = sent.map((a, i) =>
      fromBase64(Buffer.from(a.data).toString('base64'), i, a.name, a.mimeType || mimeFromName(a.name)),
    );
    if (!text && !attachments.length) throw new BridgeError('bad_request', 'Message is empty.');
    if (!targets.length) throw new BridgeError('bad_request', 'Pick at least one model.');
    const { history } = this.bridge;

    const existing = input.conversationId ? history.get(input.conversationId) : undefined;
    if (input.conversationId && !existing) throw new BridgeError('bad_request', 'Conversation not found.');
    if (existing && this.running.has(existing.id)) {
      throw new BridgeError('busy', 'Wait for the current reply to finish, or stop it.');
    }
    const conv: Conversation = existing ?? history.create(text || attachments.map((a) => a.name).join(', '), targets);
    const prior = conv.messages.filter((m) => m.role === 'user' || m.status === 'done');

    const userMsg = history.newMessage({
      role: 'user',
      content: text,
      ...(attachments.length
        ? { attachments: attachments.map((a) => ({ name: a.name, mimeType: a.mimeType, size: a.data.length })) }
        : {}),
    });
    this.patch(conv.id, userMsg);

    const ac = new AbortController();
    this.running.set(conv.id, ac);
    const jobs = targets.map((target) => {
      const msg = history.newMessage({ role: 'assistant', provider: target, content: '', status: 'streaming' });
      this.patch(conv.id, msg);
      return this.runOne(conv, target, text, attachments, prior, msg, ac.signal);
    });
    this.emit('history');
    void Promise.allSettled(jobs).finally(() => {
      this.running.delete(conv.id);
      this.emit('history');
    });
    return { conversationId: conv.id };
  }

  stop(conversationId: string): void {
    this.running.get(conversationId)?.abort();
  }

  private async runOne(
    conv: Conversation,
    target: ProviderId,
    text: string,
    attachments: Attachment[],
    prior: ChatMessage[],
    msg: ChatMessage,
    signal: AbortSignal,
  ): Promise<void> {
    const settings = this.bridge.settings.get();
    const chatUrl = conv.providerChats[target];
    // A new web chat for this provider gets the system prompt and any earlier turns (when the
    // provider joins midway). The same text is the fallback if a saved web chat has expired.
    const turns: PromptTurn[] = prior.map((m) => ({
      role: m.role,
      content: m.attachments?.length
        ? `${m.content}\n[Attached: ${m.attachments.map((a) => a.name).join(', ')}]`.trim()
        : m.content,
      name: m.provider ? this.bridge.providers[m.provider].name : undefined,
    }));
    turns.push({ role: 'user', content: text });
    const contextPrompt = buildPrompt(turns, settings.systemPrompt);

    let lastEmit = 0;
    try {
      const provider = this.bridge.provider(target);
      const result = await provider.send({
        prompt: chatUrl ? text : contextPrompt,
        fallbackPrompt: contextPrompt,
        chatUrl,
        attachments,
        model: target === 'chatgpt' && !chatUrl ? settings.chatgptModel || undefined : undefined,
        signal,
        onUpdate: (content) => {
          msg.content = content;
          const now = Date.now();
          if (now - lastEmit >= UPDATE_INTERVAL_MS) {
            lastEmit = now;
            this.emit('message', { conversationId: conv.id, message: { ...msg } });
          }
        },
      });
      msg.content = result.text;
      msg.status = result.aborted ? 'stopped' : 'done';
      if (result.chatUrl) this.bridge.history.setProviderChat(conv.id, target, result.chatUrl);
    } catch (e) {
      const err = BridgeError.from(e);
      if (err.code === 'aborted') {
        msg.status = 'stopped';
      } else {
        msg.status = 'error';
        msg.error = err.message;
      }
      if (err.partial) msg.content = err.partial;
    }
    this.patch(conv.id, msg);
  }

  private patch(conversationId: string, message: ChatMessage): void {
    this.bridge.history.upsertMessage(conversationId, message);
    this.emit('message', { conversationId, message: { ...message } });
  }
}
