import { useState } from 'react';
import { PROVIDER_NAMES, type ConversationSummary } from '../../../shared/types';

interface Props {
  conversations: ConversationSummary[];
  currentId: string | null;
  view: 'chat' | 'settings' | 'agent';
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onSettings: () => void;
  onAgent: () => void;
}

export function Sidebar({ conversations, currentId, view, onOpen, onNew, onDelete, onRename, onSettings, onAgent }: Props) {
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const shown = conversations.filter((c) => c.title.toLowerCase().includes(filter.toLowerCase()));

  const commit = (id: string) => {
    if (draft.trim()) onRename(id, draft);
    setEditing(null);
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo">⇄</span> Local AI Bridge
      </div>
      <button className={`block ${view === 'agent' ? 'active' : ''}`} onClick={onAgent} title="Give a task to the local agent">
        ⚙︎ Agent
      </button>
      <button className="primary block" onClick={onNew}>
        + New chat
      </button>
      <input className="search" placeholder="Search chats" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <nav className="conv-list">
        {shown.length === 0 && <div className="muted small-text">No conversations yet.</div>}
        {shown.map((c) => (
          <div
            key={c.id}
            className={`conv ${c.id === currentId && view === 'chat' ? 'active' : ''}`}
            onClick={() => onOpen(c.id)}
            onDoubleClick={() => {
              setEditing(c.id);
              setDraft(c.title);
            }}
            title="Double-click to rename"
          >
            {editing === c.id ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commit(c.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit(c.id);
                  if (e.key === 'Escape') setEditing(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <>
                <div className="conv-title">{c.title}</div>
                <div className="conv-meta">{c.targets.map((t) => PROVIDER_NAMES[t]).join(' + ')}</div>
                <button
                  className="ghost conv-del"
                  aria-label="Delete conversation"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete "${c.title}" from local history?`)) onDelete(c.id);
                  }}
                >
                  ×
                </button>
              </>
            )}
          </div>
        ))}
      </nav>
      <button className={`block ${view === 'settings' ? 'active' : ''}`} onClick={onSettings}>
        ⚙ Settings
      </button>
    </aside>
  );
}
