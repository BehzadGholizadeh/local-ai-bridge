// Selector smoke tests: checks that the current selectors (built-in defaults plus any overrides
// in the selectors folder) still match chatgpt.com / grok.com.
//   local-ai-bridge smoke [--provider chatgpt|grok] [--send] [--profile temp|app] [--show] [--json]
//
// Without --send nothing is sent: it checks the page loads, the message box and send button are
// found (by typing and then clearing a word), and the file input exists. --send also sends one
// short message, which exercises the reply, stop-button and Markdown selectors end to end.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDER_IDS, PROVIDER_NAMES, type BrowserChannel, type ProviderId } from './shared/types';
import { Args } from './cliargs';
import { BridgeError } from './core/errors';
import { Logger } from './core/logger';
import { defaultDataDir } from './core/paths';
import { findVisible, isChallenge, isRegionBlocked, WebChatProvider } from './core/provider';
import { SelectorStore, type SiteSelectors } from './core/selectors';
import { DEFAULT_SETTINGS } from './core/settings';

type Outcome = 'pass' | 'fail' | 'warn' | 'skip';

interface Check {
  name: string;
  outcome: Outcome;
  detail: string;
}

interface Report {
  provider: ProviderId;
  url: string;
  profile: 'temp' | 'app';
  checks: Check[];
  ok: boolean;
}

const ICON: Record<Outcome, string> = { pass: '✓', fail: '✗', warn: '!', skip: '–' };

/** First selector in the list with a visible match (each tried separately so we can name it). */
async function firstMatching(page: import('playwright-core').Page, selectors: string[], waitMs: number): Promise<string | null> {
  if (!(await findVisible(page, selectors, waitMs))) return null;
  for (const s of selectors) if (await findVisible(page, [s], 0)) return s;
  return null;
}

async function smokeOne(
  id: ProviderId,
  sel: SiteSelectors,
  opts: { send: boolean; profile: 'temp' | 'app'; show: boolean; channel: BrowserChannel },
): Promise<Report> {
  const checks: Check[] = [];
  const add = (name: string, outcome: Outcome, detail: string) => checks.push({ name, outcome, detail });
  const tempDir = opts.profile === 'temp' ? fs.mkdtempSync(path.join(os.tmpdir(), `lab-smoke-${id}-`)) : undefined;
  const profileDir = tempDir ?? path.join(defaultDataDir(), 'profiles', id);
  const provider = new WebChatProvider(id, PROVIDER_NAMES[id], {
    profileDir,
    getSettings: () => ({ ...DEFAULT_SETTINGS, showBrowsers: opts.show, browserChannel: opts.channel, responseTimeoutSec: 120 }),
    getSelectors: () => sel,
    log: new Logger(false),
  });

  try {
    let page;
    try {
      page = await provider.start();
    } catch (e) {
      add('page', 'fail', BridgeError.from(e).message);
      return { provider: id, url: sel.url, profile: opts.profile, checks, ok: false };
    }

    const status = provider.status;
    if (await isRegionBlocked(page)) add('page', 'fail', 'site says it is not available in your region');
    else if (status.state === 'challenge' || (await isChallenge(page))) add('page', 'fail', 'security check shown (Cloudflare)');
    else add('page', 'pass', `${status.state}${status.guest ? ' (guest)' : ''}`);

    const input = await firstMatching(page, sel.input, 10_000);
    add('input', input ? 'pass' : 'fail', input ?? `none of: ${sel.input.join(' | ')}`);

    if (input) {
      // The send button usually appears or enables only once there is text.
      const box = page.locator(input).first();
      await box.fill('smoke test').catch(() => undefined);
      const send = await firstMatching(page, sel.sendButton, 3_000);
      add('sendButton', send ? 'pass' : 'fail', send ?? `none of: ${sel.sendButton.join(' | ')}`);
      await box.fill('').catch(() => undefined);
    } else {
      add('sendButton', 'skip', 'needs the message box');
    }

    const inputs: string[] = [];
    for (const s of sel.fileInput) {
      const loc = page.locator(s);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) inputs.push((await loc.nth(i).getAttribute('accept').catch(() => null)) || 'any file');
      if (n) break;
    }
    add(
      'fileInput',
      inputs.length ? 'pass' : 'warn',
      inputs.length ? `${inputs.length} input(s): ${[...new Set(inputs)].join('; ').slice(0, 120)}` : 'no file input found (uploads unavailable)',
    );

    const signedOut = !!(await findVisible(page, sel.loggedOutMarkers, 0));
    add('signedIn', 'skip', signedOut ? 'no (signed out / guest)' : 'yes, or loggedOutMarkers no longer match');

    if (!opts.send) {
      add('roundTrip', 'skip', 'run with --send to check replies (assistantMessage, assistantContent, stopButton)');
    } else if (!input) {
      add('roundTrip', 'skip', 'needs the message box');
    } else {
      const started = Date.now();
      try {
        const r = await provider.send({ prompt: 'This is an automated connectivity check. Reply with exactly one word: pong' });
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        add(
          'roundTrip',
          /pong/i.test(r.text) ? 'pass' : 'fail',
          /pong/i.test(r.text) ? `reply "${r.text.slice(0, 40)}" in ${secs}s` : `unexpected reply: "${r.text.slice(0, 80)}"`,
        );
      } catch (e) {
        const err = BridgeError.from(e);
        // A sign-in wall or usage limit is the site's policy, not broken selectors.
        const policy = err.code === 'logged_out' || err.code === 'rate_limited';
        add(
          'roundTrip',
          policy ? 'warn' : 'fail',
          policy && opts.profile === 'temp'
            ? `${err.message} Re-run with --profile app (app closed) to test with your account.`
            : `${err.code}: ${err.message}`,
        );
      }
    }
  } finally {
    await provider.stop();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
  return { provider: id, url: sel.url, profile: opts.profile, checks, ok: !checks.some((c) => c.outcome === 'fail') };
}

export async function runSmoke(argv: string[]): Promise<number> {
  const args = new Args(argv);
  const only = args.value('provider');
  if (only && !PROVIDER_IDS.includes(only as ProviderId)) throw new Error(`--provider must be one of: ${PROVIDER_IDS.join(', ')}`);
  const profile = args.value('profile') === 'app' ? 'app' : 'temp';
  const channel = (args.value('channel') ?? 'auto') as BrowserChannel;
  const selectors = new SelectorStore(path.join(defaultDataDir(), 'selectors'), new Logger(false));
  const ids = only ? [only as ProviderId] : PROVIDER_IDS;

  const reports: Report[] = [];
  for (const id of ids) {
    if (!args.has('json')) console.log(`\n${PROVIDER_NAMES[id]} (${selectors.get(id).url}) — ${profile === 'temp' ? 'fresh temporary profile' : 'app profile'}`);
    const report = await smokeOne(id, selectors.get(id), { send: args.has('send'), profile, show: args.has('show'), channel });
    reports.push(report);
    if (!args.has('json')) {
      for (const c of report.checks) console.log(`  ${ICON[c.outcome]} ${c.name.padEnd(11)} ${c.detail}`);
    }
  }
  const ok = reports.every((r) => r.ok);
  if (args.has('json')) console.log(JSON.stringify({ ok, reports }, null, 2));
  else {
    console.log(ok ? '\nAll required checks passed.' : '\nSome checks failed. See docs/SELECTORS.md to update the selectors.');
    if (profile === 'app') console.log('(Used the app\'s signed-in profiles: close the app first, or use the default --profile temp.)');
  }
  return ok ? 0 : 1;
}

if (require.main === module) {
  runSmoke(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(2);
    },
  );
}
