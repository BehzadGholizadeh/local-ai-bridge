import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PROVIDER_IDS, PROVIDER_NAMES, type ApiInfo, type ProviderAction, type ProviderId, type ProviderStatus, type Settings } from '../shared/types';
import { ChatService } from './chat';
import { BridgeError } from './errors';
import { HistoryStore } from './history';
import { Logger } from './logger';
import { WebChatProvider } from './provider';
import { SelectorStore } from './selectors';
import { ApiServer } from './server';
import { SettingsStore } from './settings';
import { VERSION } from './version';

const STATUS_POLL_MS = 15_000;

/**
 * Owns everything that runs without a UI: settings, history, the two browser-driven
 * providers and the OpenAI-compatible HTTP server. Used by the Electron app and by
 * the headless CLI. Emits 'status' (ProviderStatus) and 'api' (ApiInfo).
 */
export class Bridge extends EventEmitter {
  readonly log: Logger;
  readonly settings: SettingsStore;
  readonly history: HistoryStore;
  readonly selectors: SelectorStore;
  readonly providers: Record<ProviderId, WebChatProvider>;
  readonly chat: ChatService;
  readonly api: ApiServer;
  readonly version = VERSION;
  private poll?: NodeJS.Timeout;
  private started = false;

  /** `quiet` keeps log entries in memory without printing them (for the interactive CLI agent). */
  constructor(
    readonly dataDir: string,
    opts: { quiet?: boolean } = {},
  ) {
    super();
    this.log = new Logger(!opts.quiet);
    fs.mkdirSync(dataDir, { recursive: true });
    this.settings = new SettingsStore(path.join(dataDir, 'settings.json'));
    this.history = new HistoryStore(path.join(dataDir, 'history.json'));
    this.selectors = new SelectorStore(path.join(dataDir, 'selectors'), this.log);
    const make = (id: ProviderId) => {
      const p = new WebChatProvider(id, PROVIDER_NAMES[id], {
        profileDir: path.join(dataDir, 'profiles', id),
        getSettings: () => this.settings.get(),
        getSelectors: () => this.selectors.get(id),
        log: this.log,
      });
      p.on('status', (s: ProviderStatus) => this.emit('status', s));
      return p;
    };
    this.providers = { chatgpt: make('chatgpt'), grok: make('grok') };
    this.chat = new ChatService(this);
    this.api = new ApiServer(this);
    this.settings.on('change', (next: Settings, prev: Settings) => {
      void this.onSettingsChange(next, prev);
    });
  }

  statuses(): ProviderStatus[] {
    return PROVIDER_IDS.map((id) => this.providers[id].status);
  }

  /** The provider, if it is enabled in settings. */
  provider(id: ProviderId): WebChatProvider {
    if (!this.settings.get().enabledProviders[id]) {
      throw new BridgeError('disabled', `${PROVIDER_NAMES[id]} is disabled in Settings.`);
    }
    return this.providers[id];
  }

  apiInfo(): ApiInfo {
    return { url: this.api.url, ollamaUrl: this.api.ollamaUrl, running: this.api.running, error: this.api.error };
  }

  async start(): Promise<void> {
    this.started = true;
    this.log.info(`data directory: ${this.dataDir}`);
    await this.startApi();
    const s = this.settings.get();
    if (s.autoStartBrowsers) {
      for (const id of PROVIDER_IDS) {
        if (s.enabledProviders[id]) this.providers[id].start().catch((e) => this.log.warn(`[${id}]`, e));
      }
    }
    this.poll = setInterval(() => {
      for (const p of Object.values(this.providers)) if (p.running) void p.refreshStatus();
    }, STATUS_POLL_MS);
  }

  async stop(): Promise<void> {
    clearInterval(this.poll);
    await this.api.stop();
    await Promise.all(Object.values(this.providers).map((p) => p.stop()));
    this.history.flush();
  }

  async providerAction(id: ProviderId, action: ProviderAction): Promise<void> {
    const p = action === 'stop' || action === 'hide' ? this.providers[id] : this.provider(id);
    switch (action) {
      case 'login':
        return p.openLogin();
      case 'show':
        return p.show();
      case 'hide':
        return p.hide();
      case 'restart':
        return p.restart();
      case 'stop':
        return p.stop();
      case 'check':
        await p.refreshStatus();
        return;
    }
  }

  private async startApi(): Promise<void> {
    try {
      await this.api.start();
      this.log.info(`OpenAI-compatible API listening on ${this.api.url}`);
    } catch (e) {
      this.log.error(`API server failed to start: ${this.api.error ?? (e as Error).message}`);
    }
    this.emit('api', this.apiInfo());
  }

  private async onSettingsChange(next: Settings, prev: Settings): Promise<void> {
    // Before start() the new ports are simply used when it runs; afterwards restart the server
    // (also when it failed to start, e.g. because the old port was taken).
    if ((next.port !== prev.port || next.ollamaPort !== prev.ollamaPort) && this.started) {
      await this.api.stop();
      await this.startApi();
    }
    if (next.showBrowsers !== prev.showBrowsers) {
      for (const p of Object.values(this.providers)) {
        if (p.running) void (next.showBrowsers ? p.show() : p.hide()).catch(() => undefined);
      }
    }
    if (next.browserChannel !== prev.browserChannel) {
      for (const p of Object.values(this.providers)) if (p.running) void p.restart().catch(() => undefined);
    }
    for (const id of PROVIDER_IDS) {
      if (prev.enabledProviders[id] && !next.enabledProviders[id]) void this.providers[id].stop();
    }
  }
}
