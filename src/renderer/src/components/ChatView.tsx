import { useEffect, useRef, useState } from 'react';
import {
  PROVIDER_IDS,
  PROVIDER_NAMES,
  type ChatMessage,
  type Conversation,
  type ProviderId,
  type ProviderStatus,
  type SendAttachment,
  type Settings,
} from '../../../shared/types';
import { Markdown } from './Markdown';

// Matches the bridge's limits (src/core/attachments.ts).
const MAX_FILES = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const formatSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

interface Props {
  conversation: Conversation | null;
  settings: Settings;
  statuses: ProviderStatus[];
  apiUrl: string;
  onSend: (text: string, targets: ProviderId[], attachments: SendAttachment[]) => Promise<void>;
  onError: (message: string) => void;
  onStop: () => void;
  onTargetsChange: (targets: ProviderId[]) => void;
  /** Moves the text to the Agent view (Chat has no access to this computer). */
  onRunAsAgent: (text: string) => void;
}

/**
 * Messages that ask for something on this computer (files, folders, drives, programs). Chat only
 * talks to ChatGPT/Grok, which answer from their own sandbox, so these belong in the Agent.
 */
export function looksLikeComputerTask(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b[a-z]:[\\/]|\bdrive\s+["']?[a-z]["']?(?=$|[\s:.,!?])|(^|\s)["']?[a-z]:?["']?\s+drive\b/.test(t) ||
    /\b(my|this|the)\s+(desktop|computer|pc|laptop|disk|drive|downloads|documents)\b/.test(t) ||
    /\b(list|show|open|read|edit|rename|delete|move|copy|create|find|search|run|execute|install)\b[^.?!]{0,40}\b(files?|folders?|director(y|ies)|drive|workspace|\.(txt|md|py|csv|xlsx|docx|pptx|pdf))\b/.test(t)
  );
}

interface Turn {
  user: ChatMessage;
  replies: ChatMessage[];
}

function toTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === 'user') turns.push({ user: m, replies: [] });
    else turns[turns.length - 1]?.replies.push(m);
  }
  return turns;
}

export function ChatView({
  conversation,
  settings,
  statuses,
  apiUrl,
  onSend,
  onError,
  onStop,
  onTargetsChange,
  onRunAsAgent,
}: Props) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const enabled = PROVIDER_IDS.filter((id) => settings.enabledProviders[id]);
  const targets = settings.defaultTargets.filter((t) => enabled.includes(t));
  const busy = !!conversation?.messages.some((m) => m.status === 'streaming');
  const turns = conversation ? toTurns(conversation.messages) : [];

  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [conversation]);

  const toggle = (id: ProviderId) => {
    const next = targets.includes(id) ? targets.filter((t) => t !== id) : [...targets, id];
    if (next.length) onTargetsChange(next);
  };

  const addFiles = (list: FileList | File[] | null) => {
    const picked = Array.from(list ?? []);
    const tooBig = picked.filter((f) => f.size > MAX_FILE_BYTES);
    if (tooBig.length) onError(`Too large (max 25 MB): ${tooBig.map((f) => f.name).join(', ')}`);
    const next = [...files, ...picked.filter((f) => f.size <= MAX_FILE_BYTES && f.size > 0)];
    if (next.length > MAX_FILES) onError(`At most ${MAX_FILES} attachments per message.`);
    setFiles(next.slice(0, MAX_FILES));
  };

  const canSend = (!!text.trim() || files.length > 0) && !sending && targets.length > 0;

  const submit = async () => {
    if (!canSend || busy) return;
    setSending(true);
    stickToBottom.current = true;
    const value = text;
    const picked = files;
    setText('');
    setFiles([]);
    try {
      const attachments = await Promise.all(
        picked.map(async (f) => ({ name: f.name || 'pasted-image.png', mimeType: f.type, data: new Uint8Array(await f.arrayBuffer()) })),
      );
      await onSend(value, targets, attachments);
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="chat">
      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {turns.length === 0 ? (
          <Welcome statuses={statuses} apiUrl={apiUrl} />
        ) : (
          turns.map((t) => (
            <div className="turn" key={t.user.id}>
              <div className="user-msg">
                {t.user.content}
                {!!t.user.attachments?.length && (
                  <div className="attachments">
                    {t.user.attachments.map((a, i) => (
                      <span key={i} className="attachment" title={`${a.mimeType}, ${formatSize(a.size)}`}>
                        {a.mimeType.startsWith('image/') ? '🖼' : '📄'} {a.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className={`replies cols-${Math.min(t.replies.length, 2)}`}>
                {t.replies.map((r) => (
                  <Reply key={r.id} msg={r} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div
        className={`composer ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        {looksLikeComputerTask(text) && (
          <div className="agent-hint" role="note">
            <span>
              <strong>This looks like a task on your computer.</strong> Chat only talks to ChatGPT/Grok, which can't see your files
              or drives (they answer from their own sandbox). The Agent can.
            </span>
            <button
              className="primary small"
              onClick={() => {
                onRunAsAgent(text);
                setText('');
              }}
            >
              Run as agent task →
            </button>
          </div>
        )}
        <div className="targets">
          {enabled.map((id) => (
            <button
              key={id}
              className={`chip ${targets.includes(id) ? 'on' : ''}`}
              onClick={() => toggle(id)}
              title={`Send to ${PROVIDER_NAMES[id]}`}
            >
              {targets.includes(id) ? '✓ ' : ''}
              {PROVIDER_NAMES[id]}
            </button>
          ))}
          {settings.chatgptModel && targets.includes('chatgpt') && !conversation?.providerChats.chatgpt && (
            <span className="muted small-text">ChatGPT model: {settings.chatgptModel}</span>
          )}
        </div>
        {files.length > 0 && (
          <div className="attachments pending">
            {files.map((f, i) => (
              <span key={i} className="attachment" title={`${f.type || 'file'}, ${formatSize(f.size)}`}>
                {f.type.startsWith('image/') ? '🖼' : '📄'} {f.name || 'pasted image'}
                <button
                  className="ghost small"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles(files.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-row">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button className="attach" title="Attach files or images (or paste / drop them here)" onClick={() => fileInput.current?.click()}>
            📎
          </button>
          <textarea
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                addFiles(e.clipboardData.files);
              }
            }}
            value={text}
            placeholder={targets.length > 1 ? 'Message both models…' : `Message ${PROVIDER_NAMES[targets[0] ?? 'chatgpt']}…`}
            rows={Math.min(10, Math.max(2, text.split('\n').length))}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {busy ? (
            <button className="danger" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button className="primary" onClick={() => void submit()} disabled={!canSend}>
              Send
            </button>
          )}
        </div>
        <div className="hint muted small-text">
          Enter to send · Shift+Enter for a new line · 📎, paste or drop to attach (signed-out ChatGPT accepts images only)
        </div>
      </div>
    </section>
  );
}

function Reply({ msg }: { msg: ChatMessage }) {
  const name = msg.provider ? PROVIDER_NAMES[msg.provider] : 'Assistant';
  return (
    <article className={`reply status-${msg.status ?? 'done'}`}>
      <header>
        <span className={`badge ${msg.provider ?? ''}`}>{name}</span>
        {msg.status === 'streaming' && <span className="typing">answering…</span>}
        {msg.status === 'stopped' && <span className="muted small-text">stopped</span>}
        {msg.content && (
          <button className="small ghost" onClick={() => void window.bridge.copy(msg.content)}>
            Copy
          </button>
        )}
      </header>
      {msg.content ? <Markdown text={msg.content} /> : msg.status === 'streaming' ? <div className="skeleton" /> : null}
      {msg.error && <div className="reply-error">{msg.error}</div>}
    </article>
  );
}

function Welcome({ statuses, apiUrl }: { statuses: ProviderStatus[]; apiUrl: string }) {
  const needsLogin = statuses.filter((s) => s.state !== 'ready' && s.state !== 'busy');
  return (
    <div className="welcome">
      <h1>Chat with ChatGPT and Grok, side by side</h1>
      <p className="muted">
        Messages go through your own signed-in browser sessions. Nothing is sent anywhere except chatgpt.com and grok.com.
      </p>
      {needsLogin.length > 0 && (
        <div className="card">
          <strong>First time?</strong> Click <em>Log in</em> next to {needsLogin.map((s) => s.name).join(' and ')} at the top,
          sign in in the browser window that opens, then come back here.
        </div>
      )}
      <div className="card">
        <strong>Chat vs Agent.</strong> Chat is a normal conversation: ChatGPT and Grok can't see or change anything on this
        computer here. To work with your files, folders or drives, use <strong>Agent</strong> in the sidebar.
      </div>
      <div className="card">
        <strong>Use it from other tools.</strong> Point any OpenAI-compatible client at <code>{apiUrl}</code> with model{' '}
        <code>chatgpt</code> or <code>grok</code> (any API key unless you set one in Settings).
      </div>
    </div>
  );
}
