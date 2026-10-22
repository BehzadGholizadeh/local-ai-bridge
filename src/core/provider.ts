import { EventEmitter } from 'node:events';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core';
import type { BrowserChannel, ProviderId, ProviderState, ProviderStatus, Settings } from '../shared/types';
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
  signal?: AbortSignal;
  /** Called with the full Markdown of the reply so far, whenever it changes. */
  onUpdate?: (text: string) => void;
}

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
        const ctx = await launchContext(this.deps.profileDir, settings.browserChannel, this.log);
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
        await page.goto(sel.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
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

  async openLogin(): Promise<void> {
    const page = await this.start();
    if (!this.mutex.locked) {
      const sel = this.deps.getSelectors();
      if (!page.url().startsWith(new URL(sel.url).origin)) {
        await page.goto(sel.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      }
    }
    await this.show();
    if (this._status.state !== 'ready' || this._status.guest) {
      this.setStatus(this._status.state, `Sign in to ${this.name} in the browser window, then come back here.`, this._status.guest);
    }
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
    if (this.mutex.locked) this.log.info(`queued (${this.mutex.queued + 1} ahead)`);
    return this.mutex.run(async () => {
      if (opts.signal?.aborted) throw new BridgeError('aborted', 'Request cancelled.');
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
        const baseline = await countEach(page, sel.assistantMessage);
        await typePrompt(page, input, prompt);
        await submit(page, sel, input);
        this.log.info(`prompt sent (${prompt.length} chars)`);
        const msgSelector = await this.waitForReply(page, sel, baseline, opts.signal);
        const result = await this.streamReply(page, sel, msgSelector, opts, timeoutMs);
        const url = page.url();
        const home = new URL(sel.newChatUrl);
        const chatUrl = new URL(url).pathname !== home.pathname ? url : undefined;
        await this.detectState(page, 0).catch(() => undefined);
        return { ...result, chatUrl };
      } catch (e) {
        const err = BridgeError.from(e);
        this.log.warn(`send failed: ${err.code}: ${err.message}`);
        if (err.code === 'rate_limited') this.setStatus('rate_limited', err.message, this._status.guest);
        else if (!page.isClosed()) await this.detectState(page, 0).catch(() => undefined);
        throw err;
      }
    });
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
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
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
      }
      await sleep(250);
    }
    const limit = await findRateLimit(page, sel);
    if (limit) throw new BridgeError('rate_limited', `${this.name} usage limit: "${limit}"`);
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
          opts.onUpdate?.(text);
        }
      }
      const generating = !!(await findVisible(page, sel.stopButton, 0));
      const idle = Date.now() - lastChange;
      if (!generating && text && idle >= sel.stableMs) break;
      if (!generating && !text && idle >= 15_000) break; // e.g. an image-only reply
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
): Promise<BrowserContext> {
  // System Chrome/Edge first: they auto-update and sites trust them more than a bundled Chromium.
  const candidates: (string | undefined)[] =
    pref === 'auto' ? ['chrome', 'msedge', undefined] : [pref === 'chromium' ? undefined : pref];
  let lastError: unknown;
  for (const channel of candidates) {
    try {
      const ctx = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        channel,
        viewport: null,
        args: BROWSER_ARGS,
      });
      log.info(`browser started (${channel ?? 'bundled chromium'})`);
      return ctx;
    } catch (e) {
      lastError = e;
      log.warn(`could not start ${channel ?? 'bundled chromium'}: ${(e as Error).message.split('\n')[0]}`);
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

/** Returns the first visible element matching any selector, polling up to `timeoutMs`. */
async function findVisible(page: Page, selectors: string[], timeoutMs: number): Promise<Locator | null> {
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

async function submit(page: Page, sel: SiteSelectors, input: Locator): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const btn = await findVisible(page, sel.sendButton, 0);
    if (btn && (await btn.isEnabled().catch(() => false)) && (await press(btn))) return;
    await sleep(150);
  }
  await input.press('Enter');
}

async function clickStop(page: Page, sel: SiteSelectors): Promise<void> {
  const btn = await findVisible(page, sel.stopButton, 0);
  if (btn) await press(btn);
}

async function isChallenge(page: Page): Promise<boolean> {
  const title = await page.title().catch(() => '');
  if (/just a moment|attention required|verify you are human|un instant/i.test(title)) return true;
  if (page.frames().some((f) => /challenges\.cloudflare\.com/.test(f.url()))) return true;
  const n = await page.locator('#challenge-form, #cf-challenge-running, .cf-turnstile').count().catch(() => 0);
  return n > 0;
}

async function isRegionBlocked(page: Page): Promise<boolean> {
  const text = await page.evaluate(() => document.body?.innerText.slice(0, 2000) ?? '').catch(() => '');
  return /not available in your (region|country)|unsupported_country/i.test(text);
}

async function findRateLimit(page: Page, sel: SiteSelectors): Promise<string | null> {
  const text = await page
    .evaluate(() => document.body?.innerText.slice(-4000) ?? '')
    .catch(() => '');
  const lower = text.toLowerCase();
  for (const p of sel.rateLimitPatterns) {
    const i = lower.indexOf(p.toLowerCase());
    if (i >= 0) return text.slice(Math.max(0, i - 40), i + 120).replace(/\s+/g, ' ').trim();
  }
  return null;
}
