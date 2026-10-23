// Runs the bridge without the desktop UI:
//   local-ai-bridge serve [--port 8080] [--ollama-port 11434] [--login chatgpt|grok] [--show]
//   (or: node dist/headless.js ...)
// Shares settings and browser profiles with the desktop app.
import { PROVIDER_IDS, type ProviderId } from './shared/types';
import { Args } from './cliargs';
import { Bridge } from './core/bridge';
import { defaultDataDir } from './core/paths';

export async function runServer(argv: string[]): Promise<void> {
  const args = new Args(argv);
  const bridge = new Bridge(defaultDataDir());
  const port = args.value('port');
  if (port) bridge.settings.update({ port: Number(port) });
  const ollamaPort = args.value('ollama-port');
  if (ollamaPort) bridge.settings.update({ ollamaPort: Number(ollamaPort) });
  if (args.has('show')) bridge.settings.update({ showBrowsers: true });

  bridge.on('status', (s) => {
    console.log(`[status] ${s.name}: ${s.state}${s.detail ? ` — ${s.detail}` : ''}`);
  });
  await bridge.start();

  const login = args.value('login');
  if (login) {
    if (!PROVIDER_IDS.includes(login as ProviderId)) throw new Error(`--login must be one of: ${PROVIDER_IDS.join(', ')}`);
    await bridge.providers[login as ProviderId].openLogin();
    console.log(`Sign in to ${login} in the browser window that just opened, then close that window.`);
  }

  const info = bridge.apiInfo();
  if (info.running) {
    console.log(`\nOpenAI-compatible API: ${info.url}`);
    console.log(`MCP server:            ${info.url.replace(/\/v1$/, '/mcp')}`);
    console.log(`Ollama-compatible API: ${info.ollamaUrl}`);
    console.log(`Models: chatgpt, chatgpt/<model-slug>, grok`);
    if (info.error) console.warn(info.error);
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

if (require.main === module) {
  runServer(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
