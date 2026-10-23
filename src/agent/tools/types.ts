import os from 'node:os';
import path from 'node:path';

/** What a tool can do; decides whether it needs the user's approval. */
export type Risk = 'read' | 'write' | 'exec';

export interface ParamSpec {
  type: 'string' | 'number' | 'boolean';
  description: string;
  required?: boolean;
}

export interface ToolContext {
  /** Workspace root: relative paths resolve here, and it is the boundary for automatic approvals. */
  root: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  /** Text sent back to the model (already truncated to a sensible size). */
  output: string;
}

export type ToolArgs = Record<string, unknown>;

export interface Tool {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  risk: Risk;
  /** Filesystem paths the call touches (absolute), used for the outside-workspace check. */
  paths(args: ToolArgs, ctx: ToolContext): string[];
  /** One line for the approval prompt and the activity log. */
  summarize(args: ToolArgs): string;
  run(args: ToolArgs, ctx: ToolContext): Promise<ToolResult>;
}

/** Resolves a user/model path: `~` is the home directory, relative paths are from the workspace. */
export function resolvePath(root: string, p: unknown): string {
  const raw = String(p ?? '').trim() || '.';
  const expanded = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\') ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.resolve(root, expanded);
}

export function isInside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Checks required params and types; returns an error message or null. */
export function validateArgs(tool: Tool, args: ToolArgs): string | null {
  for (const [name, spec] of Object.entries(tool.params)) {
    const v = args[name];
    if (v === undefined || v === null) {
      if (spec.required) return `Missing required argument "${name}".`;
      continue;
    }
    if (typeof v !== spec.type) return `Argument "${name}" must be a ${spec.type}.`;
  }
  const unknown = Object.keys(args).filter((k) => !(k in tool.params));
  if (unknown.length) return `Unknown argument(s): ${unknown.join(', ')}. Allowed: ${Object.keys(tool.params).join(', ')}.`;
  return null;
}

/** Keeps the start and end of long text, so the model sees both headers and final errors. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 80) / 2);
  return `${text.slice(0, half)}\n\n… [${text.length - 2 * half} characters omitted] …\n\n${text.slice(-half)}`;
}

export const ok = (output: string): ToolResult => ({ ok: true, output });
export const fail = (output: string): ToolResult => ({ ok: false, output });
