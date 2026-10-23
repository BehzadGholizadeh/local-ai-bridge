import { EventEmitter } from 'node:events';
import { BridgeError } from '../core/errors';
import type { SendPhase } from '../core/provider';
import type { ChatBackend } from './backend';
import type { Permissions } from './permissions';
import {
  followUpPrompt,
  groundingCorrection,
  initialPrompt,
  mentionsFiles,
  mentionsSandbox,
  taskTargets,
  targetVisited,
  unseenFileNames,
  unvisitedTargetCorrection,
  unseenFilesCorrection,
  NUDGE,
  parseReply,
  resultsMessage,
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
  /** executed: the tool really ran (false when denied, invalid or unknown). */
  | { type: 'tool_result'; id: string; tool: string; ok: boolean; output: string; denied?: boolean; executed: boolean }
  /** toolRuns: tools that ran for this task; grounded: false if the answer is text-only about files. */
  | { type: 'done'; answer: string; steps: number; toolRuns: number; grounded: boolean }
  /** Something the agent did on its own, e.g. re-prompting the model. */
  | { type: 'note'; text: string }
  /** One round trip with the model: the exact message sent and the raw reply (for the run log). */
  | { type: 'exchange'; step: number; prompt: string; reply: string; chatUrl?: string }
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
/** Re-prompts per task when a reply has neither a tool call nor "DONE:". */
const MAX_NUDGES = 2;
/** Consecutive replies whose tool blocks can't be read before giving up. */
const MAX_PROTOCOL_ERRORS = 3;

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
    const maxSteps = this.opts.maxSteps ?? 40;
    let nudges = 0;
    let protocolErrors = 0;
    /** Tools that actually ran for this task (by the model, or the controller's workspace listing). */
    let toolRuns = 0;
    /** All tool output of this task, to check that file names in the answer were really seen. */
    let seenOutput = '';
    /** Places the task names (drives, absolute paths) and the tool calls that really ran. */
    const targets = taskTargets(task);
    const executedCalls: { args: ToolArgs }[] = [];
    let targetNudges = 0;
    try {
      let message: string;
      if (this.started) {
        message = followUpPrompt(task);
      } else {
        // Ground the model in the real workspace before it says anything: list it here and put the
        // listing in the first message, so it has no reason to imagine a sandbox filesystem.
        this.emitEvent({ type: 'note', text: 'Listing the workspace first, so the model sees your real files…' });
        const [listing] = await this.runCalls([{ tool: 'list_dir', args: { path: '.' } }], signal);
        if (listing?.ok) {
          toolRuns++;
          seenOutput += listing.output;
        }
        message = initialPrompt(task, this.tools, this.opts.root, listing?.ok ? listing.output : undefined);
      }
      this.started = true;
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
        this.emitEvent({ type: 'exchange', step, prompt: message, reply: reply.text, chatUrl: this.chatUrl });

        const parsed = parseReply(reply.text);
        if (!parsed.calls.length && !parsed.errors.length) {
          // No tool call. Accept it as the final answer only if it says "DONE:" and is grounded:
          // no sandbox paths, and no claims about files unless a tool has actually run.
          const sandbox = mentionsSandbox(reply.text);
          // The task names a drive or path that no executed tool has looked at yet.
          const unvisited = parsed.done ? targets.filter((t) => !targetVisited(t, executedCalls)) : [];
          if (unvisited.length && targetNudges < MAX_NUDGES) {
            targetNudges++;
            if (parsed.prose) this.emitEvent({ type: 'assistant', text: parsed.prose });
            this.emitEvent({ type: 'note', text: `The model answered without looking at ${unvisited.join(', ')}: asking it to list it for real…` });
            message = unvisitedTargetCorrection(unvisited);
            continue;
          }
          const unseen = parsed.done ? unseenFileNames(parsed.prose, seenOutput, this.opts.root) : [];
          const ungrounded = sandbox || (toolRuns === 0 && mentionsFiles(reply.text)) || unvisited.length > 0;
          if (parsed.done && !ungrounded && unseen.length && nudges < MAX_NUDGES) {
            nudges++;
            this.emitEvent({ type: 'note', text: `The answer names files no tool ever showed (${unseen.slice(0, 3).join(', ')}): asking the model to check…` });
            message = unseenFilesCorrection(unseen);
            continue;
          }
          if ((parsed.done && !ungrounded && !unseen.length) || nudges >= MAX_NUDGES) {
            const answer = parsed.prose || reply.text || '(no reply)';
            this.emitEvent({ type: 'done', answer, steps: step, toolRuns, grounded: !ungrounded && !unseen.length && (parsed.done || toolRuns > 0) });
            return answer;
          }
          nudges++;
          if (parsed.prose) this.emitEvent({ type: 'assistant', text: parsed.prose });
          this.emitEvent({
            type: 'note',
            text: sandbox
              ? 'The model answered from its own sandbox (paths like /mnt/data or /openai), not your computer: correcting it and asking for a real tool call…'
              : ungrounded
                ? 'The model talked about files without running any tool: asking for a real tool call…'
                : 'No tool call and no "DONE:" in that reply: asking the model to request a tool…',
          });
          message = sandbox || ungrounded ? groundingCorrection(this.opts.root, sandbox) : NUDGE;
          continue;
        }
        if (!parsed.calls.length) {
          // Only unreadable tool blocks: send the errors back, but don't loop forever on them.
          if (++protocolErrors > MAX_PROTOCOL_ERRORS) {
            throw new BridgeError('internal', `The model's tool requests could not be read ${MAX_PROTOCOL_ERRORS} times in a row: ${parsed.errors[0]}`);
          }
          this.emitEvent({ type: 'note', text: `Could not read the tool request (${parsed.errors[0]}); asking the model to fix it…` });
        } else protocolErrors = 0;
        if (parsed.prose) this.emitEvent({ type: 'assistant', text: parsed.prose });
        const results = await this.runCalls(parsed.calls, signal);
        toolRuns += results.filter((r) => r.executed).length;
        executedCalls.push(...results.filter((r) => r.executed));
        seenOutput += results.map((r) => r.output).join('\n');
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
      const record = (ok: boolean, output: string, wasDenied = false, executed = false) => {
        results.push({ tool: call.tool, args, ok, executed, output: truncateMiddle(output, MAX_RESULT_CHARS) });
        this.emitEvent({ type: 'tool_result', id, tool: call.tool, ok, output, denied: wasDenied, executed });
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
        record(r.ok, r.output, false, true);
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
