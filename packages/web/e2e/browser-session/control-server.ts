import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EdgeResponseObservation } from '../../partner-oauth-e2e/edge';
import type { EnvironmentOverrides, ServerSet } from './servers';
import type { SetCookieRecord } from './stack';

/**
 * How a spec, which runs in a Playwright worker, reaches the things only the
 * global setup holds: the Set-Cookie log the edge keeps and the process handles
 * of the servers. A loopback HTTP server with a per-run token; there is nothing
 * on it a page in the browser can use, because the browsers' proxy tunnels only
 * the `.test` hosts and this server is none of them.
 *
 *   GET  /set-cookies/mark          { mark }       how many responses are logged so far
 *   GET  /set-cookies?since=<mark>  { records }    every response logged after the mark
 *   POST /restart  { env }          { state }      starts restarting both servers with `env` over their base
 *                                                   environment (null unsets); answers at once
 *   GET  /restart/status            { state, error? }  `running`, then `ready` or `failed`; a restart can take
 *                                                   minutes, longer than one HTTP request should be held open
 */

export class SetCookieLog {
  private readonly records: SetCookieRecord[] = [];

  /** Every relayed response is kept, with or without a Set-Cookie, so "emitted nothing" can be told from "never ran". */
  observe({ host, method, path, status, setCookies }: EdgeResponseObservation): void {
    this.records.push({ host, method, path, status, setCookies });
  }

  mark(): number {
    return this.records.length;
  }

  since(mark: number): SetCookieRecord[] {
    return this.records.slice(mark);
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function parseOverrides(body: string): EnvironmentOverrides {
  const parsed: unknown = body ? JSON.parse(body) : {};
  const env = typeof parsed === 'object' && parsed !== null && 'env' in parsed ? parsed.env : {};
  if (typeof env !== 'object' || env === null || Array.isArray(env)) throw new Error('env must be an object');
  const overrides: EnvironmentOverrides = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' && value !== null) throw new Error(`env.${name} must be a string or null`);
    overrides[name] = value;
  }
  return overrides;
}

export async function startControlServer(
  log: SetCookieLog,
  servers: ServerSet,
): Promise<{ server: Server; url: string; token: string }> {
  const token = randomBytes(24).toString('base64url');
  const expected = Buffer.from(token);
  let restart: { state: 'idle' | 'running' | 'ready' | 'failed'; error?: string } = { state: 'idle' };
  const server = createServer(async (request, response) => {
    const presented = Buffer.from(String(request.headers['x-control-token'] ?? ''));
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      sendJson(response, 401, { error: 'bad token' });
      return;
    }
    try {
      const url = new URL(request.url ?? '/', 'http://control.invalid');
      if (request.method === 'GET' && url.pathname === '/set-cookies/mark') {
        sendJson(response, 200, { mark: log.mark() });
      } else if (request.method === 'GET' && url.pathname === '/set-cookies') {
        sendJson(response, 200, { records: log.since(Number(url.searchParams.get('since') ?? 0)) });
      } else if (request.method === 'POST' && url.pathname === '/restart') {
        if (restart.state === 'running') {
          sendJson(response, 409, { error: 'a restart is already running' });
          return;
        }
        const overrides = parseOverrides(await readBody(request));
        restart = { state: 'running' };
        servers.restart(overrides).then(
          () => {
            restart = { state: 'ready' };
          },
          (error: unknown) => {
            restart = { state: 'failed', error: error instanceof Error ? error.message : 'restart failed' };
          },
        );
        sendJson(response, 202, restart);
      } else if (request.method === 'GET' && url.pathname === '/restart/status') {
        sendJson(response, 200, restart);
      } else {
        sendJson(response, 404, { error: 'unknown route' });
      }
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : 'failed' });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token };
}
