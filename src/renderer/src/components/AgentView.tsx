import { useEffect, useRef, useState } from 'react';
import {
  PROVIDER_IDS,
  PROVIDER_NAMES,
  type AgentDecision,
  type AgentMode,
  type AgentUiEvent,
  type ProviderId,
  type Settings,
} from '../../../shared/types';
import { Markdown } from './Markdown';

type Item =
  | { kind: 'task'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; tool: string; summary: string; status: 'running' | 'ok' | 'failed' | 'denied'; output?: string }
  | {
      kind: 'approval';
      requestId: string;
      tool: string;
      summary: string;
      args: Record<string, unknown>;
      outside: boolean;
      decision?: AgentDecision;
    }
  | { kind: 'done'; answer: string; steps: number }
  | { kind: 'error'; message: string }
  | { kind: 'note'; text: string };

interface Thinking {
  step: number;
  chars: number;
  phase: string;
  since: number;
}

/** What the user sees while the agent waits on the browser: never just a spinner. */
function phaseLabel(t: Thinking, name: string): string {
  switch (t.phase) {
    case 'starting':
      return 'Starting…';
    case 'queued':
      return `Waiting for ${name} to finish another request…`;
    case 'opening':
      return `Opening ${name}…`;
    case 'uploading':
      return 'Uploading files…';
    case 'typing':
      return `Typing the message into ${name}…`;
    case 'sending':
      return `Sending to ${name}…`;
    case 'waiting':
      return `Waiting for ${name}'s reply…`;
    case 'writing':
      return `${name} is writing${t.chars ? ` (${t.chars} chars)` : ''}…`;
    default:
      return `${name} is working…`;
  }
}

const MODE_HELP: Record<AgentMode, string> = {
  ask: 'Asks before writes, edits, shell commands and anything outside the workspace.',
  'auto-edit': 'Writes and edits inside the workspace run without asking; shell commands still ask.',
  'full-auto': 'Nothing asks. Only use with tasks and folders you trust.',
};

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(`agent.${k}`);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(`agent.${k}`, v);
    } catch {
      // storage unavailable: settings just aren't remembered
    }
  },
};

function reduce(items: Item[], e: AgentUiEvent): Item[] {
  switch (e.type) {
    case 'task':
      return [...items, { kind: 'task', text: e.text }];
    case 'assistant':
      return [...items, { kind: 'assistant', text: e.text }];
    case 'tool_call':
      return [...items, { kind: 'tool', id: e.id, tool: e.tool, summary: e.summary, status: 'running' }];
    case 'tool_result':
      return items.map((it) =>
        it.kind === 'tool' && it.id === e.id
          ? { ...it, status: e.denied ? 'denied' : e.ok ? 'ok' : 'failed', output: e.denied ? undefined : e.output }
          : it,
      );
    case 'approval':
      return [
        ...items,
        { kind: 'approval', requestId: e.requestId, tool: e.tool, summary: e.summary, args: e.args, outside: e.outside },
      ];
    case 'approval_resolved':
      return items.map((it) => (it.kind === 'approval' && it.requestId === e.requestId ? { ...it, decision: e.decision } : it));
    case 'done':
      return [...items, { kind: 'done', answer: e.answer, steps: e.steps }];
    case 'error':
      return [...items, { kind: 'error', message: e.message }];
    case 'stopped':
      return [...items, { kind: 'note', text: 'Stopped.' }];
    default:
      return items;
  }
}

interface Props {
  hidden: boolean;
  settings: Settings;
  onError: (message: string) => void;
}

export function AgentView({ hidden, settings, onError }: Props) {
  const enabled = PROVIDER_IDS.filter((id) => settings.enabledProviders[id]);
  const [workspace, setWorkspace] = useState(store.get('workspace') ?? '');
  const [provider, setProvider] = useState<ProviderId>((store.get('provider') as ProviderId) || 'chatgpt');
  const [mode, setMode] = useState<AgentMode>((store.get('mode') as AgentMode) || 'ask');
  const [task, setTask] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [thinking, setThinking] = useState<Thinking | null>(null);
  const [, setTick] = useState(0);
  const sessionId = useRef<string | null>(null);
  const awaitingSession = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!workspace) void window.bridge.agentDefaults().then((d) => setWorkspace(d.workspace));
  }, [workspace]);

  useEffect(
    () =>
      window.bridge.onAgentEvent(({ sessionId: sid, event }) => {
        if (awaitingSession.current && !sessionId.current) {
          sessionId.current = sid;
          awaitingSession.current = false;
        }
        if (sid !== sessionId.current) return;
        if (event.type === 'thinking') setThinking({ step: event.step, chars: 0, phase: 'opening', since: Date.now() });
        else if (event.type === 'progress') setThinking((t) => (t ? { ...t, chars: event.chars, phase: 'writing' } : t));
        else if (event.type === 'phase') setThinking((t) => (t ? { ...t, phase: event.phase } : t));
        else if (event.type === 'idle') {
          setRunning(false);
          setThinking(null);
        } else {
          if (event.type !== 'approval_resolved') setThinking(null);
          setItems((list) => reduce(list, event));
        }
      }),
    [],
  );

  // Tick once a second while waiting, so the elapsed time keeps moving.
  useEffect(() => {
    if (!thinking) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [thinking]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, thinking]);

  const remember = (k: string, v: string) => store.set(k, v);

  const run = async () => {
    const text = task.trim();
    if (!text || running) return;
    if (mode === 'full-auto' && !confirm('Full-auto runs every tool, including shell commands, without asking. Continue?')) return;
    setRunning(true);
    setThinking({ step: 1, chars: 0, phase: 'starting', since: Date.now() });
    setTask('');
    if (!sessionId.current) awaitingSession.current = true;
    try {
      const { sessionId: sid } = await window.bridge.agentStart({
        sessionId: sessionId.current ?? undefined,
        workspace,
        provider,
        mode,
        task: text,
      });
      if (sid !== sessionId.current) {
        // A new session (first task, or the workspace / brain changed).
        if (sessionId.current) setItems([]);
        sessionId.current = sid;
      }
      awaitingSession.current = false;
    } catch (e) {
      awaitingSession.current = false;
      setRunning(false);
      setThinking(null);
      setTask(text);
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const newSession = () => {
    if (running && sessionId.current) void window.bridge.agentStop(sessionId.current);
    sessionId.current = null;
    setItems([]);
    setThinking(null);
  };

  const decide = (requestId: string, decision: AgentDecision) => void window.bridge.agentApprove(requestId, decision);

  return (
    <section className="agent" hidden={hidden}>
      <div className="agent-config">
        <label className="field grow">
          <span>Workspace</span>
          <div className="inline">
            <code className="path" title={workspace}>
              {workspace || '…'}
            </code>
            <button
              className="small"
              disabled={running}
              onClick={async () => {
                const picked = await window.bridge.agentPickFolder(workspace);
                if (picked) {
                  setWorkspace(picked);
                  remember('workspace', picked);
                }
              }}
            >
              Choose…
            </button>
          </div>
        </label>
        <label className="field">
          <span>Brain</span>
          <select
            value={provider}
            disabled={running}
            onChange={(e) => {
              setProvider(e.target.value as ProviderId);
              remember('provider', e.target.value);
            }}
          >
            {enabled.map((id) => (
              <option key={id} value={id}>
                {PROVIDER_NAMES[id]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Permissions</span>
          <select
            value={mode}
            onChange={(e) => {
              const m = e.target.value as AgentMode;
              setMode(m);
              remember('mode', m);
              if (sessionId.current) void window.bridge.agentSetMode(sessionId.current, m);
            }}
            title={MODE_HELP[mode]}
          >
            <option value="ask">Ask before changes</option>
            <option value="auto-edit">Auto-edit files</option>
            <option value="full-auto">Full auto</option>
          </select>
        </label>
        <button className="small" onClick={newSession} title="Start a fresh conversation">
          New session
        </button>
      </div>
      <div className={`muted small-text agent-mode-help ${mode === 'full-auto' ? 'warn' : ''}`}>{MODE_HELP[mode]}</div>

      <div className="agent-log" ref={scroller}>
        {items.length === 0 && (
          <div className="welcome">
            <h1>Give the agent a task</h1>
            <p className="muted">
              {PROVIDER_NAMES[provider]} plans the steps; the tools run on this computer: read, write and edit files, list folders,
              search, and run shell commands. You approve changes as they come.
            </p>
            <div className="card">
              Examples: “Summarize the README in this folder”, “Rename all .jpeg files here to .jpg”, “Open report.pptx on my
              Desktop and change the title of the first slide to ‘Q3 Review’”.
            </div>
          </div>
        )}
        {items.map((it, i) => (
          <AgentItem key={i} item={it} onDecide={decide} />
        ))}
        {thinking && (
          <div className="agent-thinking" role="status">
            <span className="dot-pulse" /> {phaseLabel(thinking, PROVIDER_NAMES[provider])}
            <span className="muted">
              {' '}
              · step {thinking.step} · {Math.max(0, Math.round((Date.now() - thinking.since) / 1000))}s
            </span>
          </div>
        )}
      </div>

      <div className="composer">
        <div className="composer-row">
          <textarea
            value={task}
            placeholder={sessionId.current ? 'Follow-up task (same session)…' : 'Describe a task…'}
            rows={Math.min(8, Math.max(2, task.split('\n').length))}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void run();
              }
            }}
          />
          {running ? (
            <button className="danger" onClick={() => sessionId.current && void window.bridge.agentStop(sessionId.current)}>
              Stop
            </button>
          ) : (
            <button className="primary" onClick={() => void run()} disabled={!task.trim() || !workspace}>
              Run
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function ApprovalPreview({ tool, args }: { tool: string; args: Record<string, unknown> }) {
  if (tool === 'write_file') return <pre className="agent-pre">{String(args.content ?? '').slice(0, 4000)}</pre>;
  if (tool === 'edit_file') {
    return (
      <pre className="agent-pre">
        {String(args.old_string ?? '')
          .split('\n')
          .map((l, i) => (
            <div key={`o${i}`} className="diff-del">
              - {l}
            </div>
          ))}
        {String(args.new_string ?? '')
          .split('\n')
          .map((l, i) => (
            <div key={`n${i}`} className="diff-add">
              + {l}
            </div>
          ))}
      </pre>
    );
  }
  return null;
}

function AgentItem({ item, onDecide }: { item: Item; onDecide: (id: string, d: AgentDecision) => void }) {
  switch (item.kind) {
    case 'task':
      return <div className="user-msg agent-task">{item.text}</div>;
    case 'assistant':
      return (
        <div className="agent-assistant">
          <Markdown text={item.text} />
        </div>
      );
    case 'tool': {
      const icon = { running: '◌', ok: '✓', failed: '✗', denied: '⊘' }[item.status];
      return (
        <details className={`agent-tool ${item.status}`} open={item.status === 'failed'}>
          <summary>
            <span className="agent-tool-icon">{icon}</span> <strong>{item.tool}</strong> <span className="muted">{item.summary}</span>
            {item.status === 'denied' && <span className="muted"> (denied)</span>}
          </summary>
          {item.output && <pre className="agent-pre">{item.output}</pre>}
        </details>
      );
    }
    case 'approval':
      return (
        <div className={`agent-approval ${item.decision ? 'resolved' : ''}`}>
          <div>
            <strong>Allow {item.tool}?</strong> <span className="muted">{item.summary}</span>
            {item.outside && <span className="warn-text"> · outside the workspace</span>}
          </div>
          <ApprovalPreview tool={item.tool} args={item.args} />
          {item.decision ? (
            <div className="muted small-text">
              {item.decision === 'deny' ? 'Denied' : item.decision === 'always' ? `Allowed (always ${item.tool} this session)` : 'Allowed once'}
            </div>
          ) : (
            <div className="inline">
              <button className="primary small" onClick={() => onDecide(item.requestId, 'allow')}>
                Allow
              </button>
              <button className="small" onClick={() => onDecide(item.requestId, 'always')}>
                Always allow {item.tool}
              </button>
              <button className="small danger" onClick={() => onDecide(item.requestId, 'deny')}>
                Deny
              </button>
            </div>
          )}
        </div>
      );
    case 'done':
      return (
        <div className="agent-done">
          <div className="small-text muted">
            ✔ Done in {item.steps} step{item.steps === 1 ? '' : 's'}
          </div>
          <Markdown text={item.answer} />
        </div>
      );
    case 'error':
      return <div className="reply-error">{item.message}</div>;
    case 'note':
      return <div className="muted small-text">{item.text}</div>;
  }
}
