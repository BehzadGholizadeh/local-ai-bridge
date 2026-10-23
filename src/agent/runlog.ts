import fs from 'node:fs';
import path from 'node:path';
import type { Agent, AgentEvent } from './agent';

const KEEP_LOGS = 30;

/**
 * Writes every event of an agent session, including the exact prompts and the model's raw replies,
 * to <dataDir>/agent-logs/<time>-<label>.jsonl, so a wrong answer can be diagnosed afterwards.
 * Local only, like the rest of the data directory. Returns the log path.
 */
export function attachRunLog(agent: Agent, dataDir: string, label: string): string {
  const dir = path.join(dataDir, 'agent-logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label.replace(/[^\w-]/g, '').slice(0, 40)}.jsonl`);
  const write = (record: object) => {
    try {
      fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`);
    } catch {
      // logging must never break the agent
    }
  };
  write({ type: 'session', workspace: agent.root });
  agent.on('event', (e: AgentEvent) => {
    if (e.type === 'progress' || e.type === 'phase') return; // too chatty; the exchange has the result
    write(e);
  });
  try {
    const old = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_LOGS))) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    // ignore
  }
  return file;
}
