import { useEffect, useRef, useState } from 'react';
import {
  PROVIDER_IDS,
  PROVIDER_NAMES,
  type ChatMessage,
  type Conversation,
  type ProviderId,
  type ProviderStatus,
  type Settings,
} from '../../../shared/types';
import { Markdown } from './Markdown';

interface Props {
  conversation: Conversation | null;
  settings: Settings;
  statuses: ProviderStatus[];
  apiUrl: string;
  onSend: (text: string, targets: ProviderId[]) => Promise<void>;
  onStop: () => void;
  onTargetsChange: (targets: ProviderId[]) => void;
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

export function ChatView({ conversation, settings, statuses, apiUrl, onSend, onStop, onTargetsChange }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
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

  const submit = async () => {
    if (!text.trim() || busy || sending || !targets.length) return;
    setSending(true);
    stickToBottom.current = true;
    const value = text;
    setText('');
    try {
      await onSend(value, targets);
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
              <div className="user-msg">{t.user.content}</div>
              <div className={`replies cols-${Math.min(t.replies.length, 2)}`}>
                {t.replies.map((r) => (
                  <Reply key={r.id} msg={r} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="composer">
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
        <div className="composer-row">
          <textarea
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
            <button className="primary" onClick={() => void submit()} disabled={!text.trim() || sending || !targets.length}>
              Send
            </button>
          )}
        </div>
        <div className="hint muted small-text">Enter to send · Shift+Enter for a new line</div>
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
        <strong>Use it from other tools.</strong> Point any OpenAI-compatible client at <code>{apiUrl}</code> with model{' '}
        <code>chatgpt</code> or <code>grok</code> (any API key unless you set one in Settings).
      </div>
    </div>
  );
}
