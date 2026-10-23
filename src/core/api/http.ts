import type http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { BridgeError, HTTP_STATUS } from '../errors';

const MAX_BODY = 10 * 1024 * 1024;

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new BridgeError('bad_request', 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Parses a JSON object body, throwing a `bad_request` BridgeError otherwise. */
export async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === 'object') return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new BridgeError('bad_request', 'Body must be a JSON object.');
}

export function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/** OpenAI-style error body: { error: { message, type, code } }. */
export function sendError(res: http.ServerResponse, err: BridgeError): void {
  sendJson(res, HTTP_STATUS[err.code], { error: { message: err.message, type: err.code, code: err.code } });
}

export function checkKey(header: string | undefined, key: string): boolean {
  const given = Buffer.from((header ?? '').replace(/^Bearer\s+/i, '').trim());
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Aborts when the client goes away before the response is finished. */
export function abortOnClose(res: http.ServerResponse): AbortSignal {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  return ac.signal;
}

export function estimateTokens(text: string): number {
  // The web UIs don't report tokens; ~4 characters per token is a rough estimate.
  return Math.ceil(text.length / 4);
}
