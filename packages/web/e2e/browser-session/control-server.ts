import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EdgeRequestObservation, EdgeResponseObservation } from '../../partner-oauth-e2e/edge';
import type { EnvironmentOverrides, RestartOverrides, ServerSet } from './servers';
import type { SetCookieRecord } from './stack';
import { isHarnessRetryKind, recordHarnessRetry } from './harness-retries';
import type { CapturedMail } from './mail-sink';

/**
 * How a spec, which runs in a Playwright worker, reaches the things only the
 * global setup holds: the Set-Cookie log the edge keeps and the process handles
 * of the servers. A loopback HTTP server with a per-run token; there is nothing
 * on it a page in the browser can use, because the browsers' proxy tunnels only
 * the `.test` hosts and this server is none of them.
 *
 *   GET  /set-cookies/mark          { mark }       how many responses are logged so far
 *   GET  /set-cookies?since=<mark>  { records }    every response logged after the mark
 *   POST /restart  { env, backendEnv, webEnv }  { state }  starts restarting both servers with `env` (both)
 *                                                   and `backendEnv` / `webEnv` (one each) over their base
 *                                                   environment (null unsets); answers at once
 *   GET  /restart/status            { state, error? }  `running`, then `ready` or `failed`; a restart can take
 *                                                   minutes, longer than one HTTP request should be held open
 *   POST /harness-retry             { counted }    a worker reports a WebKit "internal error" navigation retry
 *   GET  /mail?to=<address>         { messages }   every message the run's mail sink took for that recipient
 *   POST /holds  { host, method, path }  { id }    the edge holds the next response to that request (one only)
 *   GET  /holds/<id>                { state }      `armed`, `holding` (answered, not yet delivered) or `released`
 *   POST /holds/<id>/release        { released }   delivers the held response (or disarms an unused hold)
 */

/** One hold: the edge keeps the next matching response from the browser until it is released. */
type ResponseHold = {
  readonly rule: EdgeRequestObservation;
  state: 'armed' | 'holding' | 'released';
  release: () => void;
  readonly released: Promise<void>;
};

/**
 * Responses the edge holds for the cookie-order spec (#7596 B7c): a hold is
 * armed for one host, method and path, takes the next response to such a
 * request after the upstream server answered it, and lets it go on release.
 * Teardown releases every hold, so no connection is left open.
 */
export class ResponseHolds {
  private readonly holds = new Map<string, ResponseHold>();

  arm(rule: EdgeRequestObservation): string {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const id = randomUUID();
    const hold: ResponseHold = { rule, state: 'armed', release: () => undefined, released };
    hold.release = () => {
      hold.state = 'released';
      release();
    };
    this.holds.set(id, hold);
    return id;
  }

  /** For the edge: the promise that holds this response, or undefined when no armed hold takes it. */
  take(request: EdgeRequestObservation): Promise<void> | undefined {
    for (const hold of this.holds.values()) {
      const { host, method, path } = hold.rule;
      if (hold.state !== 'armed' || host !== request.host || method !== request.method || path !== request.path)
        continue;
      hold.state = 'holding';
      return hold.released;
    }
    return undefined;
  }

  state(id: string): ResponseHold['state'] | undefined {
    return this.holds.get(id)?.state;
  }

  release(id: string): boolean {
    const hold = this.holds.get(id);
    if (!hold) return false;
    hold.release();
    return true;
  }

  releaseAll(): void {
    for (const hold of this.holds.values()) hold.release();
  }
}

function parseHoldRule(body: string): EdgeRequestObservation {
  const parsed: unknown = body ? JSON.parse(body) : {};
  const fields = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const { host, method, path } = fields;
  if (typeof host !== 'string' || typeof method !== 'string' || typeof path !== 'string' || !path.startsWith('/'))
    throw new Error('a hold needs host, method and a path');
  return { host, method: method.toUpperCase(), path };
}

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

function parseEnvironment(field: string, env: unknown): EnvironmentOverrides {
  if (env === undefined) return {};
  if (typeof env !== 'object' || env === null || Array.isArray(env)) throw new Error(`${field} must be an object`);
  const overrides: EnvironmentOverrides = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' && value !== null) throw new Error(`${field}.${name} must be a string or null`);
    overrides[name] = value;
  }
  return overrides;
}

function parseOverrides(body: string): RestartOverrides {
  const parsed: unknown = body ? JSON.parse(body) : {};
  const fields = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  return {
    env: parseEnvironment('env', fields.env),
    backendEnv: parseEnvironment('backendEnv', fields.backendEnv),
    webEnv: parseEnvironment('webEnv', fields.webEnv),
  };
}

export async function startControlServer(
  log: SetCookieLog,
  servers: ServerSet,
  mail: readonly CapturedMail[],
  holds: ResponseHolds,
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
      } else if (request.method === 'POST' && url.pathname === '/harness-retry') {
        let kind: unknown;
        try {
          kind = (JSON.parse((await readBody(request)) || '{}') as { kind?: unknown }).kind;
        } catch {
          kind = undefined;
        }
        recordHarnessRetry(isHarnessRetryKind(kind) ? kind : 'webkit-internal-error');
        sendJson(response, 200, { counted: true });
      } else if (request.method === 'GET' && url.pathname === '/mail') {
        const recipient = (url.searchParams.get('to') ?? '').toLowerCase();
        sendJson(response, 200, { messages: mail.filter((message) => message.recipients.includes(recipient)) });
      } else if (request.method === 'GET' && url.pathname === '/restart/status') {
        sendJson(response, 200, restart);
      } else if (request.method === 'POST' && url.pathname === '/holds') {
        sendJson(response, 200, { id: holds.arm(parseHoldRule(await readBody(request))) });
      } else if (request.method === 'GET' && url.pathname.startsWith('/holds/')) {
        const state = holds.state(url.pathname.slice('/holds/'.length));
        if (state === undefined) sendJson(response, 404, { error: 'unknown hold' });
        else sendJson(response, 200, { state });
      } else if (request.method === 'POST' && /^\/holds\/[^/]+\/release$/.test(url.pathname)) {
        const released = holds.release(url.pathname.split('/')[2] ?? '');
        sendJson(response, released ? 200 : 404, released ? { released } : { error: 'unknown hold' });
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
