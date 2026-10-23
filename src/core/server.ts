import http from 'node:http';
import type { Bridge } from './bridge';
import { BridgeError } from './errors';
import { checkKey, sendError, sendJson } from './api/http';
import { handleMcp } from './api/mcp';
import { chatCompletions, models } from './api/openai';

/**
 * Local HTTP server on 127.0.0.1: the OpenAI-compatible API (/v1) and the MCP endpoint (/mcp).
 * Security checks shared by all routes live here.
 */
export class ApiServer {
  private server?: http.Server;
  error?: string;

  constructor(private bridge: Bridge) {}

  get running(): boolean {
    return !!this.server?.listening;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.bridge.settings.get().port}`;
  }

  get url(): string {
    return `${this.origin}/v1`;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const { port } = this.bridge.settings.get();
    this.error = undefined;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        const err = BridgeError.from(e);
        if (err.code !== 'bad_request') this.bridge.log.error('API handler error:', e);
        if (!res.headersSent) sendError(res, err);
        else res.end();
      });
    });
    server.keepAliveTimeout = 65_000;
    // Replies can take minutes; don't let Node cut long requests off.
    server.requestTimeout = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      this.error = code === 'EADDRINUSE' ? `Port ${port} is already in use. Pick another port in Settings.` : (e as Error).message;
      throw e;
    }
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const settings = this.bridge.settings.get();

    // Reject DNS-rebinding attempts: only loopback host names may address this server.
    const host = (req.headers.host ?? '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      return sendJson(res, 403, { error: { message: 'Forbidden host', type: 'forbidden' } });
    }
    // Web pages may only call the API from origins the user allowed.
    const origin = req.headers.origin;
    if (origin) {
      const allowed = settings.corsOrigins.includes('*') || settings.corsOrigins.includes(origin);
      if (!allowed) {
        return sendJson(res, 403, {
          error: { message: `Origin ${origin} is not allowed. Add it under Settings → Allowed origins.`, type: 'forbidden' },
        });
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, mcp-protocol-version, mcp-session-id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && (route === '/' || route === '/health')) {
      return sendJson(res, 200, { ok: true, name: 'local-ai-bridge', providers: this.bridge.statuses() });
    }

    if (settings.apiKey && !checkKey(req.headers.authorization, settings.apiKey)) {
      return sendJson(res, 401, {
        error: { message: 'Invalid API key. Use the key from Settings → API key.', type: 'invalid_request_error', code: 'invalid_api_key' },
      });
    }

    if (route === '/mcp') return handleMcp(this.bridge, req, res);
    if (req.method === 'GET' && route === '/v1/models') return models(this.bridge, res);
    if (req.method === 'GET' && route === '/v1/bridge/status') {
      return sendJson(res, 200, { api: this.bridge.apiInfo(), providers: this.bridge.statuses() });
    }
    if (req.method === 'POST' && route === '/v1/chat/completions') return chatCompletions(this.bridge, req, res);
    return sendJson(res, 404, { error: { message: `No route for ${req.method} ${route}`, type: 'not_found' } });
  }
}
