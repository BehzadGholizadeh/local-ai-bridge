// local-ai-bridge agent [options] "task"
// Runs the agent in the terminal: ChatGPT or Grok (through the bridge) decides, the tools run here.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { PROVIDER_IDS, type ProviderId } from '../shared/types';
import { Bridge } from '../core/bridge';
import { defaultDataDir } from '../core/paths';
import { Agent, type AgentEvent } from './agent';
import { HttpBackend, ProviderBackend, type ChatBackend } from './backend';
import { PERMISSION_MODES, Permissions, type ApprovalRequest, type Decision, type PermissionMode } from './permissions';

const VALUE_FLAGS = new Set(['provider', 'model', 'cwd', 'mode', 'max-steps', 'port']);

export const AGENT_HELP = `local-ai-bridge agent [options] ["task"]

Runs an agent in this terminal: ChatGPT or Grok plans, and tools (read_file, write_file,
edit_file, list_dir, search, bash) run on this computer. Without a task it asks for one.
After a task finishes you can give follow-up tasks in the same session.

  --provider <chatgpt|grok>   model to use (default chatgpt)
  --model <slug>              ChatGPT model for the new chat, e.g. gpt-4o
  --cwd <folder>              workspace folder (default: current folder)
  --mode <ask|auto-edit|full-auto>
                              ask (default): approve writes, commands, anything outside the workspace
                              auto-edit: workspace writes run without asking; commands still ask
                              full-auto: nothing asks (only for trusted tasks)
  --max-steps <n>             model round trips per task (default 40)
  --in-process                drive the browser here even if the app or "serve" is running
  --port <n>                  port of a running bridge (default: from settings)

Ctrl+C stops the current task; press it again to quit.`;

const tty = process.stdout.isTTY;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c('2');
const bold = c('1');
const cyan = c('36');
const green = c('32');
const red = c('31');
const yellow = c('33');

function parse(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (VALUE_FLAGS.has(name)) flags[name] = argv[++i] ?? '';
      else flags[name] = true;
    } else words.push(a);
  }
  return { flags, task: words.join(' ').trim() };
}

function storedSettings(): { port?: number; apiKey?: string } {
  try {
    return JSON.parse(fs.readFileSync(path.join(defaultDataDir(), 'settings.json'), 'utf8')) as { port?: number; apiKey?: string };
  } catch {
    return {};
  }
}

function indent(text: string, maxLines: number): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  const shown = lines.slice(0, maxLines).map((l) => `    ${l.length > 200 ? `${l.slice(0, 200)}…` : l}`);
  if (lines.length > maxLines) shown.push(dim(`    … ${lines.length - maxLines} more lines`));
  return shown.join('\n');
}

/** What the user should see before approving: the command, the new content, or the edit. */
function preview(req: ApprovalRequest): string {
  const a = req.args;
  if (req.tool === 'write_file') return indent(String(a.content ?? ''), 15);
  if (req.tool === 'edit_file') {
    const minus = String(a.old_string ?? '').split('\n').map((l) => red(`- ${l}`));
    const plus = String(a.new_string ?? '').split('\n').map((l) => green(`+ ${l}`));
    return indent([...minus, ...plus].join('\n'), 20);
  }
  return '';
}

export async function runAgentCli(argv: string[]): Promise<number> {
  const { flags, task: firstTask } = parse(argv);
  if (flags.help) {
    console.log(AGENT_HELP);
    return 0;
  }
  const provider = (flags.provider ?? 'chatgpt') as ProviderId;
  if (!PROVIDER_IDS.includes(provider)) throw new Error(`--provider must be one of: ${PROVIDER_IDS.join(', ')}`);
  const mode = (flags.yolo ? 'full-auto' : (flags.mode ?? 'ask')) as PermissionMode;
  if (!PERMISSION_MODES.includes(mode)) throw new Error(`--mode must be one of: ${PERMISSION_MODES.join(', ')}`);
  const root = path.resolve(typeof flags.cwd === 'string' ? flags.cwd : process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Workspace folder not found: ${root}`);
  const model = typeof flags.model === 'string' ? flags.model : undefined;

  const stored = storedSettings();
  const origin = `http://127.0.0.1:${Number(flags.port ?? stored.port ?? 8080)}`;
  let bridge: Bridge | undefined;
  let backend: ChatBackend;
  if (!flags['in-process'] && (await HttpBackend.probe(origin))) {
    backend = new HttpBackend(origin, process.env.LAB_API_KEY ?? stored.apiKey ?? '', provider, model);
  } else {
    bridge = new Bridge(defaultDataDir(), { quiet: true });
    backend = new ProviderBackend(bridge, provider, model);
  }

  // Lines are queued so answers piped in ahead of time (scripts, tests) are not lost.
  const rl = readline.createInterface({ input: process.stdin, terminal: !!process.stdin.isTTY });
  const lines: string[] = [];
  const waiters: ((line: string | null) => void)[] = [];
  let rlClosed = false;
  rl.on('line', (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    rlClosed = true;
    for (const w of waiters.splice(0)) w(null);
  });
  const ask = (q: string): Promise<string | null> => {
    process.stdout.write(q);
    if (lines.length) {
      const line = lines.shift()!;
      if (!process.stdin.isTTY) process.stdout.write(`${line}\n`);
      return Promise.resolve(line);
    }
    if (rlClosed) {
      process.stdout.write('\n');
      return Promise.resolve(null);
    }
    return new Promise((resolve) => waiters.push(resolve));
  };

  const approver = async (req: ApprovalRequest): Promise<Decision> => {
    clearProgress();
    const where = req.outside ? yellow(' (outside the workspace)') : '';
    console.log(`\n${yellow('?')} ${bold(req.tool)}${where}: ${req.summary}`);
    const p = preview(req);
    if (p) console.log(p);
    for (;;) {
      const answer = (await ask(`  Allow? ${bold('y')}es / ${bold('a')}lways for this session / ${bold('n')}o: `))?.trim().toLowerCase();
      if (answer === null || answer === undefined) return 'deny';
      if (answer === 'y' || answer === 'yes') return 'allow';
      if (answer === 'a' || answer === 'always') return 'always';
      if (answer === 'n' || answer === 'no' || answer === '') return 'deny';
    }
  };

  const permissions = new Permissions(mode, approver);
  const agent = new Agent({ backend, root, permissions, maxSteps: flags['max-steps'] ? Number(flags['max-steps']) : undefined });

  // One status line while waiting on the browser, redrawn every second with the elapsed time.
  let progressShown = false;
  const wait = { step: 0, phase: '', chars: 0, since: 0, timer: undefined as NodeJS.Timeout | undefined };
  const name = provider === 'chatgpt' ? 'ChatGPT' : 'Grok';
  const phaseText = (): string => {
    switch (wait.phase) {
      case 'queued':
        return `waiting for ${name} to finish another request`;
      case 'opening':
        return `opening ${name}`;
      case 'uploading':
        return 'uploading files';
      case 'typing':
        return `typing the message into ${name}`;
      case 'sending':
        return `sending to ${name}`;
      case 'waiting':
        return `waiting for ${name}'s reply`;
      case 'writing':
        return `${name} is writing${wait.chars ? ` (${wait.chars} chars)` : ''}`;
      default:
        return `${name} is working`;
    }
  };
  const drawProgress = () => {
    const secs = Math.round((Date.now() - wait.since) / 1000);
    process.stdout.write(`\r\x1b[K${dim(`  … ${phaseText()} · step ${wait.step} · ${secs}s`)}`);
    progressShown = true;
  };
  const clearProgress = () => {
    if (progressShown && tty) process.stdout.write('\r\x1b[K');
    progressShown = false;
    clearInterval(wait.timer);
    wait.timer = undefined;
  };
  agent.on('event', (e: AgentEvent) => {
    switch (e.type) {
      case 'thinking':
        clearProgress();
        Object.assign(wait, { step: e.step, phase: 'opening', chars: 0, since: Date.now() });
        if (tty) {
          drawProgress();
          wait.timer = setInterval(drawProgress, 1000);
        }
        break;
      case 'phase':
        wait.phase = e.phase;
        if (tty && wait.timer) drawProgress();
        else if (!tty && e.phase !== 'writing') console.log(dim(`  … ${phaseText()}`));
        break;
      case 'progress':
        wait.phase = 'writing';
        wait.chars = e.text.length;
        if (tty && wait.timer) drawProgress();
        break;
      case 'assistant':
        clearProgress();
        console.log(`\n${e.text}`);
        break;
      case 'tool_call':
        clearProgress();
        console.log(`\n${cyan('●')} ${bold(e.tool)} ${dim(e.summary)}`);
        break;
      case 'tool_result':
        console.log(
          e.denied ? red('  ⎿ denied') : `  ${e.ok ? green('⎿') : red('⎿ failed:')}\n${indent(e.output, e.ok ? 6 : 12)}`,
        );
        break;
      case 'done':
        clearProgress();
        console.log(`\n${green('✔')} ${bold('Done')} ${dim(`(${e.steps} step${e.steps === 1 ? '' : 's'})`)}\n${e.answer}\n`);
        break;
      case 'error':
        clearProgress();
        console.log(`\n${red('✖')} ${e.message}\n`);
        break;
      case 'stopped':
        clearProgress();
        console.log(`\n${yellow('■')} Stopped.\n`);
        break;
    }
  });

  console.log(
    `${bold('Local AI Bridge agent')}  ${dim(`brain: ${backend.label} · workspace: ${root} · mode: ${mode}`)}` +
      (mode === 'full-auto' ? `\n${yellow('full-auto: tools run without asking. Stop with Ctrl+C.')}` : ''),
  );

  let current: AbortController | null = null;
  let lastInterrupt = 0;
  process.on('SIGINT', () => {
    if (current && Date.now() - lastInterrupt > 1500) {
      lastInterrupt = Date.now();
      current.abort();
      return;
    }
    process.exit(130);
  });
  rl.on('SIGINT', () => process.emit('SIGINT'));

  let task = firstTask || (await ask(`${bold('Task')}: `))?.trim() || '';
  let failed = false;
  try {
    while (task) {
      current = new AbortController();
      try {
        await agent.run(task, current.signal);
      } catch {
        failed = true; // already reported through the 'error' event
      }
      current = null;
      if (!process.stdin.isTTY) break;
      task = (await ask(`${bold('Next task')} ${dim('(Enter to quit)')}: `))?.trim() ?? '';
    }
  } finally {
    rl.close();
    await bridge?.stop();
  }
  return failed ? 1 : 0;
}
