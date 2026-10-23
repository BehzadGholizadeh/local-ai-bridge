#!/usr/bin/env node
// local-ai-bridge command line: headless server, MCP stdio adapter and selector smoke tests.
import { runServer } from './headless';
import { runMcpStdio } from './mcp-stdio';
import { runSmoke } from './smoke';
import { VERSION } from './core/version';

const HELP = `Local AI Bridge ${VERSION}: ChatGPT and Grok through your own browser sessions.

Usage: local-ai-bridge <command> [options]

Commands:
  serve            Run the bridge without the desktop app (default command)
                     --port <n>          API port (default 8080, saved to settings)
                     --ollama-port <n>   also listen for Ollama clients, e.g. 11434
                     --login <chatgpt|grok>  open the sign-in window
                     --show              keep the browser windows visible
  mcp              MCP over stdio, forwarding to a running bridge
                     --port <n>          bridge port (default: from settings)
  smoke            Check that the site selectors still work
                     --provider <chatgpt|grok>  only one site
                     --send              also send one short test message
                     --profile <temp|app>  fresh guest profile (default) or the app's signed-in one
                     --show  --json
  help, --version

Settings, history and browser profiles live in the same data directory as the desktop app
(override with LAB_DATA_DIR).`;

async function main(): Promise<void> {
  const [command = 'serve', ...rest] = process.argv.slice(2);
  switch (command) {
    case 'serve':
      return runServer(rest);
    case 'mcp':
      return runMcpStdio(rest);
    case 'smoke':
      process.exitCode = await runSmoke(rest);
      return;
    case '--version':
    case '-v':
      console.log(VERSION);
      return;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      // Allow "local-ai-bridge --port 9000" as shorthand for serve.
      if (command.startsWith('--')) return runServer([command, ...rest]);
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
