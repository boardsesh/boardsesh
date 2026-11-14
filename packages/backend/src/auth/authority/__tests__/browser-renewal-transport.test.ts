import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vite-plus/test';
import type { IncomingMessage, ServerResponse } from 'node:http';
const dependencies = vi.hoisted(() => ({
  database: vi.fn(),
  execute: vi.fn(),
  rate: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('../../credential-database', () => ({ getCredentialDatabase: dependencies.database }));
vi.mock('../browser-renewal', () => ({ executeBrowserRenewalCommand: dependencies.execute }));
vi.mock('../../../utils/rate-limiter', () => ({ checkRateLimit: dependencies.rate }));
vi.mock('../../../utils/logger', () => ({ logger: { error: dependencies.error, warn: dependencies.warn } }));
import { handleBrowserRenewal } from '../../../handlers/browser-renewal';
import {
  BROWSER_RENEWAL_COMMAND_PATHS,
  BROWSER_RENEWAL_REQUEST_BYTES,
} from '@boardsesh/auth-protocol/browser-renewal-v1';
import {
  PRIVATE_WEB_CREDENTIAL_CAPABILITIES,
  PRIVATE_BROWSER_CREDENTIAL_CAPABILITIES,
  PRIVATE_PROVIDER_CREDENTIAL_CAPABILITIES,
  PRIVATE_FIRST_PASSWORD_CREDENTIAL_CAPABILITIES,
  PRIVATE_NATIVE_HANDOFF_CREDENTIAL_CAPABILITIES,
  PRIVATE_BROWSER_RENEWAL_CREDENTIAL_CAPABILITIES,
  PRIVATE_PROVIDER_CREDENTIAL_COLUMN_CAPABILITIES,
  PRIVATE_BROWSER_RENEWAL_CREDENTIAL_COLUMN_CAPABILITIES,
} from '@boardsesh/db/credential-writer-acl';
const secret = 'owned-renewal-independent-private-rpc-secret-6975';
const database = Object.freeze({ kind: 'owned-qualified-role6' });
const environment = {
  CURRENT_STORE_BROWSER_RENEWAL_MODE: 'backend-staging',
  CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
  CURRENT_STORE_AUTH_RPC_SECRET: secret,
  NEXTAUTH_SECRET: 'owned-renewal-independent-jwe-secret-6975',
  CURRENT_STORE_AUTH_PROJECTION_ID: 'owned-renewal-independent-projection',
  CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
  CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-renewal-independent-deleted-email-key-6975',
  AUTH_CUTOFF_ENFORCEMENT: 'enforce',
  DEBUG_SQL: 'false',
};
function command(kind: 'canonical-token' | 'legacy-jwe' = 'canonical-token') {
  return {
    browserRenewalProtocolVersion: 1,
    requestId: randomUUID(),
    issuedAt: Date.now(),
    operation: 'prepare',
    payload: {
      bindingToken: 'A'.repeat(43),
      actor: {
        version: 1,
        credential:
          kind === 'canonical-token' ? { kind, token: 'B'.repeat(43) } : { kind, credential: 'owned-actual-jwe-bytes' },
      },
      nonceHash: 'e'.repeat(64),
    },
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
    url: options.path ?? BROWSER_RENEWAL_COMMAND_PATHS.prepare,
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
  await handleBrowserRenewal(request, response, options.injected ? (database as never) : undefined);
  return { status, body, headers, reads };
}
beforeEach(() => {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  dependencies.database.mockReset().mockResolvedValue(database);
  dependencies.rate.mockReset();
  dependencies.error.mockReset();
  dependencies.warn.mockReset();
  dependencies.execute.mockReset().mockImplementation(async (_db, _runtime, request) => ({
    browserRenewalProtocolVersion: 1,
    requestId: request.requestId,
    operation: request.operation,
    outcome: 'conflict',
  }));
});
afterEach(() => vi.unstubAllEnvs());
describe('renewal private transport and explicit role6 capability closure', () => {
  it.each(['legacy', ''])('keeps %s renewal disabled before body or pool', async (mode) => {
    vi.stubEnv('CURRENT_STORE_BROWSER_RENEWAL_MODE', mode);
    const result = await invoke(command());
    expect(result.status).toBe(404);
    expect(result.reads).toBe(0);
    expect(dependencies.database).not.toHaveBeenCalled();
  });
  it('requires service authentication before reading body', async () => {
    const result = await invoke(command(), { authorization: 'Bearer browser-source-token' });
    expect(result.status).toBe(401);
    expect(result.reads).toBe(0);
    expect(dependencies.database).not.toHaveBeenCalled();
  });
  it.each(['binding-mode', 'short-service-key', 'reused-service-key', 'unknown-mode'] as const)(
    'refuses %s configuration before body/pool',
    async (fault) => {
      if (fault === 'binding-mode') vi.stubEnv('CURRENT_STORE_BROWSER_BINDING_MODE', 'legacy');
      if (fault === 'short-service-key') vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', 'short');
      if (fault === 'reused-service-key') vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', environment.NEXTAUTH_SECRET);
      if (fault === 'unknown-mode') vi.stubEnv('CURRENT_STORE_BROWSER_RENEWAL_MODE', 'pretend-enabled');
      const result = await invoke(command());
      expect(result.status).toBe(503);
      expect(result.reads).toBe(0);
      expect(dependencies.database).not.toHaveBeenCalled();
    },
  );
  it.each(['method', 'content-type', 'path', 'query', 'stale', 'extra-field', 'utf8', 'oversize'] as const)(
    'refuses %s before pool',
    async (fault) => {
      const input = command();
      let options: Parameters<typeof invoke>[1] = {};
      if (fault === 'method') options = { method: 'GET' };
      if (fault === 'content-type') options = { contentType: 'text/plain' };
      if (fault === 'path') options = { path: BROWSER_RENEWAL_COMMAND_PATHS.finalize };
      if (fault === 'query') options = { path: BROWSER_RENEWAL_COMMAND_PATHS.prepare + '?identity=claimed' };
      if (fault === 'stale') input.issuedAt -= 180000;
      if (fault === 'extra-field') Object.assign(input.payload, { database: 'content' });
      if (fault === 'utf8')
        Object.assign(input.payload.actor, { credential: { kind: 'legacy-jwe', credential: 'é'.repeat(9000) } });
      if (fault === 'oversize') options = { raw: 'x'.repeat(BROWSER_RENEWAL_REQUEST_BYTES + 1) };
      const result = await invoke(input, options);
      expect(result.status).toBe(400);
      expect(dependencies.database).not.toHaveBeenCalled();
      expect(dependencies.execute).not.toHaveBeenCalled();
    },
  );
  it('refuses missing legacy codec key before creating any pool', async () => {
    vi.stubEnv('NEXTAUTH_SECRET', '');
    expect((await invoke(command('legacy-jwe'))).status).toBe(503);
    expect(dependencies.database).not.toHaveBeenCalled();
    expect(dependencies.execute).not.toHaveBeenCalled();
  });
  it('admits canonical command without legacy key and requests exact6 pool only', async () => {
    vi.stubEnv('NEXTAUTH_SECRET', '');
    const input = command();
    const result = await invoke(input);
    expect(result.status).toBe(409);
    expect(dependencies.database).toHaveBeenCalledExactlyOnceWith('private-browser-renewal-v1');
    expect(dependencies.execute).toHaveBeenCalledExactlyOnceWith(
      database,
      expect.objectContaining({ legacySecret: '' }),
      input,
    );
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it('accepts only server-injected owned fixture pool', async () => {
    expect((await invoke(command(), { injected: true })).status).toBe(409);
    expect(dependencies.database).not.toHaveBeenCalled();
    expect(dependencies.execute.mock.calls[0][0]).toBe(database);
  });
  it.each(['qualification', 'unknown-finalizer'] as const)(
    'withholds %s causes with one execution maximum',
    async (fault) => {
      const cause = new Error('owned-raw-secret-and-private-query-parameters');
      if (fault === 'qualification') dependencies.database.mockRejectedValue(cause);
      else dependencies.execute.mockRejectedValue(cause);
      const result = await invoke(command());
      expect(result.status).toBe(503);
      expect(JSON.stringify(result)).not.toContain(cause.message);
      expect(dependencies.database).toHaveBeenCalledTimes(1);
      expect(dependencies.execute).toHaveBeenCalledTimes(fault === 'qualification' ? 0 : 1);
      expect(result.headers['set-cookie']).toBeUndefined();
    },
  );
  it('keeps renewal writes narrow and leaves profiles1..5 unchanged', () => {
    expect(PRIVATE_BROWSER_RENEWAL_CREDENTIAL_CAPABILITIES).toEqual({
      ...PRIVATE_NATIVE_HANDOFF_CREDENTIAL_CAPABILITIES,
      auth_browser_renewals: ['SELECT', 'INSERT'],
    });
    expect(PRIVATE_BROWSER_RENEWAL_CREDENTIAL_COLUMN_CAPABILITIES).toEqual({
      ...PRIVATE_PROVIDER_CREDENTIAL_COLUMN_CAPABILITIES,
      auth_browser_renewals: {
        candidate_hash: ['UPDATE'],
        result_version: ['UPDATE'],
        completed_at: ['UPDATE'],
        acknowledge_until: ['UPDATE'],
      },
    });
    for (const old of [
      PRIVATE_WEB_CREDENTIAL_CAPABILITIES,
      PRIVATE_BROWSER_CREDENTIAL_CAPABILITIES,
      PRIVATE_PROVIDER_CREDENTIAL_CAPABILITIES,
      PRIVATE_FIRST_PASSWORD_CREDENTIAL_CAPABILITIES,
      PRIVATE_NATIVE_HANDOFF_CREDENTIAL_CAPABILITIES,
    ])
      expect(Object.hasOwn(old, 'auth_browser_renewals')).toBe(false);
    expect(Object.isFrozen(PRIVATE_BROWSER_RENEWAL_CREDENTIAL_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(PRIVATE_BROWSER_RENEWAL_CREDENTIAL_COLUMN_CAPABILITIES.auth_browser_renewals)).toBe(true);
  });
});
