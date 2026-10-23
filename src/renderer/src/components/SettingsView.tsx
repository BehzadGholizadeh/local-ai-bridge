import { useEffect, useState } from 'react';
import { PROVIDER_IDS, PROVIDER_NAMES, type AppState, type LogEntry, type Settings } from '../../../shared/types';

interface Props {
  state: AppState;
  onSave: (patch: Partial<Settings>) => Promise<void>;
  onError: (msg: string) => void;
}

function newKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `lab-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function SettingsView({ state, onSave, onError }: Props) {
  const [draft, setDraft] = useState<Settings>(state.settings);
  const [origins, setOrigins] = useState(state.settings.corsOrigins.join(', '));
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(state.settings);
    setOrigins(state.settings.corsOrigins.join(', '));
  }, [state.settings]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const dirty =
    JSON.stringify({ ...draft, corsOrigins: [] }) !== JSON.stringify({ ...state.settings, corsOrigins: [] }) ||
    origins !== state.settings.corsOrigins.join(', ');

  const save = async () => {
    const corsOrigins = origins.split(',').map((o) => o.trim()).filter(Boolean);
    await onSave({ ...draft, corsOrigins });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const curl = `curl ${state.api.url}/chat/completions \\
  -H "Content-Type: application/json" \\${draft.apiKey ? `\n  -H "Authorization: Bearer ${draft.apiKey}" \\` : ''}
  -d '{"model":"chatgpt","stream":true,"messages":[{"role":"user","content":"Hello!"}]}'`;

  return (
    <section className="settings">
      <div className="settings-head">
        <h2>Settings</h2>
        <button className="primary" disabled={!dirty} onClick={() => void save()}>
          {saved ? 'Saved' : 'Save changes'}
        </button>
      </div>

      <fieldset>
        <legend>Local API (OpenAI-compatible)</legend>
        <div className="row">
          <label>Base URL</label>
          <div className="inline">
            <code>{state.api.url}</code>
            <button className="small" onClick={() => void window.bridge.copy(state.api.url)}>
              Copy
            </button>
            <span className={`api-pill ${state.api.running ? 'on' : 'off'}`}>{state.api.running ? 'running' : 'stopped'}</span>
          </div>
        </div>
        {state.api.error && <div className="banner error">{state.api.error}</div>}
        <div className="row">
          <label htmlFor="port">Port</label>
          <input id="port" type="number" min={1024} max={65535} value={draft.port} onChange={(e) => set('port', Number(e.target.value))} />
        </div>
        <div className="row">
          <label htmlFor="ollama-port">Ollama port</label>
          <input
            id="ollama-port"
            type="number"
            min={0}
            max={65535}
            placeholder="off (Ollama's default is 11434)"
            value={draft.ollamaPort || ''}
            onChange={(e) => set('ollamaPort', Number(e.target.value) || 0)}
          />
        </div>
        <div className="row">
          <label htmlFor="key">API key</label>
          <div className="inline">
            <input
              id="key"
              placeholder="empty = no key required"
              value={draft.apiKey}
              onChange={(e) => set('apiKey', e.target.value)}
            />
            <button className="small" onClick={() => set('apiKey', newKey())}>
              Generate
            </button>
          </div>
        </div>
        <div className="row">
          <label htmlFor="origins">Allowed origins</label>
          <input
            id="origins"
            placeholder="e.g. http://localhost:3000 (comma separated; browser apps only)"
            value={origins}
            onChange={(e) => setOrigins(e.target.value)}
          />
        </div>
        <p className="muted small-text">
          Models: <code>chatgpt</code>, <code>chatgpt/&lt;model-slug&gt;</code>, <code>grok</code>. The server only listens on
          127.0.0.1.
        </p>
        <p className="muted small-text">
          MCP: <code>{state.api.url.replace(/\/v1$/, '/mcp')}</code> · Ollama clients: <code>{state.api.ollamaUrl}</code> (models{' '}
          <code>chatgpt:latest</code>, <code>grok:latest</code>)
        </p>
        <pre className="snippet">{curl}</pre>
      </fieldset>

      <fieldset>
        <legend>Assistant</legend>
        <div className="row top">
          <label htmlFor="sys">System prompt</label>
          <textarea
            id="sys"
            rows={4}
            placeholder="Added to the first message of every new chat (app and API)."
            value={draft.systemPrompt}
            onChange={(e) => set('systemPrompt', e.target.value)}
          />
        </div>
        <div className="row">
          <label htmlFor="model">ChatGPT model</label>
          <input
            id="model"
            placeholder="site default (e.g. gpt-4o, o3)"
            value={draft.chatgptModel}
            onChange={(e) => set('chatgptModel', e.target.value)}
          />
        </div>
        <div className="row">
          <label htmlFor="timeout">Reply timeout (s)</label>
          <input
            id="timeout"
            type="number"
            min={30}
            max={3600}
            value={draft.responseTimeoutSec}
            onChange={(e) => set('responseTimeoutSec', Number(e.target.value))}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>Browsers</legend>
        <div className="row">
          <label>Providers</label>
          <div className="inline">
            {PROVIDER_IDS.map((id) => (
              <label key={id} className="check">
                <input
                  type="checkbox"
                  checked={draft.enabledProviders[id]}
                  onChange={(e) => set('enabledProviders', { ...draft.enabledProviders, [id]: e.target.checked })}
                />
                {PROVIDER_NAMES[id]}
              </label>
            ))}
          </div>
        </div>
        <div className="row">
          <label htmlFor="channel">Browser</label>
          <select
            id="channel"
            value={draft.browserChannel}
            onChange={(e) => set('browserChannel', e.target.value as Settings['browserChannel'])}
          >
            <option value="auto">Auto (Chrome → Edge → bundled Chromium)</option>
            <option value="chrome">Google Chrome</option>
            <option value="msedge">Microsoft Edge</option>
            <option value="chromium">Bundled Chromium (npm run install-browser)</option>
          </select>
        </div>
        <Toggle label="Show browser windows" checked={draft.showBrowsers} onChange={(v) => set('showBrowsers', v)} />
        <Toggle label="Start browsers when the app opens" checked={draft.autoStartBrowsers} onChange={(v) => set('autoStartBrowsers', v)} />
        <div className="row">
          <label>Selectors</label>
          <div className="inline">
            <button className="small" onClick={() => window.bridge.openPath('selectors').catch((e) => onError(String(e)))}>
              Open selectors folder
            </button>
            <button className="small" onClick={() => void window.bridge.reloadSelectors()}>
              Reload
            </button>
          </div>
        </div>
        <p className="muted small-text">
          If a site changes and replies stop arriving, copy <code>chatgpt.defaults.json</code> to <code>chatgpt.json</code> (or the
          Grok equivalent) in that folder and edit the selectors. See docs/SELECTORS.md.
        </p>
      </fieldset>

      <fieldset>
        <legend>App</legend>
        <div className="row">
          <label htmlFor="theme">Theme</label>
          <select id="theme" value={draft.theme} onChange={(e) => set('theme', e.target.value as Settings['theme'])}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
        <Toggle label="Keep running in the tray when the window is closed" checked={draft.minimizeToTray} onChange={(v) => set('minimizeToTray', v)} />
        <Toggle label="Start on login (installed app, Windows/macOS)" checked={draft.startOnBoot} onChange={(v) => set('startOnBoot', v)} />
        <div className="row">
          <label>Data</label>
          <div className="inline">
            <code className="path">{state.dataDir}</code>
            <button className="small" onClick={() => void window.bridge.openPath('data')}>
              Open
            </button>
          </div>
        </div>
        <p className="muted small-text">Version {state.version}. No telemetry: settings, history and browser profiles stay in this folder.</p>
      </fieldset>

      <fieldset>
        <legend>Logs</legend>
        <button className="small" onClick={() => void window.bridge.getLogs().then(setLogs)}>
          {logs ? 'Refresh' : 'Show logs'}
        </button>
        {logs && (
          <pre className="logs">
            {logs
              .slice(-200)
              .map((l) => `${new Date(l.t).toLocaleTimeString()} ${l.level.toUpperCase().padEnd(5)} ${l.msg}`)
              .join('\n') || 'No log entries yet.'}
          </pre>
        )}
      </fieldset>
    </section>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="row">
      <label />
      <label className="check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    </div>
  );
}
