import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, Conversation, ConversationSummary, MessagePatch, ProviderId, SendAttachment } from '../../shared/types';
import { AgentView } from './components/AgentView';
import { ChatView } from './components/ChatView';
import { ProviderBar } from './components/ProviderBar';
import { SettingsView } from './components/SettingsView';
import { Sidebar } from './components/Sidebar';

const api = window.bridge;

function applyPatch(conv: Conversation, p: MessagePatch): Conversation {
  if (conv.id !== p.conversationId) return conv;
  const i = conv.messages.findIndex((m) => m.id === p.message.id);
  const messages = [...conv.messages];
  if (i >= 0) messages[i] = p.message;
  else messages.push(p.message);
  return { ...conv, messages };
}

function useResolvedTheme(theme: AppState['settings']['theme'] | undefined): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme !== 'light' && media.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [current, setCurrent] = useState<Conversation | null>(null);
  const [view, setView] = useState<'chat' | 'settings' | 'agent'>('chat');
  const [error, setError] = useState<string | null>(null);
  const currentId = useRef<string | null>(null);

  const refreshList = useCallback(() => {
    void api.listConversations().then(setConversations);
  }, []);

  useEffect(() => {
    void api.getState().then(setState);
    refreshList();
    const offs = [
      api.onStatus((s) => setState((st) => st && { ...st, statuses: st.statuses.map((x) => (x.id === s.id ? s : x)) })),
      api.onSettings((settings) => setState((st) => st && { ...st, settings })),
      api.onApi((a) => setState((st) => st && { ...st, api: a })),
      api.onHistoryChanged(refreshList),
      api.onMessage((p) => {
        if (p.conversationId === currentId.current) setCurrent((c) => c && applyPatch(c, p));
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [refreshList]);

  useResolvedTheme(state?.settings.theme);

  const openConversation = useCallback(async (id: string | null) => {
    currentId.current = id;
    setView('chat');
    setCurrent(id ? await api.getConversation(id) : null);
  }, []);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const sendMessage = useCallback(
    (text: string, targets: ProviderId[], attachments: SendAttachment[]) =>
      run(async () => {
        const { conversationId } = await api.send({ conversationId: current?.id, text, targets, attachments });
        if (conversationId !== currentId.current) {
          currentId.current = conversationId;
        }
        setCurrent(await api.getConversation(conversationId));
        refreshList();
      }),
    [current?.id, refreshList, run],
  );

  if (!state) return <div className="loading">Starting…</div>;

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        currentId={current?.id ?? null}
        view={view}
        onOpen={(id) => void openConversation(id)}
        onNew={() => void openConversation(null)}
        onDelete={(id) =>
          run(async () => {
            await api.deleteConversation(id);
            if (id === currentId.current) await openConversation(null);
          })
        }
        onRename={(id, title) => run(() => api.renameConversation(id, title))}
        onSettings={() => setView(view === 'settings' ? 'chat' : 'settings')}
        onAgent={() => setView(view === 'agent' ? 'chat' : 'agent')}
      />
      <main className="main">
        <ProviderBar
          statuses={state.statuses}
          settings={state.settings}
          api={state.api}
          onAction={(id, action) => run(() => api.providerAction(id, action))}
          onTheme={(theme) => run(() => api.updateSettings({ theme }))}
        />
        {error && (
          <div className="banner error" role="alert">
            <span>{error}</span>
            <button className="ghost" onClick={() => setError(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {/* Kept mounted so a running task and its log survive switching views. */}
        <AgentView hidden={view !== 'agent'} settings={state.settings} onError={setError} />
        {view === 'agent' ? null : view === 'settings' ? (
          <SettingsView state={state} onSave={(patch) => run(() => api.updateSettings(patch))} onError={setError} />
        ) : (
          <ChatView
            conversation={current}
            settings={state.settings}
            statuses={state.statuses}
            apiUrl={state.api.url}
            onSend={sendMessage}
            onError={setError}
            onStop={() => current && run(() => api.stop(current.id))}
            onTargetsChange={(defaultTargets) => run(() => api.updateSettings({ defaultTargets }))}
          />
        )}
      </main>
    </div>
  );
}
