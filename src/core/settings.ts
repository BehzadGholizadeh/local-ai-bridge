import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PROVIDER_IDS, type Settings } from '../shared/types';
import { writeJsonAtomic } from './fsutil';

export const DEFAULT_SETTINGS: Settings = {
  port: 8080,
  apiKey: '',
  corsOrigins: [],
  systemPrompt: '',
  theme: 'system',
  browserChannel: 'auto',
  showBrowsers: false,
  autoStartBrowsers: true,
  startOnBoot: false,
  minimizeToTray: true,
  responseTimeoutSec: 300,
  enabledProviders: { chatgpt: true, grok: true },
  defaultTargets: ['chatgpt'],
  chatgptModel: '',
};

function sanitize(next: Settings, prev: Settings): Settings {
  const s = { ...next };
  const port = Math.trunc(Number(s.port));
  s.port = port >= 1024 && port <= 65535 ? port : prev.port;
  const timeout = Math.trunc(Number(s.responseTimeoutSec));
  s.responseTimeoutSec = Math.min(3600, Math.max(30, Number.isFinite(timeout) ? timeout : prev.responseTimeoutSec));
  s.corsOrigins = (Array.isArray(s.corsOrigins) ? s.corsOrigins : []).map((o) => String(o).trim()).filter(Boolean);
  s.defaultTargets = (Array.isArray(s.defaultTargets) ? s.defaultTargets : []).filter((t) => PROVIDER_IDS.includes(t));
  if (!s.defaultTargets.length) s.defaultTargets = ['chatgpt'];
  if (!['system', 'light', 'dark'].includes(s.theme)) s.theme = prev.theme;
  if (!['auto', 'chrome', 'msedge', 'chromium'].includes(s.browserChannel)) s.browserChannel = prev.browserChannel;
  s.apiKey = String(s.apiKey ?? '').trim();
  s.chatgptModel = String(s.chatgptModel ?? '').trim();
  s.systemPrompt = String(s.systemPrompt ?? '');
  return s;
}

/** settings.json in the data dir. Emits 'change' (next, prev) after every update. */
export class SettingsStore extends EventEmitter {
  private value: Settings;

  constructor(private file: string) {
    super();
    let stored: Partial<Settings> = {};
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>;
    } catch {
      // first run or unreadable: use defaults
    }
    this.value = sanitize(
      {
        ...DEFAULT_SETTINGS,
        ...stored,
        enabledProviders: { ...DEFAULT_SETTINGS.enabledProviders, ...(stored.enabledProviders ?? {}) },
      },
      DEFAULT_SETTINGS,
    );
  }

  get(): Settings {
    return this.value;
  }

  update(patch: Partial<Settings>): Settings {
    const prev = this.value;
    const next = sanitize(
      { ...prev, ...patch, enabledProviders: { ...prev.enabledProviders, ...(patch.enabledProviders ?? {}) } },
      prev,
    );
    this.value = next;
    writeJsonAtomic(this.file, next);
    this.emit('change', next, prev);
    return next;
  }
}
