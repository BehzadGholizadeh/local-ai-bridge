import { EventEmitter } from 'node:events';
import type { LogEntry } from '../shared/types';

const MAX_ENTRIES = 500;

/** Console logger that also keeps the last few hundred lines for the in-app log viewer. */
export class Logger extends EventEmitter {
  readonly entries: LogEntry[] = [];

  /** `echo: false` keeps entries (and events) without printing them to the console. */
  constructor(private echo = true) {
    super();
  }

  info(...parts: unknown[]): void {
    this.push('info', parts);
  }

  warn(...parts: unknown[]): void {
    this.push('warn', parts);
  }

  error(...parts: unknown[]): void {
    this.push('error', parts);
  }

  private push(level: LogEntry['level'], parts: unknown[]): void {
    const msg = parts
      .map((p) => (p instanceof Error ? p.message : typeof p === 'string' ? p : JSON.stringify(p)))
      .join(' ');
    const entry: LogEntry = { t: Date.now(), level, msg };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.emit('entry', entry);
    if (!this.echo) return;
    const line = `[${new Date(entry.t).toISOString()}] ${level.toUpperCase()} ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}
