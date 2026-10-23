import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fail, ok, resolvePath, truncateMiddle, type Tool } from './types';

const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 600;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_BUFFER_CHARS = 2_000_000;

/** The shell the `bash` tool really uses on this machine (told to the model in the system prompt). */
export function shellInfo(): { name: string; command: string; args: (cmd: string) => string[] } {
  if (process.platform === 'win32') {
    return {
      name: 'Windows PowerShell',
      command: 'powershell.exe',
      // UTF-8 output so non-ASCII text survives; no profile so the user's prompt scripts don't interfere.
      args: (cmd) => [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ${cmd}`,
      ],
    };
  }
  const sh = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/bash';
  return { name: sh.split('/').pop() ?? 'bash', command: sh, args: (cmd) => ['-c', cmd] };
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

export const bash: Tool = {
  name: 'bash',
  description:
    `Run a shell command and return its exit code and combined output (truncated to ${MAX_OUTPUT_CHARS} characters). ` +
    'On Windows this is PowerShell, elsewhere bash. Commands cannot be interactive (no prompts, no editors). ' +
    'Use it for things the file tools cannot do: running programs or scripts, git, installing packages, converting or editing Office/binary files with a script.',
  params: {
    command: { type: 'string', description: 'The command line to run', required: true },
    cwd: { type: 'string', description: 'Working directory (default: the workspace)' },
    timeout_sec: { type: 'number', description: `Time limit in seconds (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC})` },
  },
  risk: 'exec',
  paths: (args, ctx) => [resolvePath(ctx.root, args.cwd)],
  summarize: (args) => `$ ${String(args.command)}${args.cwd ? `   (in ${String(args.cwd)})` : ''}`,
  run(args, ctx) {
    const cwd = resolvePath(ctx.root, args.cwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return Promise.resolve(fail(`Working directory not found: ${cwd}`));
    const timeoutSec = Math.min(MAX_TIMEOUT_SEC, Math.max(1, Number(args.timeout_sec ?? DEFAULT_TIMEOUT_SEC)));
    const shell = shellInfo();

    return new Promise((resolve) => {
      const child = spawn(shell.command, shell.args(String(args.command)), {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32', // own process group, so the whole tree can be killed
      });
      let output = '';
      let dropped = false;
      const append = (chunk: Buffer) => {
        if (output.length < MAX_BUFFER_CHARS) output += chunk.toString('utf8');
        else dropped = true;
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);

      let reason: 'timeout' | 'aborted' | null = null;
      const stop = (why: 'timeout' | 'aborted') => {
        reason = why;
        if (child.pid) killTree(child.pid);
      };
      const timer = setTimeout(() => stop('timeout'), timeoutSec * 1000);
      const onAbort = () => stop('aborted');
      ctx.signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (code: number | null, error?: Error) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        if (error) return resolve(fail(`Could not start ${shell.name}: ${error.message}`));
        let text = truncateMiddle(output.replace(/\r\n/g, '\n').trimEnd(), MAX_OUTPUT_CHARS);
        if (dropped) text += '\n[Output exceeded the buffer; the middle was dropped.]';
        const head =
          reason === 'timeout'
            ? `Timed out after ${timeoutSec}s and was stopped.`
            : reason === 'aborted'
              ? 'Stopped by the user.'
              : `Exit code: ${code ?? 'unknown'}`;
        const result = `${head}\n${text || '(no output)'}`;
        resolve(code === 0 && !reason ? ok(result) : fail(result));
      };
      child.on('error', (e) => finish(null, e));
      child.on('close', (code) => finish(code));
    });
  },
};
