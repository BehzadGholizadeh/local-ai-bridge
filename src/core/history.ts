import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, Conversation, ConversationSummary, ProviderId } from '../shared/types';
import { writeJsonAtomic } from './fsutil';

interface HistoryFile {
  version: 1;
  conversations: Conversation[];
}

/** Local conversation history in history.json. Writes are debounced; call flush() on exit. */
export class HistoryStore {
  private data: HistoryFile = { version: 1, conversations: [] };
  private timer?: NodeJS.Timeout;

  constructor(private file: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as HistoryFile;
      if (Array.isArray(parsed.conversations)) this.data = parsed;
    } catch {
      // first run
    }
    // Replies that were streaming when the app quit can never finish.
    for (const c of this.data.conversations) {
      for (const m of c.messages) if (m.status === 'streaming') m.status = 'stopped';
    }
  }

  list(): ConversationSummary[] {
    return [...this.data.conversations]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, title, updatedAt, targets }) => ({ id, title, updatedAt, targets }));
  }

  get(id: string): Conversation | undefined {
    return this.data.conversations.find((c) => c.id === id);
  }

  create(firstText: string, targets: ProviderId[]): Conversation {
    const now = Date.now();
    const title = firstText.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
    const conv: Conversation = {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      targets,
      providerChats: {},
      messages: [],
    };
    this.data.conversations.push(conv);
    this.save();
    return conv;
  }

  newMessage(partial: Omit<ChatMessage, 'id' | 'createdAt'>): ChatMessage {
    return { id: randomUUID(), createdAt: Date.now(), ...partial };
  }

  /** Inserts or replaces a message (matched by id). */
  upsertMessage(convId: string, msg: ChatMessage): void {
    const conv = this.get(convId);
    if (!conv) return;
    const i = conv.messages.findIndex((m) => m.id === msg.id);
    if (i >= 0) conv.messages[i] = { ...msg };
    else conv.messages.push({ ...msg });
    conv.updatedAt = Date.now();
    this.save();
  }

  setProviderChat(convId: string, provider: ProviderId, url: string): void {
    const conv = this.get(convId);
    if (!conv) return;
    conv.providerChats[provider] = url;
    if (!conv.targets.includes(provider)) conv.targets.push(provider);
    this.save();
  }

  rename(id: string, title: string): void {
    const conv = this.get(id);
    if (!conv) return;
    conv.title = title.trim().slice(0, 120) || conv.title;
    this.save();
  }

  delete(id: string): void {
    this.data.conversations = this.data.conversations.filter((c) => c.id !== id);
    this.save();
  }

  private save(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    writeJsonAtomic(this.file, this.data);
  }
}
