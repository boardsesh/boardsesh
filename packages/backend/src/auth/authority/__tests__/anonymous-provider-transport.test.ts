import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { ANONYMOUS_PROVIDER_PATHS, ANONYMOUS_PROVIDER_REQUEST_BYTES } from '@boardsesh/auth-protocol';
const dependencies = vi.hoisted(() => ({ database: vi.fn(), execute: vi.fn() }));
vi.mock('../../credential-database', () => ({ getCredentialDatabase: dependencies.database }));
vi.mock('../anonymous-provider-signin', () => ({ executeAnonymousProviderCommand: dependencies.execute }));
import { handleAnonymousProvider } from '../../../handlers/anonymous-provider';

const rpcSecret = 'owned-anonymous-provider-http-service-secret-6975';
const privateDatabase = Object.freeze({ owner: 'qualified-private-provider-pool' }) as unknown as DbInstance;
const ownedDatabase = Object.freeze({ owner: 'explicit-owned-fixture-pool' }) as unknown as DbInstance;
function command() {
  return {
    anonymousProviderVersion: 1,
    requestId: randomUUID(),
    issuedAt: new Date().toISOString(),
    operation: 'intent',
    payload: {
      browser: { bindingToken: 'A'.repeat(43), expectedVersion: 0 },
      provider: 'apple',
      credentialKind: 'canonical-token',
      flowHash: 'b'.repeat(64),
      nonceHash: null,
    },
  };
}
async function invoke(
  input: unknown,
  options: {
    authorization?: string;
    method?: string;
    path?: string;
    raw?: string;
    database?: DbInstance;
    contentType?: string;
  } = {},
) {
  const stream = Readable.from([Buffer.from(options.raw ?? JSON.stringify(input))]);
  const request = Object.assign(stream, {
    method: options.method ?? 'POST',
    url: options.path ?? ANONYMOUS_PROVIDER_PATHS.intent,
    headers: {
      authorization: options.authorization ?? `Bearer ${rpcSecret}`,
      'content-type': options.contentType ?? 'application/json',
      cookie: '__Host-boardsesh.browser-binding=not-service-auth',
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
      for (const [name, content] of Object.entries(sent)) headers[name.toLowerCase()] = content;
    },
    end(serialized: string) {
      body = JSON.parse(serialized) as unknown;
    },
  } as unknown as ServerResponse;
  try {
    await handleAnonymousProvider(request, response, options.database);
  } finally {
    stream.destroy();
  }
  return { status, body, headers };
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, content] of Object.entries({
    CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging',
    CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
    NEXTAUTH_SECRET: 'owned-anonymous-provider-source-secret-6975',
    CURRENT_STORE_AUTH_PROJECTION_ID: 'owned-anonymous-provider-projection',
    CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
    CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-anonymous-provider-retired-mailbox-key-6975',
    AUTH_CUTOFF_ENFORCEMENT: 'enforce',
    DEBUG_SQL: 'false',
  }))
    vi.stubEnv(name, content);
  dependencies.database.mockReset().mockResolvedValue(privateDatabase);
  dependencies.execute
    .mockReset()
    .mockImplementation(async (_database, _runtime, request: ReturnType<typeof command>) => ({
      anonymousProviderVersion: 1,
      requestId: request.requestId,
      operation: request.operation,
      outcome: 'denied',
      code: 'ownership_conflict',
    }));
});
afterEach(() => vi.unstubAllEnvs());

describe('source-free anonymous provider service transport', () => {
  it.each(['legacy', ''])('keeps %s mode disabled before any credential pool', async (mode) => {
    vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', mode);
    expect((await invoke(command())).status).toBe(404);
    expect(dependencies.database).not.toHaveBeenCalled();
    expect(dependencies.execute).not.toHaveBeenCalled();
  });
  it('requires actual private service authentication; browser cookies cannot replace it', async () => {
    expect((await invoke(command(), { authorization: 'Bearer browser-credential' })).status).toBe(401);
    expect(dependencies.database).not.toHaveBeenCalled();
    expect(dependencies.execute).not.toHaveBeenCalled();
  });
  it.each([
    'version',
    'actor-null',
    'asserted-UID',
    'facebook',
    'legacy-resolve',
    'missing-binding',
    'extra-database',
  ] as const)('refuses %s without constructing a pool', async (fault) => {
    const original = command();
    const changed: Record<string, unknown> = { ...original, payload: { ...original.payload } };
    const payload = changed.payload as Record<string, unknown>;
    if (fault === 'version') changed.anonymousProviderVersion = 2;
    if (fault === 'actor-null') payload.actor = null;
    if (fault === 'asserted-UID') payload.userId = 'claimed-owner';
    if (fault === 'facebook') payload.provider = 'facebook';
    if (fault === 'legacy-resolve') changed.operation = 'resolve';
    if (fault === 'missing-binding') delete payload.browser;
    if (fault === 'extra-database') payload.database = 'content-pool';
    expect((await invoke(changed)).status).toBe(400);
    expect(dependencies.database).not.toHaveBeenCalled();
    expect(dependencies.execute).not.toHaveBeenCalled();
  });
  it.each(['wrong-path', 'stale', 'method', 'content-type', 'oversize'] as const)(
    'keeps %s before pool qualification',
    async (fault) => {
      const request = command();
      if (fault === 'stale') request.issuedAt = new Date(Date.now() - 180_000).toISOString();
      const result = await invoke(request, {
        ...(fault === 'wrong-path' ? { path: ANONYMOUS_PROVIDER_PATHS.prepare } : {}),
        ...(fault === 'method' ? { method: 'GET' } : {}),
        ...(fault === 'content-type' ? { contentType: 'text/plain' } : {}),
        ...(fault === 'oversize' ? { raw: 'x'.repeat(ANONYMOUS_PROVIDER_REQUEST_BYTES + 1) } : {}),
      });
      expect(result.status).toBe(400);
      expect(dependencies.database).not.toHaveBeenCalled();
      expect(dependencies.execute).not.toHaveBeenCalled();
    },
  );
  it('selects only the qualified provider pool and publishes no cookies or private causes', async () => {
    const request = command();
    const result = await invoke(request);
    expect(result.status).toBe(403);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(dependencies.database).toHaveBeenCalledExactlyOnceWith('private-provider-v1');
    expect(dependencies.execute).toHaveBeenCalledExactlyOnceWith(
      privateDatabase,
      expect.objectContaining({ legacySecret: expect.any(String) }),
      request,
    );
    expect(result.body).toEqual({
      anonymousProviderVersion: 1,
      requestId: request.requestId,
      operation: 'intent',
      outcome: 'denied',
      code: 'ownership_conflict',
    });
  });
  it('allows only server-injected owned fixture databases, with no default fallback', async () => {
    expect((await invoke(command(), { database: ownedDatabase })).status).toBe(403);
    expect(dependencies.database).not.toHaveBeenCalled();
    expect(dependencies.execute.mock.calls[0][0]).toBe(ownedDatabase);
  });
  it.each(['qualification', 'unknown-commit'] as const)('withholds %s causes and never retries', async (fault) => {
    const error = new Error('unsafe-private-database-and-credential-cause');
    if (fault === 'qualification') dependencies.database.mockRejectedValue(error);
    else dependencies.execute.mockRejectedValue(error);
    const result = await invoke(command());
    expect(result.status).toBe(503);
    expect(JSON.stringify(result)).not.toContain(error.message);
    expect(dependencies.database).toHaveBeenCalledTimes(1);
    expect(dependencies.execute).toHaveBeenCalledTimes(fault === 'qualification' ? 0 : 1);
  });
});
