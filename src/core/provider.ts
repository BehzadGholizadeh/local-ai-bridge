import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core';
import type { BrowserChannel, ProviderId, ProviderState, ProviderStatus, Settings } from '../shared/types';
import type { Attachment } from './attachments';
import { BridgeError } from './errors';
import { extractReplyHtml } from './extract';
import type { Logger } from './logger';
import { htmlToMarkdown } from './markdown';
import { Mutex } from './mutex';
import type { SiteSelectors } from './selectors';

export interface SendOptions {
  prompt: string;
  /** Continue this web conversation instead of starting a new one. */
  chatUrl?: string;
  /** Model slug for a new chat, if the site supports choosing one by URL. */
  model?: string;
  /**
   * Sent instead of `prompt` when `chatUrl` opens an empty conversation (e.g. a guest chat
   * that expired), so it can carry the earlier turns as context.
   */
  fallbackPrompt?: string;
  /** Files to upload with this message through the site's attach button. */
  attachments?: Attachment[];
  signal?: AbortSignal;
  /** Called with the full Markdown of the reply so far, whenever it changes. */
  onUpdate?: (text: string) => void;
  /** Called as the request moves through its phases, for progress display. */
  onPhase?: (phase: SendPhase) => void;
}

/** Where a request is: shown to the user so a long wait never looks like a hang. */
export type SendPhase = 'queued' | 'opening' | 'typing' | 'uploading' | 'sending' | 'waiting' | 'writing';

export interface SendResult {
  text: string;
  /** URL of the web conversation, to continue it later. Undefined if the site didn't assign one. */
  chatUrl?: string;
  aborted: boolean;
}

interface ProviderDeps {
  profileDir: string;
  getSettings: () => Settings;
  getSelectors: () => SiteSelectors;
  log: Logger;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BROWSER_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  // The window is usually minimized; keep the page rendering and its timers running.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

/**
 * Drives one chat website (ChatGPT or Grok) in its own persistent browser profile.
 * The user signs in once in that window; cookies stay in the profile on disk.
 */
export class WebChatProvider extends EventEmitter {
  private ctx?: BrowserContext;
  private page?: Page;
  private starting?: Promise<Page>;
  private mutex = new Mutex();
  private _status: ProviderStatus;
  /** Browser channel the automation last ran with; the sign-in window uses the same browser. */
  private channelUsed?: BrowserChannel;
  private loginProcess?: ChildProcess;

  constructor(
    readonly id: ProviderId,
    readonly name: string,
    private deps: ProviderDeps,
  ) {
    super();
    this._status = { id, name, state: 'stopped', updatedAt: Date.now() };
  }

  get status(): ProviderStatus {
    return this._status;
  }

  get running(): boolean {
    return !!this.ctx;
  }

  private setStatus(state: ProviderState, detail?: string, guest?: boolean): void {
    this._status = { id: this.id, name: this.name, state, detail, guest, updatedAt: Date.now() };
    this.emit('status', this._status);
  }

  private get log() {
    const { log } = this.deps;
    const tag = `[${this.id}]`;
    return {
      info: (...a: unknown[]) => log.info(tag, ...a),
      warn: (...a: unknown[]) => log.warn(tag, ...a),
    };
  }

  // ---------------------------------------------------------------- lifecycle

  /** Launches the browser (if needed) and returns the chat page. */
  async start(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.loginProcess) {
      throw new BridgeError('logged_out', `Finish signing in to ${this.name} and close the sign-in window first.`);
    }
    if (!this.starting) {
      this.starting = this.launch().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private async launch(): Promise<Page> {
    this.setStatus('starting', 'Launching browser…');
    const settings = this.deps.getSettings();
    try {
      if (!this.ctx) {
        const { ctx, channel } = await launchContext(this.deps.profileDir, settings.browserChannel, this.log);
        this.channelUsed = channel;
        ctx.on('close', () => {
          this.ctx = undefined;
          this.page = undefined;
          this.setStatus('stopped', 'Browser closed. Use "Log in" or send a message to start it again.');
        });
        this.ctx = ctx;
      }
      const page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
      page.on('close', () => {
        if (this.page === page) this.page = undefined;
      });
      this.page = page;
      if (!settings.showBrowsers) await this.setWindowState('minimized').catch(() => undefined);
      const sel = this.deps.getSelectors();
      if (!page.url().startsWith(new URL(sel.url).origin)) {
        await gotoWithRetry(page, sel.url, this.log);
      }
      await this.detectState(page, 15_000);
      return page;
    } catch (e) {
      const err = BridgeError.from(e);
      this.setStatus('error', err.message);
      throw err;
    }
  }

  async stop(): Promise<void> {
    const ctx = this.ctx;
    this.ctx = undefined;
    this.page = undefined;
    await ctx?.close().catch(() => undefined);
    this.setStatus('stopped');
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Brings the browser window to the front so the user can log in or solve a challenge. */
  async show(): Promise<void> {
    const page = await this.start();
    await this.setWindowState('normal').catch(() => undefined);
    await page.bringToFront();
  }

  async hide(): Promise<void> {
    if (this.page) await this.setWindowState('minimized').catch(() => undefined);
  }

  /**
   * Opens the site in a normal browser window (not controlled by Playwright) on this provider's
   * profile. Sign-in pages often refuse automated browsers ("verify you are human" loops), so the
   * user signs in there; when that window is closed, automation restarts with the saved session.
   */
  async openLogin(): Promise<void> {
    if (this.loginProcess) return;
    if (this.mutex.locked) {
      throw new BridgeError('busy', `${this.name} is answering a message. Try again when it finishes.`);
    }
    const exe = findBrowserExecutable(this.deps.getSettings().browserChannel, this.channelUsed);
    if (!exe) {
      throw new BridgeError('browser_missing', 'No Chrome or Edge found to open the sign-in window. Install Google Chrome.');
    }
    // A profile can only be open in one browser at a time: let any launch finish, then close it.
    await this.starting?.catch(() => undefined);
    await this.stop();
    const openedAt = Date.now();
    const child = spawn(
      exe,
      [`--user-data-dir=${this.deps.profileDir}`, '--no-first-run', '--no-default-browser-check', this.deps.getSelectors().url],
      { stdio: 'ignore' },
    );
    this.loginProcess = child;
    this.log.info(`sign-in window opened (${path.basename(exe)})`);
    this.setStatus(
      'logged_out',
      `Sign in to ${this.name} in the browser window that opened, then close that window. The bridge reconnects automatically.`,
    );
    child.on('error', (e) => {
      this.log.warn('could not open sign-in window:', e);
      this.setStatus('error', `Could not open the sign-in window: ${e.message}`);
    });
    child.on('exit', () => {
      this.loginProcess = undefined;
      if (Date.now() - openedAt < 3_000) {
        // Chrome hands the URL to an existing window on the same profile and exits at once.
        this.log.warn('sign-in window exited immediately: the profile is open in another browser window');
        this.setStatus('error', `The ${this.name} profile is already open in another browser window. Close it and click "Log in" again.`);
        return;
      }
      this.log.info('sign-in window closed; reconnecting');
      this.start().catch(() => undefined);
    });
  }

  /** Re-reads login/challenge state from the page (skipped while a message is in flight). */
  async refreshStatus(): Promise<ProviderStatus> {
    const page = this.page;
    if (!page || page.isClosed() || this.mutex.locked || this.starting) return this._status;
    await this.detectState(page, 2_000).catch(() => undefined);
    return this._status;
  }

  private async setWindowState(windowState: 'minimized' | 'normal'): Promise<void> {
    if (!this.ctx || !this.page) return;
    const cdp = await this.ctx.newCDPSession(this.page);
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState } });
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- state detection

  private async detectState(page: Page, waitMs: number): Promise<ProviderState> {
    const sel = this.deps.getSelectors();
    const input = await findVisible(page, [...sel.input, ...sel.loggedOutMarkers], waitMs);
    const hasInput = !!input && !!(await findVisible(page, sel.input, 0));
    const loggedOut = !!(await findVisible(page, sel.loggedOutMarkers, 0));

    if (hasInput) {
      if (loggedOut) {
        this.setStatus('ready', 'Not signed in: guest mode with stricter limits. Click "Log in" to sign in.', true);
      } else {
        this.setStatus('ready');
      }
      return 'ready';
    }
    // On another site (e.g. auth.openai.com): mid sign-in, not a challenge on the chat site.
    if (!sameOrigin(page.url(), sel.url)) {
      this.setStatus('logged_out', `Not signed in. Click "Log in" to sign in to ${this.name}.`);
      return 'logged_out';
    }
    if (await isChallenge(page)) {
      this.setStatus('challenge', 'Security check (Cloudflare). Click "Show" and complete it in the browser window.');
      return 'challenge';
    }
    if (await isRegionBlocked(page)) {
      this.setStatus('error', `${this.name} says it is not available in your region.`);
      return 'error';
    }
    if (loggedOut) {
      this.setStatus('logged_out', `Not signed in. Click "Log in" and sign in to ${this.name}.`);
      return 'logged_out';
    }
    this.setStatus(
      'logged_out',
      'Message box not found. Sign in, or update the selectors if the site changed (see docs/SELECTORS.md).',
    );
    return 'logged_out';
  }

  // ---------------------------------------------------------------- messaging

  /** Sends one prompt and resolves with the full reply. Calls queue up behind each other. */
  send(opts: SendOptions): Promise<SendResult> {
    if (this.mutex.locked) {
      this.log.info(`queued (${this.mutex.queued + 1} ahead)`);
      opts.onPhase?.('queued');
    }
    return this.mutex.run(async () => {
      if (opts.signal?.aborted) throw new BridgeError('aborted', 'Request cancelled.');
      opts.onPhase?.('opening');
      const page = await this.start();
      const sel = this.deps.getSelectors();
      const timeoutMs = this.deps.getSettings().responseTimeoutSec * 1000;
      this.setStatus('busy', 'Answering…', this._status.guest);
      try {
        await this.navigate(page, sel, opts);
        const input = await this.waitForComposer(page, sel);
        let prompt = opts.prompt;
        if (opts.chatUrl && opts.fallbackPrompt && !(await hasAnyReply(page, sel))) {
          this.log.warn('continued chat is empty (expired or deleted); resending earlier turns as context');
          prompt = opts.fallbackPrompt;
        }
        await this.checkBlockingDialog(page, sel);
        const baseline = await countEach(page, sel.assistantMessage);
        const files = opts.attachments ?? [];
        if (files.length) {
          opts.onPhase?.('uploading');
          await this.upload(page, sel, files);
        }
        opts.onPhase?.('typing');
        // Attachments alone are a valid message; only type when there is text.
        if (prompt.trim() || !files.length) await typePrompt(page, input, prompt);
        opts.onPhase?.('sending');
        if (files.length) {
          // The send button stays disabled until the site has finished uploading.
          if (!(await submit(page, sel, input, 120_000, true))) {
            throw new BridgeError('upload_failed', `${this.name} did not finish uploading the attachments. Check the browser window (click "Show").`);
          }
        } else {
          await submit(page, sel, input);
        }
        this.log.info(`prompt sent (${prompt.length} chars)`);
        opts.onPhase?.('waiting');
        const msgSelector = await this.waitForReply(page, sel, baseline, opts.signal);
        const result = await this.streamReply(page, sel, msgSelector, opts, timeoutMs);
        const url = page.url();
        const home = new URL(sel.newChatUrl);
        const chatUrl = new URL(url).pathname !== home.pathname ? url : undefined;
        await this.detectState(page, 0).catch(() => undefined);
        return { ...result, chatUrl };
      } catch (e) {
        let err = BridgeError.from(e);
        // A failure to type or send is often a dialog in the way: report that instead.
        if (err.code === 'selector' && !page.isClosed()) {
          err = await this.checkBlockingDialog(page, this.deps.getSelectors()).then(
            () => err,
            (dialogErr: unknown) => BridgeError.from(dialogErr),
          );
        }
        this.log.warn(`send failed: ${err.code}: ${err.message}`);
        if ((err.code === 'timeout' || err.code === 'selector' || err.code === 'upload_failed') && !page.isClosed()) {
          await this.saveDebugSnapshot(page, err.code);
        }
        if (err.code === 'rate_limited') this.setStatus('rate_limited', err.message, this._status.guest);
        else if (!page.isClosed()) await this.detectState(page, 0).catch(() => undefined);
        throw err;
      }
    });
  }

  /**
   * Saves a screenshot and the page HTML next to the profiles (data dir/debug), so a failure the
   * user can't see (minimized window) can be diagnosed, e.g. for fixing selectors. Keeps the last 10.
   */
  private async saveDebugSnapshot(page: Page, code: string): Promise<void> {
    try {
      const dir = path.join(path.dirname(path.dirname(this.deps.profileDir)), 'debug');
      fs.mkdirSync(dir, { recursive: true });
      const base = path.join(dir, `${this.id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${code}`);
      await page.screenshot({ path: `${base}.png`, fullPage: false, timeout: 10_000 });
      fs.writeFileSync(`${base}.html`, await page.content());
      const old = fs.readdirSync(dir).filter((f) => f.startsWith(`${this.id}-`)).sort();
      for (const f of old.slice(0, Math.max(0, old.length - 20))) fs.rmSync(path.join(dir, f), { force: true });
      this.log.warn(`saved page snapshot for troubleshooting: ${base}.png / .html`);
    } catch (e) {
      this.log.warn('could not save a page snapshot:', e);
    }
  }

  /**
   * Throws if a modal dialog blocks the chat: a sign-in wall ("Log in or sign up", shown to
   * signed-out users after some messages) or a usage-limit notice.
   */
  private async checkBlockingDialog(page: Page, sel: SiteSelectors): Promise<void> {
    const texts = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
          .filter((d) => {
            const r = d.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(d).visibility !== 'hidden';
          })
          .map((d) => (d as HTMLElement).innerText.slice(0, 500)),
      )
      .catch(() => [] as string[]);
    for (const text of texts) {
      const lower = text.toLowerCase();
      if (sel.rateLimitPatterns.some((p) => lower.includes(p.toLowerCase()))) {
        throw new BridgeError('rate_limited', `${this.name} usage limit: "${text.replace(/\s+/g, ' ').slice(0, 160)}"`);
      }
      if (sel.loginWallPatterns.some((p) => lower.includes(p.toLowerCase()))) {
        throw new BridgeError(
          'logged_out',
          `${this.name} is asking you to sign in before it continues (signed-out use is limited). Click "Log in" in the app.`,
        );
      }
    }
  }

  /** Puts the files on the site's hidden file input, as if picked with the attach button. */
  private async upload(page: Page, sel: SiteSelectors, files: Attachment[]): Promise<void> {
    const target = await pickFileInput(page, sel.fileInput, files);
    if (!target) {
      throw new BridgeError(
        'upload_failed',
        `${this.name} offers no file upload here${this._status.guest ? ' (attachments usually need you to sign in)' : ''}.`,
      );
    }
    await target.setInputFiles(files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: f.data })));
    this.log.info(`attached ${files.length} file(s): ${files.map((f) => `${f.name} (${f.mimeType})`).join(', ')}`);
    // Give the site a moment to register the files and disable Send while it uploads.
    await sleep(1_500);
  }

  private async navigate(page: Page, sel: SiteSelectors, opts: SendOptions): Promise<void> {
    let target: string;
    if (opts.chatUrl) {
      if (page.url() === opts.chatUrl) return;
      target = opts.chatUrl;
    } else if (opts.model && sel.modelUrlTemplate) {
      target = sel.modelUrlTemplate.replace('{model}', encodeURIComponent(opts.model));
    } else {
      if (opts.model) this.log.warn(`model "${opts.model}" ignored: no modelUrlTemplate for ${this.name}`);
      target = sel.newChatUrl;
    }
    await gotoWithRetry(page, target, this.log);
  }

  private async waitForComposer(page: Page, sel: SiteSelectors): Promise<Locator> {
    const input = await findVisible(page, sel.input, 30_000);
    if (input) return input;
    if (await isChallenge(page)) {
      throw new BridgeError('challenge', `${this.name} is showing a security check. Open the app, click "Show" on ${this.name} and complete it.`);
    }
    if (await isRegionBlocked(page)) {
      throw new BridgeError('blocked', `${this.name} says it is not available in your region.`);
    }
    if (await findVisible(page, sel.loggedOutMarkers, 0)) {
      throw new BridgeError('logged_out', `Not signed in to ${this.name}. Open the app and click "Log in".`);
    }
    throw new BridgeError(
      'selector',
      `Could not find the ${this.name} message box. The site may have changed; update the selectors (docs/SELECTORS.md).`,
    );
  }

  /** Waits until a new assistant reply element appears and returns the selector that matched it. */
  private async waitForReply(
    page: Page,
    sel: SiteSelectors,
    baseline: Map<string, number>,
    signal?: AbortSignal,
  ): Promise<string> {
    const deadline = Date.now() + 120_000;
    let checkedLimits = false;
    const started = Date.now();
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await clickStop(page, sel);
        throw new BridgeError('aborted', 'Request cancelled.');
      }
      for (const s of sel.assistantMessage) {
        const n = await page.locator(s).count().catch(() => 0);
        if (n > (baseline.get(s) ?? 0)) return s;
      }
      // Still generating (e.g. "thinking") without a reply element yet: keep waiting.
      const generating = !!(await findVisible(page, sel.stopButton, 0));
      if (!generating && Date.now() - started > 8_000 && !checkedLimits) {
        checkedLimits = true;
        const limit = await findRateLimit(page, sel);
        if (limit) throw new BridgeError('rate_limited', `${this.name} usage limit: "${limit}"`);
        if (await isChallenge(page)) throw new BridgeError('challenge', `${this.name} is showing a security check.`);
        if (await findPhrase(page, sel.loginWallPatterns)) {
          throw new BridgeError('logged_out', `${this.name} asks you to sign in before it answers. Open the app and click "Log in".`);
        }
      }
      await sleep(250);
    }
    const limit = await findRateLimit(page, sel);
    if (limit) throw new BridgeError('rate_limited', `${this.name} usage limit: "${limit}"`);
    if (await findPhrase(page, sel.loginWallPatterns)) {
      throw new BridgeError('logged_out', `${this.name} asks you to sign in before it answers. Open the app and click "Log in".`);
    }
    throw new BridgeError('selector', `No reply appeared on ${this.name}. If the answer is visible in the browser, the reply selectors need updating.`);
  }

  private async streamReply(
    page: Page,
    sel: SiteSelectors,
    msgSelector: string,
    opts: SendOptions,
    timeoutMs: number,
  ): Promise<{ text: string; aborted: boolean }> {
    const reply = page.locator(msgSelector).last();
    const started = Date.now();
    let text = '';
    let lastChange = Date.now();
    let completeSince = 0;
    let lastWallCheck = Date.now();
    while (true) {
      if (opts.signal?.aborted) {
        await clickStop(page, sel);
        return { text, aborted: true };
      }
      const html = await reply.evaluate(extractReplyHtml, sel.assistantContent).catch(() => null);
      if (html !== null) {
        const next = htmlToMarkdown(html);
        if (next !== text) {
          text = next;
          lastChange = Date.now();
          opts.onPhase?.('writing');
          opts.onUpdate?.(text);
        }
      }
      const generating = !!(await findVisible(page, sel.stopButton, 0));
      const idle = Date.now() - lastChange;
      // No text yet and nothing generating: a limit or sign-in dialog may have replaced the reply.
      if (!text && !generating && Date.now() - lastWallCheck > 5_000) {
        lastWallCheck = Date.now();
        const limit = await findRateLimit(page, sel);
        if (limit) throw new BridgeError('rate_limited', `${this.name} usage limit: "${limit}"`);
        if (await findPhrase(page, sel.loginWallPatterns)) {
          throw new BridgeError('logged_out', `${this.name} asks you to sign in before it answers. Open the app and click "Log in".`);
        }
      }
      // Completion. Two signals, whichever comes first:
      // 1. The site's "finished" marker on the reply (replyComplete), when this page has one.
      //    ChatGPT sets it ~2s before the text renders, so the text must also be stable.
      // 2. No stop button and the text unchanged for a while. This also covers pages without a
      //    marker (signed-in ChatGPT has none), where requiring it would wait until the timeout.
      // An empty reply (e.g. an image) counts after 10s with the marker, or 90s without.
      const complete =
        sel.replyComplete.length > 0 &&
        (await reply.evaluate((el, sels: string[]) => sels.some((s) => el.matches(s)), sel.replyComplete).catch(() => false));
      if (!complete || generating) completeSince = 0;
      else if (!completeSince) completeSince = Date.now();
      if (completeSince && text && idle >= Math.min(sel.stableMs, 800)) break;
      if (completeSince && !text && Date.now() - completeSince >= 10_000) break;
      if (!generating && text && idle >= Math.max(sel.stableMs, 4_000)) break;
      if (!generating && !text && idle >= 90_000) break;
      if (Date.now() - started > timeoutMs) {
        throw new BridgeError('timeout', `${this.name} did not finish within ${Math.round(timeoutMs / 1000)}s.`, text);
      }
      await sleep(200);
    }
    if (text.length < 400) {
      const lower = text.toLowerCase();
      const hit = sel.rateLimitPatterns.find((p) => lower.includes(p.toLowerCase()));
      if (hit && !text.includes('\n\n')) throw new BridgeError('rate_limited', `${this.name}: ${text}`);
    }
    this.log.info(`reply complete (${text.length} chars, ${Math.round((Date.now() - started) / 1000)}s)`);
    return { text, aborted: false };
  }
}

// ---------------------------------------------------------------- helpers

async function launchContext(
  profileDir: string,
  pref: BrowserChannel,
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
): Promise<{ ctx: BrowserContext; channel: BrowserChannel }> {
  // System Chrome/Edge first: they auto-update and sites trust them more than a bundled Chromium.
  const candidates: BrowserChannel[] = pref === 'auto' ? ['chrome', 'msedge', 'chromium'] : [pref];
  let lastError: unknown;
  for (const channel of candidates) {
    const label = channel === 'chromium' ? 'bundled chromium' : channel;
    try {
      const ctx = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        channel: channel === 'chromium' ? undefined : channel,
        // A fixed desktop-sized page: the window is usually minimized, and without this the sites
        // can switch to their mobile layout, where the composer is hidden and sending fails.
        viewport: { width: 1280, height: 900 },
        args: BROWSER_ARGS,
      });
      log.info(`browser started (${label})`);
      return { ctx, channel };
    } catch (e) {
      lastError = e;
      log.warn(`could not start ${label}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  const detail = lastError instanceof Error ? lastError.message.split('\n')[0] : String(lastError);
  if (/user data directory is already in use|ProcessSingleton|SingletonLock/i.test(detail)) {
    throw new BridgeError('browser_missing', 'The browser profile is in use by another copy of the app. Close it and try again.');
  }
  throw new BridgeError(
    'browser_missing',
    `No usable browser. Install Google Chrome or Microsoft Edge, or run "npm run install-browser". (${detail})`,
  );
}

const TRANSIENT_NET = /ERR_(CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED|NETWORK_CHANGED|INTERNET_DISCONNECTED|TIMED_OUT|EMPTY_RESPONSE|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR)/;

/** Navigates, retrying transient network errors (flaky or filtered connections reset the first request). */
async function gotoWithRetry(page: Page, url: string, log: { warn: (...a: unknown[]) => void }): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      return;
    } catch (e) {
      const msg = (e as Error).message;
      if (attempt >= 3 || !TRANSIENT_NET.test(msg)) throw e;
      log.warn(`navigation failed (${msg.match(TRANSIENT_NET)?.[0]}), retrying (${attempt}/2)…`);
      await sleep(2_000 * attempt);
    }
  }
}

const BROWSER_PATHS: Record<Exclude<BrowserChannel, 'auto' | 'chromium'>, () => string[]> = {
  chrome: () =>
    process.platform === 'win32'
      ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
          .filter((b): b is string => !!b)
          .map((b) => path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
  msedge: () =>
    process.platform === 'win32'
      ? [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES]
          .filter((b): b is string => !!b)
          .map((b) => path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
      : process.platform === 'darwin'
        ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : ['/usr/bin/microsoft-edge', '/opt/microsoft/msedge/msedge'],
};

/** Path of the browser to open for sign-in: the one automation used, else the preferred one. */
function findBrowserExecutable(pref: BrowserChannel, used?: BrowserChannel): string | null {
  const order: BrowserChannel[] = used ? [used] : pref === 'auto' ? ['chrome', 'msedge', 'chromium'] : [pref];
  for (const channel of order) {
    const candidates = channel === 'chromium' || channel === 'auto' ? [chromium.executablePath()] : BROWSER_PATHS[channel]();
    const found = candidates.find((p) => fs.existsSync(p));
    if (found) return found;
  }
  return null;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Returns the first visible element matching any selector, polling up to `timeoutMs`. */
export async function findVisible(page: Page, selectors: string[], timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const s of selectors) {
      const loc = page.locator(s);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 5); i++) {
        if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i);
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(250);
  } while (Date.now() < deadline);
  return null;
}

/** Whether the open conversation shows any earlier reply (gives a loading chat a few seconds). */
async function hasAnyReply(page: Page, sel: SiteSelectors): Promise<boolean> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    for (const s of sel.assistantMessage) {
      if ((await page.locator(s).count().catch(() => 0)) > 0) return true;
    }
    await sleep(250);
  }
  return false;
}

async function countEach(page: Page, selectors: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const s of selectors) counts.set(s, await page.locator(s).count().catch(() => 0));
  return counts;
}

/**
 * Clicks without relying on the mouse position: overlays such as cookie banners can cover the
 * composer, which makes a real pointer click time out.
 */
async function press(loc: Locator): Promise<boolean> {
  if (await loc.click({ timeout: 2_000 }).then(() => true, () => false)) return true;
  return loc.dispatchEvent('click').then(() => true, () => false);
}

async function typePrompt(page: Page, input: Locator, prompt: string): Promise<void> {
  await input.focus();
  const valueOf = () =>
    input.evaluate((el) => ('value' in el ? String((el as HTMLTextAreaElement).value) : el.textContent ?? ''));
  try {
    await input.fill(prompt);
  } catch {
    // some editors reject fill(); fall through to typing
  }
  if (!(await valueOf()).trim()) {
    await page.keyboard.insertText(prompt);
  }
  if (!(await valueOf()).trim()) {
    throw new BridgeError('selector', 'Could not type into the message box. The input selector may be outdated.');
  }
}

/** Length of the text still in the message box. */
function composerLength(input: Locator): Promise<number> {
  return input
    .evaluate((el) => ('value' in el ? String((el as HTMLTextAreaElement).value) : (el.textContent ?? '')).trim().length)
    .catch(() => 0);
}

/**
 * Sends the typed message and confirms it left the message box (or a reply started). Overlays
 * and site changes can make a click silently do nothing, so each method is checked before the
 * next is tried: click Send → DOM click → Enter → submit the form.
 *
 * `waitMs`: how long Send may stay disabled first (long for uploads). With `requireButton`, a
 * Send button that never enables means failure (the upload didn't finish) instead of trying Enter.
 * Returns false only in that case; throws if the message could not be sent at all.
 */
async function submit(page: Page, sel: SiteSelectors, input: Locator, waitMs = 5_000, requireButton = false): Promise<boolean> {
  const typed = await composerLength(input);
  const startUrl = page.url();
  const baseline = await countEach(page, sel.assistantMessage);
  // Evidence that the message really left: the box we typed into was emptied (and is still on
  // the page), a stop button or a new reply appeared, or a new conversation URL. "Some visible
  // empty composer" is NOT evidence: a hidden composer plus another empty editor fooled that.
  const sent = async (ms: number) => {
    const deadline = Date.now() + ms;
    do {
      if (typed > 0) {
        const attached = await input.isVisible().catch(() => false);
        if (attached && (await composerLength(input)) < typed / 2) return true;
      }
      if (await findVisible(page, sel.stopButton, 0)) return true;
      if (page.url() !== startUrl && /\/(c|uc|chat)\//.test(new URL(page.url()).pathname)) return true;
      for (const [s, n] of baseline) if ((await page.locator(s).count().catch(() => 0)) > n) return true;
      await sleep(200);
    } while (Date.now() < deadline);
    return false;
  };

  // Wait for an enabled Send button (disabled while uploading or while the site processes a paste).
  let btn: Locator | null = null;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const b = await findVisible(page, sel.sendButton, 0);
    if (b && (await b.isEnabled().catch(() => false))) {
      btn = b;
      break;
    }
    await sleep(250);
  }
  if (!btn && requireButton) return false;

  const attempts: (() => Promise<unknown>)[] = [
    ...(btn
      ? [() => btn!.click({ timeout: 2_000 }), () => btn!.dispatchEvent('click')]
      : []),
    () => input.press('Enter'),
    () =>
      input.evaluate((el) => {
        const form = el.closest('form');
        if (form) form.requestSubmit();
      }),
  ];
  for (const attempt of attempts) {
    const tried = await attempt().then(
      () => true,
      () => false,
    );
    if (tried && (await sent(3_000))) return true;
  }
  throw new BridgeError(
    'selector',
    'The message was typed but could not be sent: a dialog may be covering the message box (click "Show" to see it), ' +
      'signed-out usage may be used up (sign in), or the send button selector is outdated.',
  );
}

/** True if an <input accept="..."> list allows the file. Empty accept allows everything. */
function acceptAllows(accept: string, file: Attachment): boolean {
  const tokens = accept.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return true;
  const mime = file.mimeType.toLowerCase();
  const ext = path.extname(file.name).toLowerCase();
  return tokens.some((t) => t === mime || t === ext || (t.endsWith('/*') && mime.startsWith(t.slice(0, -1))));
}

/** Picks the file input whose `accept` allows all files (preferring `multiple` for several files). */
async function pickFileInput(page: Page, selectors: string[], files: Attachment[]): Promise<Locator | null> {
  let best: { loc: Locator; score: number } | null = null;
  for (const s of selectors) {
    const loc = page.locator(s);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      const attrs = await el
        .evaluate((e) => ({ accept: e.getAttribute('accept') ?? '', multiple: e.hasAttribute('multiple'), disabled: (e as HTMLInputElement).disabled }))
        .catch(() => null);
      if (!attrs || attrs.disabled || !files.every((f) => acceptAllows(attrs.accept, f))) continue;
      const score = (files.length > 1 && attrs.multiple ? 2 : 0) + (attrs.accept ? 1 : 0);
      if (!best || score > best.score) best = { loc: el, score };
    }
    if (best) break;
  }
  return best?.loc ?? null;
}

async function clickStop(page: Page, sel: SiteSelectors): Promise<void> {
  const btn = await findVisible(page, sel.stopButton, 0);
  if (btn) await press(btn);
}

export async function isChallenge(page: Page): Promise<boolean> {
  const title = await page.title().catch(() => '');
  if (/just a moment|attention required|verify you are human|un instant/i.test(title)) return true;
  if (page.frames().some((f) => /challenges\.cloudflare\.com/.test(f.url()))) return true;
  const n = await page.locator('#challenge-form, #cf-challenge-running, .cf-turnstile').count().catch(() => 0);
  return n > 0;
}

export async function isRegionBlocked(page: Page): Promise<boolean> {
  const text = await page.evaluate(() => document.body?.innerText.slice(0, 2000) ?? '').catch(() => '');
  return /not available in your (region|country)|unsupported_country/i.test(text);
}

/** Looks for any of the phrases near the end of the page text; returns the surrounding snippet. */
async function findPhrase(page: Page, phrases: string[]): Promise<string | null> {
  if (!phrases.length) return null;
  const text = await page
    .evaluate(() => document.body?.innerText.slice(-4000) ?? '')
    .catch(() => '');
  const lower = text.toLowerCase();
  for (const p of phrases) {
    const i = lower.indexOf(p.toLowerCase());
    if (i >= 0) return text.slice(Math.max(0, i - 40), i + 120).replace(/\s+/g, ' ').trim();
  }
  return null;
}

function findRateLimit(page: Page, sel: SiteSelectors): Promise<string | null> {
  return findPhrase(page, sel.rateLimitPatterns);
}
