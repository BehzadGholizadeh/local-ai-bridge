import fs from 'node:fs';
import path from 'node:path';
import { fail, ok, resolvePath, type Tool } from './types';

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 20_000;
const DEFAULT_RESULTS = 100;

/** Simple glob on the file name or relative path: *, ? and ** are supported. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

export const search: Tool = {
  name: 'search',
  description:
    'Search file contents with a regular expression (case-insensitive). Returns "path:line: text" matches. ' +
    'Skips binary files, files over 1 MB and folders like node_modules and .git.',
  params: {
    pattern: { type: 'string', description: 'JavaScript regular expression to look for', required: true },
    path: { type: 'string', description: 'Folder (or file) to search (default: the workspace)' },
    glob: { type: 'string', description: 'Only files matching this glob, e.g. "*.ts" or "src/**/*.py"' },
    max_results: { type: 'number', description: `Maximum matches to return (default ${DEFAULT_RESULTS})` },
  },
  risk: 'read',
  paths: (args, ctx) => [resolvePath(ctx.root, args.path)],
  summarize: (args) => `search /${String(args.pattern)}/${args.glob ? ` in ${String(args.glob)}` : ''}${args.path ? ` under ${String(args.path)}` : ''}`,
  async run(args, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(String(args.pattern), 'i');
    } catch (e) {
      return fail(`Invalid regular expression: ${(e as Error).message}`);
    }
    const base = resolvePath(ctx.root, args.path);
    const glob = typeof args.glob === 'string' && args.glob ? globToRegExp(args.glob.replace(/\\/g, '/')) : null;
    const max = Math.min(500, Math.max(1, Math.trunc(Number(args.max_results ?? DEFAULT_RESULTS))));
    const results: string[] = [];
    let scanned = 0;

    const visit = (file: string) => {
      const rel = path.relative(base, file).replace(/\\/g, '/') || path.basename(file);
      if (glob && !glob.test(rel) && !glob.test(path.basename(file))) return;
      let buf: Buffer;
      try {
        if (fs.statSync(file).size > MAX_FILE_BYTES) return;
        buf = fs.readFileSync(file);
      } catch {
        return;
      }
      if (buf.subarray(0, 8192).includes(0)) return;
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < max; i++) {
        if (re.test(lines[i])) results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
      }
    };
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (results.length >= max || scanned >= MAX_FILES) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(full);
        } else if (e.isFile()) {
          scanned++;
          visit(full);
        }
      }
    };

    let stat: fs.Stats;
    try {
      stat = fs.statSync(base);
    } catch {
      return fail(`Not found: ${base}`);
    }
    if (stat.isFile()) visit(base);
    else walk(base);
    if (!results.length) return ok(`No matches (${scanned} files searched).`);
    const capped = results.length >= max ? `\n[Stopped at ${max} matches.]` : '';
    return ok(`${results.join('\n')}${capped}`);
  },
};
