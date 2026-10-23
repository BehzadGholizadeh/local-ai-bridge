import { EventEmitter } from 'node:events';
import { BridgeError } from '../core/errors';
import type { SendPhase } from '../core/provider';
import type { ChatBackend } from './backend';
import type { Permissions } from './permissions';
import {
  followUpPrompt,
  initialPrompt,
  looksLikeToolRefusal,
  parseReply,
  resultsMessage,
  TOOL_REMINDER,
  type CallResult,
} from './protocol';
import { ALL_TOOLS, truncateMiddle, validateArgs, type Tool, type ToolArgs, type ToolContext } from './tools';

/** What the agent is doing, for the CLI / UI activity log. */
export type AgentEvent =
  | { type: 'task'; text: string }
  | { type: 'thinking'; step: number }
  | { type: 'progress'; text: string }
  | { type: 'phase'; phase: SendPhase }
  | { type: 'assistant'; text: string }
  | { type: 'tool_call'; id: string; tool: string; args: ToolArgs; summary: string }
  | { type: 'tool_result'; id: string; tool: string; ok: boolean; output: string; denied?: boolean }
  | { type: 'done'; answer: string; steps: number }
  | { type: 'error'; message: string }
  | { type: 'stopped' };

export interface AgentOptions {
  backend: ChatBackend;
  /** Workspace folder: relative paths and automatic approvals are scoped to it. */
  root: string;
  permissions: Permissions;
  tools?: Tool[];
  /** Model round trips per task before giving up (default 40). */
  maxSteps?: number;
}

/** Results sent back to the model are capped so one huge output can't flood the chat. */
const MAX_RESULT_CHARS = 20_000;
const MAX_FALLBACK_CHARS = 60_000;

/**
 * The agent loop: send the task → parse tool calls from the reply → check permissions → run tools
 * → send the results back in the same web conversation → repeat until a reply has no tool calls.
 * A session keeps its web conversation, so follow-up tasks build on earlier ones.
 */
export class Agent extends EventEmitter {
  private chatUrl?: string;
  private started = false;
  private callCounter = 0;
  /** Everything exchanged so far, to rebuild context if the web conversation is lost. */
  private transcript: { role: 'user' | 'assistant'; text: string }[] = [];
  private readonly tools: Tool[];

  constructor(private opts: AgentOptions) {
    super();
    this.tools = opts.tools ?? ALL_TOOLS;
  }

  get root(): string {
    return this.opts.root;
  }

  private emitEvent(e: AgentEvent): void {
    this.emit('event', e);
  }

  /** Runs one task to completion. Resolves with the final answer; events report the progress. */
  async run(task: string, signal?: AbortSignal): Promise<string> {
    this.emitEvent({ type: 'task', text: task });
    let message = this.started ? followUpPrompt(task) : initialPrompt(task, this.tools, this.opts.root);
    this.started = true;
    const maxSteps = this.opts.maxSteps ?? 40;
    let reminded = false;
    try {
      for (let step = 1; step <= maxSteps; step++) {
        if (signal?.aborted) throw new BridgeError('aborted', 'Stopped.');
        this.emitEvent({ type: 'thinking', step });
        const reply = await this.opts.backend.send({
          prompt: message,
          chatUrl: this.chatUrl,
          fallbackPrompt: this.chatUrl ? this.fallback(message) : undefined,
          signal,
          onProgress: (text) => this.emitEvent({ type: 'progress', text }),
          onPhase: (phase) => this.emitEvent({ type: 'phase', phase }),
        });
        if (reply.chatUrl) this.chatUrl = reply.chatUrl;
        this.transcript.push({ role: 'user', text: message }, { role: 'assistant', text: reply.text });

        const parsed = parseReply(reply.text);
        if (!parsed.calls.length && !parsed.errors.length && !reminded && looksLikeToolRefusal(reply.text)) {
          // The model answered as if it had no tools; remind it once before accepting that.
          reminded = true;
          this.emitEvent({ type: 'assistant', text: `${parsed.prose}\n\n(Reminding the model that it can call tools…)` });
          message = TOOL_REMINDER;
          continue;
        }
        if (!parsed.calls.length && !parsed.errors.length) {
          const answer = parsed.prose || reply.text || '(no reply)';
          this.emitEvent({ type: 'done', answer, steps: step });
          return answer;
        }
        if (parsed.prose) this.emitEvent({ type: 'assistant', text: parsed.prose });
        const results = await this.runCalls(parsed.calls, signal);
        message = resultsMessage(results, parsed.errors);
      }
      const msg = `Stopped after ${maxSteps} steps without finishing. Give a follow-up task to continue.`;
      this.emitEvent({ type: 'error', message: msg });
      return msg;
    } catch (e) {
      const err = BridgeError.from(e);
      if (err.code === 'aborted' || signal?.aborted) {
        this.emitEvent({ type: 'stopped' });
        return 'Stopped.';
      }
      this.emitEvent({ type: 'error', message: err.message });
      throw err;
    }
  }

  private async runCalls(calls: { tool: string; args: ToolArgs }[], signal?: AbortSignal): Promise<CallResult[]> {
    const ctx: ToolContext = { root: this.opts.root, signal };
    const results: CallResult[] = [];
    let denied = false;
    for (const call of calls) {
      const args = call.args && typeof call.args === 'object' ? call.args : {};
      const id = `call-${++this.callCounter}`;
      const tool = this.tools.find((t) => t.name === call.tool);
      const record = (ok: boolean, output: string, wasDenied = false) => {
        results.push({ tool: call.tool, args, ok, output: truncateMiddle(output, MAX_RESULT_CHARS) });
        this.emitEvent({ type: 'tool_result', id, tool: call.tool, ok, output, denied: wasDenied });
      };

      if (!tool) {
        this.emitEvent({ type: 'tool_call', id, tool: call.tool, args, summary: call.tool });
        record(false, `Unknown tool "${call.tool}". Available: ${this.tools.map((t) => t.name).join(', ')}.`);
        continue;
      }
      this.emitEvent({ type: 'tool_call', id, tool: tool.name, args, summary: tool.summarize(args) });
      if (denied) {
        record(false, 'Skipped: an earlier call in this reply was denied by the user.');
        continue;
      }
      const invalid = validateArgs(tool, args);
      if (invalid) {
        record(false, invalid);
        continue;
      }
      if (!(await this.opts.permissions.check(tool, args, ctx))) {
        denied = true;
        record(false, 'The user denied this action. Do not retry it as is; choose another approach or explain what you need.', true);
        continue;
      }
      if (signal?.aborted) throw new BridgeError('aborted', 'Stopped.');
      try {
        const r = await tool.run(args, ctx);
        record(r.ok, r.output);
      } catch (e) {
        record(false, `Tool crashed: ${(e as Error).message}`);
      }
      if (signal?.aborted) throw new BridgeError('aborted', 'Stopped.');
    }
    return results;
  }

  /** Context for a fresh chat if the web conversation is gone: first message, recent turns, new message. */
  private fallback(message: string): string {
    const [first, ...rest] = this.transcript;
    const recent: string[] = [];
    let size = (first?.text.length ?? 0) + message.length;
    for (let i = rest.length - 1; i >= 0; i--) {
      const t = rest[i];
      const line = `${t.role === 'user' ? 'USER' : 'YOU'}:\n${truncateMiddle(t.text, 4000)}`;
      if (size + line.length > MAX_FALLBACK_CHARS) break;
      size += line.length;
      recent.unshift(line);
    }
    return [
      first?.text ?? '',
      '(The earlier chat was lost; this is a reconstruction of the session so far.)',
      ...recent,
      message,
    ].join('\n\n');
  }
}
