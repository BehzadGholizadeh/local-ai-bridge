// Runs the bridge without the desktop UI:
//   node dist/headless.js [--port 8080] [--login chatgpt|grok] [--show]
// Shares settings and browser profiles with the desktop app.
import { PROVIDER_IDS, type ProviderId } from './shared/types';
import { Bridge } from './core/bridge';
import { defaultDataDir } from './core/paths';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const bridge = new Bridge(defaultDataDir());
  const port = arg('port');
  if (port) bridge.settings.update({ port: Number(port) });
  if (process.argv.includes('--show')) bridge.settings.update({ showBrowsers: true });

  bridge.on('status', (s) => {
    console.log(`[status] ${s.name}: ${s.state}${s.detail ? ` — ${s.detail}` : ''}`);
  });
  await bridge.start();

  const login = arg('login');
  if (login) {
    if (!PROVIDER_IDS.includes(login as ProviderId)) throw new Error(`--login must be one of: ${PROVIDER_IDS.join(', ')}`);
    await bridge.providers[login as ProviderId].openLogin();
    console.log(`Sign in to ${login} in the browser window that just opened. Press Ctrl+C when done.`);
  }

  const info = bridge.apiInfo();
  if (info.running) {
    console.log(`\nOpenAI-compatible API: ${info.url}`);
    console.log(`Models: chatgpt, chatgpt/<model-slug>, grok`);
    console.log(`API key: ${bridge.settings.get().apiKey ? '(required, see settings.json)' : '(none)'}\n`);
  } else {
    console.error(`API not running: ${info.error}`);
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log('Shutting down…');
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
