export type ErrorCode =
  | 'logged_out'
  | 'challenge'
  | 'rate_limited'
  | 'timeout'
  | 'selector'
  | 'aborted'
  | 'browser_missing'
  | 'disabled'
  | 'blocked'
  | 'busy'
  | 'bad_request'
  | 'internal';

/** An error with a machine-readable code that the UI and the HTTP API can explain to the user. */
export class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Text received before the failure, if any. */
    readonly partial?: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }

  static from(e: unknown): BridgeError {
    if (e instanceof BridgeError) return e;
    const err = e instanceof Error ? e : new Error(String(e));
    if (err.name === 'TimeoutError') return new BridgeError('timeout', err.message.split('\n')[0]);
    if (/Target page, context or browser has been closed/i.test(err.message)) {
      return new BridgeError('aborted', 'The browser window was closed.');
    }
    return new BridgeError('internal', err.message.split('\n')[0]);
  }
}

export const HTTP_STATUS: Record<ErrorCode, number> = {
  logged_out: 503,
  challenge: 503,
  rate_limited: 429,
  timeout: 504,
  selector: 502,
  aborted: 499,
  browser_missing: 503,
  disabled: 503,
  blocked: 451,
  busy: 409,
  bad_request: 400,
  internal: 500,
};
