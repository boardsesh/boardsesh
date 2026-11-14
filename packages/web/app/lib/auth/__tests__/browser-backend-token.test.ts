// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  browserDelegationCommandSchema,
  type BrowserDelegationCommand,
} from '@boardsesh/auth-protocol/browser-delegation-v1';
vi.mock('server-only', () => ({}));
import { issueBrowserBackendToken } from '../browser-backend-token.server';
import type { AdmittedBrowserSelection } from '../presented-browser-selection.server';

const environment = {
  NODE_ENV: 'test',
  CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
  CURRENT_STORE_AUTH_BACKEND_ORIGIN: 'http://127.0.0.1:54678',
  CURRENT_STORE_AUTH_RPC_SECRET: 'owned-backend-lease-private-service-secret',
  NEXTAUTH_SECRET: 'owned-unrelated-cookie-secret',
  HTTP_COOKIE: 'owned-incoming-cookie-never-forwarded',
};
function fixture(transform?: (body: Record<string, unknown>) => Record<string, unknown>, status = 200) {
  const bindingToken = Buffer.alloc(32, 7).toString('base64url');
  const selection: AdmittedBrowserSelection = {
    status: 'admitted',
    bindingToken,
    actor: { version: 4, credential: { kind: 'canonical-token', token: 'owned-opaque-source' } },
    cursor: {
      bindingId: createHash('sha256').update(bindingToken).digest('hex'),
      version: 4,
      bindingExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    },
    session: {
      userId: 'owned-user',
      authSessionId: 'owned-session',
      generation: 3,
      authenticatedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      linkGuarded: false,
      requiresAccountCutoff: true,
    },
    user: { id: 'owned-user', email: 'owned@example.test', name: null, image: null },
  };
  const captured: { command: BrowserDelegationCommand; settings: RequestInit; url: string }[] = [];
  const send = vi.fn<typeof fetch>(async (input, settings) => {
    if (typeof settings?.body !== 'string') throw new Error('Owned serialized command missing');
    const command = browserDelegationCommandSchema.parse(JSON.parse(settings.body));
    captured.push({
      command,
      settings,
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    });
    const body = {
      browserDelegationProtocolVersion: 1,
      operation: 'delegate',
      requestId: command.requestId,
      outcome: 'admitted',
      token: 'bsbd1_OWNEDENCRYPTEDBEARER',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      cursor: selection.cursor,
      userId: selection.session.userId,
      authSessionId: selection.session.authSessionId,
    };
    return Response.json(transform ? transform(body) : body, { status });
  });
  return { selection, send, captured, issue: () => issueBrowserBackendToken(selection, { environment, fetch: send }) };
}
describe('server-only backend browser lease client', () => {
  it('accepts positive database clock skew and keeps the local cache conservative', async () => {
    const before = Date.now();
    const test = fixture((body) => {
      const databaseIssuedAt = Date.now() + 100;
      return {
        ...body,
        issuedAt: new Date(databaseIssuedAt).toISOString(),
        expiresAt: new Date(databaseIssuedAt + 120_000).toISOString(),
      };
    });
    const result = await test.issue();
    expect(result.status).toBe('admitted');
    if (result.status !== 'admitted') throw new Error('Owned clock-skew lease refused');
    expect(Date.parse(result.expiresAt)).toBeLessThanOrEqual(Date.now() + 120_000);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(before + 119_000);
  });
  it('refuses even a one-millisecond lease extension on the issuer clock', async () => {
    const test = fixture((body) => {
      const issuedAt = Date.now();
      return {
        ...body,
        issuedAt: new Date(issuedAt).toISOString(),
        expiresAt: new Date(issuedAt + 120_001).toISOString(),
      };
    });
    expect(await test.issue()).toEqual({ status: 'unavailable' });
  });
  it('forwards exact source privately and returns a limited correlated lease', async () => {
    const test = fixture();
    expect(await test.issue()).toMatchObject({
      status: 'admitted',
      token: 'bsbd1_OWNEDENCRYPTEDBEARER',
      cursor: test.selection.cursor,
      userId: 'owned-user',
      authSessionId: 'owned-session',
    });
    expect(test.captured[0].command.payload).toEqual({
      bindingToken: test.selection.bindingToken,
      actor: test.selection.actor,
    });
    const headers = new Headers(test.captured[0].settings.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${environment.CURRENT_STORE_AUTH_RPC_SECRET}`);
    expect(headers.has('cookie')).toBe(false);
    expect(test.captured[0].settings).toMatchObject({ cache: 'no-store', redirect: 'error' });
    expect(test.captured[0].url).toBe(
      `${environment.CURRENT_STORE_AUTH_BACKEND_ORIGIN}/api/internal/auth/browser-delegation/v1/issue`,
    );
  });
  it.each([
    ['requestId', '4d019f66-81ca-4a9a-96ad-6cb22639db14'],
    ['operation', 'read'],
    ['browserDelegationProtocolVersion', 2],
    ['userId', 'another-user'],
    ['authSessionId', 'another-session'],
    ['expiresAt', new Date(0).toISOString()],
    ['expiresAt', new Date(Date.now() + 180_000).toISOString()],
    ['token', 'owned-source-without-delegation-family'],
    ['sourceCredential', 'must-never-be-in-a-reply'],
  ])('refuses mismatched or unsafe %s', async (property, altered) => {
    const test = fixture((body) => ({ ...body, [property]: altered }));
    expect(await test.issue()).toEqual({ status: 'unavailable' });
    expect(test.send).toHaveBeenCalledTimes(1);
  });
  it.each([
    { bindingId: 'f'.repeat(64) },
    { version: 3 },
    { version: 5 },
    { bindingExpiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  ])('requires the exact selected primary cursor: %j', async (altered) => {
    const test = fixture((body) => ({ ...body, cursor: { ...test.selection.cursor, ...altered } }));
    expect(await test.issue()).toEqual({ status: 'unavailable' });
  });
  it.each([
    ['denied', 401],
    ['conflict', 409],
    ['unavailable', 503],
  ] as const)('preserves %s without identity', async (outcome, status) => {
    const test = fixture(
      (body) => ({ browserDelegationProtocolVersion: 1, operation: 'delegate', requestId: body.requestId, outcome }),
      status,
    );
    expect(await test.issue()).toEqual({ status: outcome });
  });
  it('refuses an HTTP status/body mismatch and never retries lost outcomes', async () => {
    const mismatch = fixture(undefined, 201);
    expect(await mismatch.issue()).toEqual({ status: 'unavailable' });
    const test = fixture();
    test.send.mockRejectedValueOnce(new Error('owned-transport-disconnected'));
    expect(await test.issue()).toEqual({ status: 'unavailable' });
    expect(test.send).toHaveBeenCalledTimes(1);
  });
  it('fails closed before transport when the browser mode is off', async () => {
    const test = fixture();
    expect(
      await issueBrowserBackendToken(test.selection, {
        environment: { ...environment, CURRENT_STORE_BROWSER_BINDING_MODE: 'legacy' },
        fetch: test.send,
      }),
    ).toEqual({ status: 'unavailable' });
    expect(test.send).not.toHaveBeenCalled();
  });
});
