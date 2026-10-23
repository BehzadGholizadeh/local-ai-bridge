import fs from 'node:fs';
import path from 'node:path';
import { fail, ok, resolvePath, type Tool } from './types';

const MAX_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_READ_CHARS = 100_000;

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

function describeError(e: unknown, p: string): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return `Not found: ${p}`;
  if (code === 'EACCES' || code === 'EPERM') return `Permission denied: ${p}`;
  if (code === 'EISDIR') return `Is a directory: ${p} (use list_dir)`;
  if (code === 'EBUSY') return `File is locked by another program: ${p}`;
  return `${(e as Error).message}`;
}

export const readFile: Tool = {
  name: 'read_file',
  description:
    'Read a text file. Returns numbered lines ("  12\\tcontent"). Use offset/limit for large files. ' +
    'Binary files (images, .docx, .pptx, .xlsx, .pdf) cannot be read this way: use bash with a suitable tool or script.',
  params: {
    path: { type: 'string', description: 'File path, absolute or relative to the workspace', required: true },
    offset: { type: 'number', description: 'First line to read, 1-based (default 1)' },
    limit: { type: 'number', description: `Number of lines to read (default and max ${MAX_READ_LINES})` },
  },
  risk: 'read',
  paths: (args, ctx) => [resolvePath(ctx.root, args.path)],
  summarize: (args) => `read ${String(args.path)}${args.offset ? ` from line ${String(args.offset)}` : ''}`,
  async run(args, ctx) {
    const p = resolvePath(ctx.root, args.path);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(p);
    } catch (e) {
      return fail(describeError(e, p));
    }
    if (isBinary(buf)) return fail(`${p} is a binary file (${buf.length} bytes). Use bash to inspect or convert it.`);
    const lines = buf.toString('utf8').split(/\r?\n/);
    const offset = Math.max(1, Math.trunc(Number(args.offset ?? 1)));
    const limit = Math.min(MAX_READ_LINES, Math.max(1, Math.trunc(Number(args.limit ?? MAX_READ_LINES))));
    if (offset > lines.length) return fail(`${p} has only ${lines.length} lines.`);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    let out = '';
    let shown = 0;
    for (const [i, line] of slice.entries()) {
      const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} … [line truncated]` : line;
      const row = `${String(offset + i).padStart(6)}\t${text}\n`;
      if (out.length + row.length > MAX_READ_CHARS) break;
      out += row;
      shown++;
    }
    const end = offset + shown - 1;
    const more = end < lines.length ? `\n[Showing lines ${offset}-${end} of ${lines.length}. Use offset=${end + 1} to read more.]` : '';
    return ok((out || '(empty file)\n') + more);
  },
};

export const writeFile: Tool = {
  name: 'write_file',
  description: 'Create or overwrite a text file with the given content. Creates missing parent folders.',
  params: {
    path: { type: 'string', description: 'File path, absolute or relative to the workspace', required: true },
    content: { type: 'string', description: 'The full new content of the file', required: true },
  },
  risk: 'write',
  paths: (args, ctx) => [resolvePath(ctx.root, args.path)],
  summarize: (args) => `write ${String(args.path)} (${String(args.content ?? '').length} chars)`,
  async run(args, ctx) {
    const p = resolvePath(ctx.root, args.path);
    const existed = fs.existsSync(p);
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(args.content));
    } catch (e) {
      return fail(describeError(e, p));
    }
    return ok(`${existed ? 'Overwrote' : 'Created'} ${p} (${Buffer.byteLength(String(args.content))} bytes).`);
  },
};

export const editFile: Tool = {
  name: 'edit_file',
  description:
    'Replace an exact piece of text in a file. old_string must match the file exactly (including whitespace) and be unique, ' +
    'unless replace_all is true. Read the file first.',
  params: {
    path: { type: 'string', description: 'File path, absolute or relative to the workspace', required: true },
    old_string: { type: 'string', description: 'Exact text to replace', required: true },
    new_string: { type: 'string', description: 'Replacement text', required: true },
    replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
  },
  risk: 'write',
  paths: (args, ctx) => [resolvePath(ctx.root, args.path)],
  summarize: (args) => `edit ${String(args.path)}`,
  async run(args, ctx) {
    const p = resolvePath(ctx.root, args.path);
    let text: string;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (e) {
      return fail(describeError(e, p));
    }
    const oldStr = String(args.old_string);
    const newStr = String(args.new_string);
    if (!oldStr) return fail('old_string must not be empty (use write_file to create a file).');
    if (oldStr === newStr) return fail('old_string and new_string are identical.');
    // Files with Windows line endings: also match the model's "\n" text.
    let source = text;
    let crlf = false;
    if (!text.includes(oldStr) && text.includes('\r\n') && !oldStr.includes('\r\n')) {
      source = text.replace(/\r\n/g, '\n');
      crlf = true;
    }
    const count = source.split(oldStr).length - 1;
    if (count === 0) return fail(`old_string was not found in ${p}. Read the file and copy the text exactly.`);
    if (count > 1 && !args.replace_all) {
      return fail(`old_string occurs ${count} times in ${p}. Add surrounding text to make it unique, or set replace_all.`);
    }
    let updated = args.replace_all ? source.split(oldStr).join(newStr) : source.replace(oldStr, () => newStr);
    if (crlf) updated = updated.replace(/\r?\n/g, '\r\n');
    try {
      fs.writeFileSync(p, updated);
    } catch (e) {
      return fail(describeError(e, p));
    }
    return ok(`Edited ${p}: replaced ${args.replace_all ? count : 1} occurrence(s).`);
  },
};

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next']);
const MAX_ENTRIES = 500;

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const listDir: Tool = {
  name: 'list_dir',
  description: `List a folder's contents (folders end with "/", files show their size). depth 2-3 lists subfolders too, skipping ${[...SKIP_DIRS].slice(0, 3).join(', ')} and similar.`,
  params: {
    path: { type: 'string', description: 'Folder path (default: the workspace)' },
    depth: { type: 'number', description: 'How many levels to list, 1-3 (default 1)' },
  },
  risk: 'read',
  paths: (args, ctx) => [resolvePath(ctx.root, args.path)],
  summarize: (args) => `list ${String(args.path ?? '.')}${args.depth && Number(args.depth) > 1 ? ` (depth ${String(args.depth)})` : ''}`,
  async run(args, ctx) {
    const root = resolvePath(ctx.root, args.path);
    const depth = Math.min(3, Math.max(1, Math.trunc(Number(args.depth ?? 1))));
    const lines: string[] = [];
    let truncated = false;
    const walk = (dir: string, level: number) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        if (level === 0) throw e;
        lines.push(`${'  '.repeat(level)}(cannot read: ${(e as Error).message})`);
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (lines.length >= MAX_ENTRIES) {
          truncated = true;
          return;
        }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          const skip = SKIP_DIRS.has(e.name);
          lines.push(`${'  '.repeat(level)}${e.name}/${skip && level + 1 < depth ? '  (not expanded)' : ''}`);
          if (level + 1 < depth && !skip) walk(full, level + 1);
        } else {
          let size = '';
          try {
            size = formatSize(fs.statSync(full).size);
          } catch {
            // broken link or locked file
          }
          lines.push(`${'  '.repeat(level)}${e.name}${size ? `  (${size})` : ''}`);
        }
      }
    };
    try {
      walk(root, 0);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return fail(code === 'ENOENT' ? `Not found: ${root}` : code === 'ENOTDIR' ? `Not a folder: ${root}` : (e as Error).message);
    }
    return ok(`${root}\n${lines.join('\n') || '(empty folder)'}${truncated ? `\n[Stopped after ${MAX_ENTRIES} entries.]` : ''}`);
  },
};
