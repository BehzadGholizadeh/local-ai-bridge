import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { AgentDecision, AgentEventPatch, AgentStartInput, AgentUiEvent, ProviderId } from '../shared/types';
import type { Bridge } from '../core/bridge';
import { BridgeError } from '../core/errors';
import { Agent, type AgentEvent } from '../agent/agent';
import { ProviderBackend } from '../agent/backend';
import { Permissions, type ApprovalRequest } from '../agent/permissions';
import { attachRunLog } from '../agent/runlog';

const MAX_UI_OUTPUT = 20_000;
const PROGRESS_INTERVAL_MS = 250;

interface Session {
  id: string;
  workspace: string;
  provider: ProviderId;
  agent: Agent;
  permissions: Permissions;
  running?: AbortController;
}

/**
 * Agent sessions for the desktop app. Tools run in the main process; approvals are asked in the
 * renderer and answered through approve(). A session keeps its web conversation, so follow-up
 * tasks continue where the last one stopped.
 */
export class AgentService {
  private sessions = new Map<string, Session>();
  private approvals = new Map<string, { sessionId: string; resolve: (d: AgentDecision) => void }>();

  constructor(
    private bridge: Bridge,
    private emit: (patch: AgentEventPatch) => void,
  ) {}

  start(input: AgentStartInput): { sessionId: string } {
    const task = input.task.trim();
    if (!task) throw new BridgeError('bad_request', 'Describe a task first.');
    if (!fs.existsSync(input.workspace) || !fs.statSync(input.workspace).isDirectory()) {
      throw new BridgeError('bad_request', `Workspace folder not found: ${input.workspace}`);
    }
    let session = input.sessionId ? this.sessions.get(input.sessionId) : undefined;
    if (session && (session.workspace !== input.workspace || session.provider !== input.provider)) session = undefined;
    if (session?.running) throw new BridgeError('busy', 'The agent is still working. Stop it or wait.');
    if (!session) session = this.create(input);
    session.permissions.mode = input.mode;
    const s = session;
    // Start after this call has returned, so the renderer knows the session id before events arrive.
    setImmediate(() => void this.run(s, task));
    return { sessionId: session.id };
  }

  stop(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    s?.running?.abort();
    // Pending approvals of a stopped run are answered "deny" so the loop can unwind.
    for (const [id, a] of this.approvals) {
      if (a.sessionId === sessionId) {
        this.approvals.delete(id);
        a.resolve('deny');
        this.emit({ sessionId, event: { type: 'approval_resolved', requestId: id, decision: 'deny' } });
      }
    }
  }

  approve(requestId: string, decision: AgentDecision): void {
    const a = this.approvals.get(requestId);
    if (!a) return;
    this.approvals.delete(requestId);
    a.resolve(decision);
    this.emit({ sessionId: a.sessionId, event: { type: 'approval_resolved', requestId, decision } });
  }

  setMode(sessionId: string, mode: AgentStartInput['mode']): void {
    const s = this.sessions.get(sessionId);
    if (s) s.permissions.mode = mode;
  }

  stopAll(): void {
    for (const id of this.sessions.keys()) this.stop(id);
  }

  private create(input: AgentStartInput): Session {
    const id = randomUUID();
    const permissions = new Permissions(input.mode, (req) => this.ask(id, req));
    const settings = this.bridge.settings.get();
    const backend = new ProviderBackend(
      this.bridge,
      input.provider,
      input.provider === 'chatgpt' ? settings.chatgptModel || undefined : undefined,
    );
    const agent = new Agent({ backend, root: input.workspace, permissions });
    const session: Session = { id, workspace: input.workspace, provider: input.provider, agent, permissions };
    let lastProgress = 0;
    const logFile = attachRunLog(agent, this.bridge.dataDir, input.provider);
    this.bridge.log.info(`agent session log: ${logFile}`);
    agent.on('event', (e: AgentEvent) => {
      if (e.type === 'exchange') return; // run log only
      if (e.type === 'progress') {
        const now = Date.now();
        if (now - lastProgress < PROGRESS_INTERVAL_MS) return;
        lastProgress = now;
        this.emit({ sessionId: id, event: { type: 'progress', chars: e.text.length } });
        return;
      }
      const event: AgentUiEvent =
        e.type === 'tool_result' && e.output.length > MAX_UI_OUTPUT
          ? { ...e, output: `${e.output.slice(0, MAX_UI_OUTPUT)}\n… [${e.output.length - MAX_UI_OUTPUT} more characters]` }
          : e;
      this.emit({ sessionId: id, event });
    });
    this.sessions.set(id, session);
    return session;
  }

  private ask(sessionId: string, req: ApprovalRequest): Promise<AgentDecision> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.approvals.set(requestId, { sessionId, resolve });
      this.emit({
        sessionId,
        event: { type: 'approval', requestId, tool: req.tool, summary: req.summary, args: req.args, outside: req.outside },
      });
    });
  }

  private async run(session: Session, task: string): Promise<void> {
    const ac = new AbortController();
    session.running = ac;
    try {
      await session.agent.run(task, ac.signal);
    } catch {
      // reported through the agent's 'error' event
    } finally {
      session.running = undefined;
      this.emit({ sessionId: session.id, event: { type: 'idle' } });
    }
  }
}
