// Types shared between the core (Node/Electron main) and the renderer (React).

export type ProviderId = 'chatgpt' | 'grok';
export const PROVIDER_IDS: ProviderId[] = ['chatgpt', 'grok'];
export const PROVIDER_NAMES: Record<ProviderId, string> = { chatgpt: 'ChatGPT', grok: 'Grok' };

export type ProviderState =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'logged_out'
  | 'challenge'
  | 'rate_limited'
  | 'error';

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  state: ProviderState;
  /** Human readable explanation, shown in the status bar. */
  detail?: string;
  /** True when the site is usable but not signed in (guest mode). */
  guest?: boolean;
  updatedAt: number;
}

export type ProviderAction = 'login' | 'show' | 'hide' | 'restart' | 'stop' | 'check';

export type Theme = 'system' | 'light' | 'dark';
export type BrowserChannel = 'auto' | 'chrome' | 'msedge' | 'chromium';

export interface Settings {
  port: number;
  /** Extra port for Ollama clients (Ollama's default is 11434). 0 = off; /api/* is always on `port`. */
  ollamaPort: number;
  /** Optional bearer token required by the local API. Empty = no auth. */
  apiKey: string;
  /** Browser origins allowed to call the API (CORS). Empty = no browser origins. */
  corsOrigins: string[];
  /** Prepended to the first message of every new chat (app and API). */
  systemPrompt: string;
  theme: Theme;
  browserChannel: BrowserChannel;
  /** Keep the automated browser windows visible instead of minimized. */
  showBrowsers: boolean;
  autoStartBrowsers: boolean;
  startOnBoot: boolean;
  minimizeToTray: boolean;
  responseTimeoutSec: number;
  enabledProviders: Record<ProviderId, boolean>;
  defaultTargets: ProviderId[];
  /** ChatGPT model slug applied to new chats, e.g. "gpt-4o". Empty = site default. */
  chatgptModel: string;
}

export type MessageStatus = 'streaming' | 'done' | 'error' | 'stopped';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  provider?: ProviderId;
  content: string;
  createdAt: number;
  status?: MessageStatus;
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  targets: ProviderId[];
  /** URL of the matching web conversation per provider, so follow-ups continue there. */
  providerChats: Partial<Record<ProviderId, string>>;
  messages: ChatMessage[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  targets: ProviderId[];
}

export interface ApiInfo {
  url: string;
  /** Base URL for Ollama clients. */
  ollamaUrl: string;
  running: boolean;
  error?: string;
}

export interface AppState {
  settings: Settings;
  statuses: ProviderStatus[];
  api: ApiInfo;
  version: string;
  dataDir: string;
  selectorsDir: string;
}

export interface SendInput {
  conversationId?: string;
  text: string;
  targets: ProviderId[];
}

export interface MessagePatch {
  conversationId: string;
  message: ChatMessage;
}

export interface LogEntry {
  t: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

/** API exposed to the renderer through the preload script (window.bridge). */
export interface BridgeApi {
  getState(): Promise<AppState>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  providerAction(id: ProviderId, action: ProviderAction): Promise<void>;
  listConversations(): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<Conversation | null>;
  deleteConversation(id: string): Promise<void>;
  renameConversation(id: string, title: string): Promise<void>;
  send(input: SendInput): Promise<{ conversationId: string }>;
  stop(conversationId: string): Promise<void>;
  openPath(which: 'data' | 'selectors'): Promise<void>;
  reloadSelectors(): Promise<void>;
  copy(text: string): Promise<void>;
  getLogs(): Promise<LogEntry[]>;
  onStatus(cb: (s: ProviderStatus) => void): () => void;
  onSettings(cb: (s: Settings) => void): () => void;
  onApi(cb: (a: ApiInfo) => void): () => void;
  onMessage(cb: (p: MessagePatch) => void): () => void;
  onHistoryChanged(cb: () => void): () => void;
}
