import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vite-plus/test';
import type { IncomingMessage, ServerResponse } from 'node:http';
const dependencies = vi.hoisted(() => ({ database: vi.fn(), execute: vi.fn(), rate: vi.fn() }));
vi.mock('../../credential-database', () => ({ getCredentialDatabase: dependencies.database }));
vi.mock('../expired-browser-binding', () => ({ executeExpiredBrowserBindingCommand: dependencies.execute }));
vi.mock('../../../utils/rate-limiter', () => ({ checkRateLimit: dependencies.rate }));
import { handleExpiredBrowserBinding } from '../../../handlers/expired-browser-binding';
import {
  EXPIRED_BROWSER_BINDING_COMMAND_PATHS,
  EXPIRED_BROWSER_BINDING_REQUEST_BYTES,
} from '@boardsesh/auth-protocol/expired-browser-binding-v1';
const secret = 'owned-retirement-independent-private-rpc-secret-6975';
const database = Object.freeze({ kind: 'owned-qualified-profile2' });
const environment = {
  CURRENT_STORE_EXPIRED_BROWSER_BINDING_MODE: 'backend-staging',
  CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
  CURRENT_STORE_AUTH_RPC_SECRET: secret,
  NEXTAUTH_SECRET: 'owned-retirement-independent-jwe-secret-6975',
  CURRENT_STORE_AUTH_PROJECTION_ID: 'owned-retirement-independent-projection',
  CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
  CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-retirement-independent-deleted-email-key-6975',
  AUTH_CUTOFF_ENFORCEMENT: 'enforce',
  DEBUG_SQL: 'false',
};
function command() {
  return {
    expiredBrowserBindingProtocolVersion: 1,
    requestId: randomUUID(),
    issuedAt: Date.now(),
    operation: 'prepare',
    payload: { bindingToken: 'A'.repeat(43), expectedVersion: 1, nonceHash: 'e'.repeat(64) },
  };
}
async function invoke(
  input: unknown,
  options: {
    authorization?: string;
    method?: string;
    path?: string;
    contentType?: string;
    raw?: string;
    injected?: boolean;
  } = {},
) {
  let reads = 0;
  let consumed = false;
  const encoded = Buffer.from(options.raw ?? JSON.stringify(input));
  const stream = new Readable({
    read() {
      reads++;
      if (!consumed) {
        this.push(encoded);
        consumed = true;
      }
      this.push(null);
    },
  });
  const request = Object.assign(stream, {
    method: options.method ?? 'POST',
    url: options.path ?? EXPIRED_BROWSER_BINDING_COMMAND_PATHS.prepare,
    headers: {
      authorization: options.authorization ?? `Bearer ${secret}`,
      'content-type': options.contentType ?? 'application/json',
      cookie: '__Host-boardsesh.browser-binding=browser-is-not-service-auth',
    },
  }) as unknown as IncomingMessage;
  let status = 0;
  let body: unknown;
  const headers: Record<string, string> = {};
  const response = {
    destroyed: false,
    setHeader(name: string, content: string) {
      headers[name.toLowerCase()] = content;
    },
    writeHead(code: number, sent: Record<string, string>) {
      status = code;
      Object.entries(sent ?? {}).forEach(([name, content]) => (headers[name.toLowerCase()] = content));
    },
    end(content: string) {
      body = JSON.parse(content);
    },
  } as unknown as ServerResponse;
  await handleExpiredBrowserBinding(request, response, options.injected ? (database as never) : undefined);
  return { status, body, headers, reads };
}
beforeEach(() => {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  dependencies.database.mockReset().mockResolvedValue(database);
  dependencies.rate.mockReset();
  dependencies.execute.mockReset().mockImplementation(async (_database, _qualification, request) => ({
    expiredBrowserBindingProtocolVersion: 1,
    requestId: request.requestId,
    operation: request.operation,
    outcome: 'conflict',
  }));
});
afterEach(() => vi.unstubAllEnvs());
describe('explicit expired-binding service-only transport', () => {
  it.each(['legacy', ''])('keeps %s disabled before body or pool', async (mode) => {
    vi.stubEnv('CURRENT_STORE_EXPIRED_BROWSER_BINDING_MODE', mode);
    const result = await invoke(command());
    expect(result.status).toBe(404);
    expect(result.reads).toBe(0);
    expect(dependencies.database).not.toHaveBeenCalled();
  });
  it('requires actual service authentication before consuming any body', async () => {
    const result = await invoke(command(), { authorization: 'Bearer correlation-cookie-is-not-authority' });
    expect(result.status).toBe(401);
    expect(result.reads).toBe(0);
    expect(dependencies.database).not.toHaveBeenCalled();
  });
  it.each(['binding-mode', 'short-key', 'reused-key', 'unknown-mode'] as const)(
    'refuses %s configuration before body and pool',
    async (fault) => {
      if (fault === 'binding-mode') vi.stubEnv('CURRENT_STORE_BROWSER_BINDING_MODE', 'legacy');
      if (fault === 'short-key') vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', 'short');
      if (fault === 'reused-key') vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', environment.NEXTAUTH_SECRET);
      if (fault === 'unknown-mode') vi.stubEnv('CURRENT_STORE_EXPIRED_BROWSER_BINDING_MODE', 'pretend-enabled');
      const result = await invoke(command());
      expect(result.status).toBe(503);
      expect(result.reads).toBe(0);
      expect(dependencies.database).not.toHaveBeenCalled();
    },
  );
  it.each(['method', 'content-type', 'path', 'query', 'stale', 'extra-field', 'actor', 'oversize'] as const)(
    'refuses %s before pool',
    async (fault) => {
      const input = command();
      let options: Parameters<typeof invoke>[1] = {};
      if (fault === 'method') options = { method: 'GET' };
      if (fault === 'content-type') options = { contentType: 'text/plain' };
      if (fault === 'path') options = { path: EXPIRED_BROWSER_BINDING_COMMAND_PATHS.finalize };
      if (fault === 'query') options = { path: EXPIRED_BROWSER_BINDING_COMMAND_PATHS.prepare + '?fallback=anonymous' };
      if (fault === 'stale') input.issuedAt -= 180_000;
      if (fault === 'extra-field') Object.assign(input.payload, { database: 'content' });
      if (fault === 'actor')
        Object.assign(input.payload, { actor: { userId: 'asserted-owner', authSessionId: 'asserted-sid' } });
      if (fault === 'oversize') options = { raw: 'x'.repeat(EXPIRED_BROWSER_BINDING_REQUEST_BYTES + 1) };
      expect((await invoke(input, options)).status).toBe(400);
      expect(dependencies.database).not.toHaveBeenCalled();
      expect(dependencies.execute).not.toHaveBeenCalled();
    },
  );
  it('needs no legacy secret and requests only the compatible canonical profile3 credential pool', async () => {
    vi.stubEnv('NEXTAUTH_SECRET', '');
    const input = command();
    const result = await invoke(input);
    expect(result.status).toBe(409);
    expect(dependencies.database).toHaveBeenCalledExactlyOnceWith('private-provider-v1');
    expect(dependencies.execute).toHaveBeenCalledExactlyOnceWith(
      database,
      expect.objectContaining({ expectedProjectionId: environment.CURRENT_STORE_AUTH_PROJECTION_ID }),
      input,
    );
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it.each(['qualification', 'unknown-finalizer'] as const)('never retries or leaks %s', async (fault) => {
    const cause = new Error('owned-private-token-and-SQL-parameters');
    if (fault === 'qualification') dependencies.database.mockRejectedValue(cause);
    else dependencies.execute.mockRejectedValue(cause);
    const result = await invoke(command());
    expect(result.status).toBe(503);
    expect(dependencies.database).toHaveBeenCalledTimes(1);
    expect(dependencies.execute).toHaveBeenCalledTimes(fault === 'qualification' ? 0 : 1);
    expect(JSON.stringify(result)).not.toContain(cause.message);
    expect(result.headers['set-cookie']).toBeUndefined();
  });
  it('does not execute on a saturated internal operation budget', async () => {
    dependencies.rate.mockImplementation(() => {
      throw new Error('owned-limit');
    });
    expect((await invoke(command())).status).toBe(503);
    expect(dependencies.database).not.toHaveBeenCalled();
    expect(dependencies.execute).not.toHaveBeenCalled();
  });
});
