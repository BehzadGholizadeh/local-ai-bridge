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

/** What history keeps about an attachment (not its contents). */
export interface AttachmentInfo {
  name: string;
  mimeType: string;
  size: number;
}

/** A file picked in the app, sent over IPC. */
export interface SendAttachment {
  name: string;
  mimeType: string;
  data: Uint8Array;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  provider?: ProviderId;
  content: string;
  attachments?: AttachmentInfo[];
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
  attachments?: SendAttachment[];
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

// ---------------------------------------------------------------- agent

export type AgentMode = 'ask' | 'auto-edit' | 'full-auto';
export type AgentDecision = 'allow' | 'deny' | 'always';

/** Agent activity as shown in the app (mirrors the core AgentEvent, plus approvals). */
export type AgentUiEvent =
  | { type: 'task'; text: string }
  | { type: 'thinking'; step: number }
  | { type: 'progress'; chars: number }
  /** Where the current message to the model is: queued, opening, typing, uploading, sending, waiting, writing. */
  | { type: 'phase'; phase: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool_call'; id: string; tool: string; args: Record<string, unknown>; summary: string }
  | { type: 'tool_result'; id: string; tool: string; ok: boolean; output: string; denied?: boolean; executed: boolean }
  | {
      type: 'approval';
      requestId: string;
      tool: string;
      summary: string;
      args: Record<string, unknown>;
      outside: boolean;
    }
  | { type: 'approval_resolved'; requestId: string; decision: AgentDecision }
  | { type: 'done'; answer: string; steps: number; toolRuns: number; grounded: boolean }
  | { type: 'note'; text: string }
  | { type: 'error'; message: string }
  | { type: 'stopped' }
  /** The run ended (after done / error / stopped); the session can take a follow-up task. */
  | { type: 'idle' };

export interface AgentStartInput {
  /** Continue this session (same web conversation) if workspace and provider are unchanged. */
  sessionId?: string;
  workspace: string;
  provider: ProviderId;
  mode: AgentMode;
  task: string;
}

export interface AgentEventPatch {
  sessionId: string;
  event: AgentUiEvent;
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
  agentDefaults(): Promise<{ workspace: string }>;
  agentPickFolder(current?: string): Promise<string | null>;
  agentStart(input: AgentStartInput): Promise<{ sessionId: string }>;
  agentStop(sessionId: string): Promise<void>;
  agentApprove(requestId: string, decision: AgentDecision): Promise<void>;
  agentSetMode(sessionId: string, mode: AgentMode): Promise<void>;
  onAgentEvent(cb: (p: AgentEventPatch) => void): () => void;
}
