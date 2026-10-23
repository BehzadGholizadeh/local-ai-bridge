// MCP over stdio, for clients that launch a command instead of connecting to a URL:
//   node dist/mcp-stdio.js [--port 8080]
// It forwards each JSON-RPC message to the /mcp endpoint of the running bridge (desktop app or
// headless server), so the browsers and logins stay in one process. Port and API key come from
// --port / LAB_PORT / LAB_API_KEY, else from the bridge's settings.json.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { defaultDataDir } from './core/paths';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function settings(): { port?: number; apiKey?: string } {
  try {
    return JSON.parse(fs.readFileSync(path.join(defaultDataDir(), 'settings.json'), 'utf8')) as { port?: number; apiKey?: string };
  } catch {
    return {};
  }
}

const stored = settings();
const port = Number(arg('port') ?? process.env.LAB_PORT ?? stored.port ?? 8080);
const apiKey = process.env.LAB_API_KEY ?? stored.apiKey ?? '';
const endpoint = `http://127.0.0.1:${port}/mcp`;

// stdout carries protocol messages only; diagnostics go to stderr.
const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const log = (...a: unknown[]) => console.error('[local-ai-bridge mcp]', ...a);

async function forward(line: string): Promise<void> {
  let msg: { id?: unknown } | unknown[];
  try {
    msg = JSON.parse(line) as { id?: unknown } | unknown[];
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const id = Array.isArray(msg) ? null : (msg.id ?? null);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: line,
    });
    if (res.status === 202) return; // notification accepted
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    process.stdout.write(`${text.trim()}\n`);
  } catch (e) {
    if (id === null || (!Array.isArray(msg) && msg.id === undefined)) {
      log('failed to forward notification:', (e as Error).message);
      return;
    }
    write({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: `Local AI Bridge is not reachable at ${endpoint}. Start the desktop app or "npm run server". (${(e as Error).message})`,
      },
    });
  }
}

log(`forwarding stdio to ${endpoint}`);
const rl = readline.createInterface({ input: process.stdin });
const pending = new Set<Promise<void>>();
rl.on('line', (line) => {
  if (!line.trim()) return;
  const p = forward(line).finally(() => pending.delete(p));
  pending.add(p);
});
// When the client closes stdin, finish in-flight requests and let the process end on its own
// (process.exit() while stdin is closing trips a libuv assertion on Windows).
rl.on('close', () => {
  void Promise.allSettled([...pending]);
});
