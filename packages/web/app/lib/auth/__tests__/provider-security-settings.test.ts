// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { ProviderSecurityOperation, ProviderSecurityReply } from '@boardsesh/auth-protocol';
vi.mock('server-only', () => ({}));
import type { PresentedBrowserSelection, AdmittedBrowserSelection } from '../presented-browser-selection.server';
import type {
  ProviderSecurityCommandClient,
  ProviderSecurityOperationReply,
} from '../provider-security-command-client.server';
import {
  openProviderSecurityFlow,
  providerSecurityFlowCookieName,
  providerSecurityOperationKey,
  sealProviderSecurityFlow,
  type ProviderSecurityFlow,
} from '../provider-security-flow.server';
import { captureProviderBrowserContext, providerBindingHash } from '../provider-security-selection.server';
import { createProviderSecuritySettingsBroker, PROVIDER_SETTINGS_PATHS } from '../provider-security-settings.server';
import {
  providerSettingsViewFrame,
  PROVIDER_SETTINGS_VIEW_HEADER,
  PROVIDER_SETTINGS_OPERATION_HEADER,
} from '../provider-security-view';

const origin = 'https://www.boardsesh.test';
const now = new Date('2026-11-13T12:00:00.000Z');
const secret = 'owned-provider-settings-cookie-secret-6975';
const environment = {
  NEXTAUTH_URL: origin,
  NEXTAUTH_SECRET: secret,
  CURRENT_STORE_PROVIDER_SECURITY_MODE: 'backend-staging',
  CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
};
const metadata = { providerSecurityVersion: 1 as const, requestId: '12345678-1234-4234-8234-123456789abc' };
function selected(kind: 'legacy-jwe' | 'canonical-token' = 'canonical-token'): AdmittedBrowserSelection {
  return {
    status: 'admitted',
    bindingToken: 'A'.repeat(43),
    actor: {
      version: 2,
      credential:
        kind === 'canonical-token' ? { kind, token: 'actual-opaque-token' } : { kind, credential: 'actual-signed-JWE' },
    },
    cursor: {
      bindingId: providerBindingHash('A'.repeat(43)),
      version: 2,
      bindingExpiresAt: '2026-11-14T12:00:00.000Z',
    },
    session: {
      userId: 'owned-user',
      authSessionId: 'owned-session',
      generation: 3,
      authenticatedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-11-13T13:00:00.000Z',
      linkGuarded: true,
      requiresAccountCutoff: true,
    },
    user: { id: 'owned-user', email: 'owned@example.invalid', name: null, image: null },
  };
}
function flow(selection = selected()): ProviderSecurityFlow {
  const context = captureProviderBrowserContext(selection, now);
  return {
    version: 1,
    action: 'link',
    provider: 'apple',
    methodId: null,
    actorKind: context.actor.kind,
    actorCredentialHash: context.credentialHash,
    browserBindingHash: context.browserCursor.bindingId,
    browserVersion: context.browserCursor.version,
    browserBindingExpiresAt: context.browserCursor.bindingExpiresAt,
    sourceCredentialProof: { ...context.sourceCredentialProof },
    credentialExpiresAt: context.credentialExpiresAt,
    intentToken: 'B'.repeat(43),
    browserIntentToken: 'C'.repeat(43),
    recoveryToken: 'D'.repeat(43),
    issuedAt: now.toISOString(),
    expiresAt: '2026-11-13T12:15:00.000Z',
    reauthenticationToken: null,
    reauthenticationExpiresAt: null,
    providerFlowHash: null,
    googleFlowHash: null,
    googleNonce: null,
  };
}
const operationKey = providerSecurityOperationKey('B'.repeat(43));
const readSelection = vi.fn<(cookies: string | null) => Promise<PresentedBrowserSelection>>();
const execute = vi.fn<(operation: ProviderSecurityOperation, payload: unknown) => Promise<ProviderSecurityReply>>();
const client: ProviderSecurityCommandClient = {
  async command(operation, payload) {
    return (await execute(operation, payload)) as ProviderSecurityOperationReply<typeof operation>;
  },
};
const clientFactory = vi.fn(() => client);
const rateLimit = vi.fn(() => ({ limited: false, retryAfterSeconds: 0 }));
function broker(overrides: Parameters<typeof createProviderSecuritySettingsBroker>[0] = {}) {
  return createProviderSecuritySettingsBroker({
    environment,
    ready: () => true,
    readSelection,
    clientFactory,
    rateLimit,
    clock: () => new Date(now),
    ...overrides,
  });
}
function request(operation: keyof typeof PROVIDER_SETTINGS_PATHS, input?: unknown, headers?: HeadersInit): Request {
  const requestHeaders = new Headers({
    'content-type': 'application/json',
    origin,
    host: 'www.boardsesh.test',
    'sec-fetch-site': 'same-origin',
    cookie: 'actual-browser-proof=opaque; foreign-legacy-session=unrelated',
  });
  requestHeaders.set(
    PROVIDER_SETTINGS_VIEW_HEADER,
    createHash('sha256')
      .update(
        providerSettingsViewFrame({
          userId: selected().session.userId,
          authSessionId: selected().session.authSessionId,
          generation: selected().session.generation,
          cursor: { bindingId: selected().cursor.bindingId, version: selected().cursor.version },
        }),
      )
      .digest('hex'),
  );
  new Headers(headers).forEach((content, name) => requestHeaders.set(name, content));
  return new Request(`${origin}${PROVIDER_SETTINGS_PATHS[operation]}`, {
    method: operation === 'methods' || operation === 'resume' ? 'GET' : 'POST',
    headers: requestHeaders,
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
const intent = () => ({
  actorContextKey: captureProviderBrowserContext(selected(), now).actorContextKey,
  action: 'link',
  provider: 'apple',
});
const password = () => ({
  actorContextKey: intent().actorContextKey,
  operationKey,
  password: 'actual-entered-password',
});
async function cookieHeader(frame = flow()): Promise<string> {
  return `${providerSecurityFlowCookieName(operationKey, true)}=${await sealProviderSecurityFlow(frame, secret, now)}`;
}
function responseCookie(result: Response): string {
  const header = result.headers.getSetCookie();
  expect(header).toHaveLength(1);
  return header[0].split(';')[0];
}
beforeEach(() => {
  readSelection.mockReset().mockImplementation(async () => structuredClone(selected()));
  clientFactory.mockClear();
  rateLimit.mockReset().mockReturnValue({ limited: false, retryAfterSeconds: 0 });
  execute.mockReset().mockImplementation(async (operation) => {
    if (operation === 'methods')
      return {
        ...metadata,
        operation,
        outcome: 'available',
        passwordUsable: true,
        googleReauthenticationAvailable: false,
        configuredProviders: ['google', 'apple'],
        providers: [{ methodId: 'f'.repeat(64), provider: 'google', usable: true, canUnlink: true }],
      };
    if (operation === 'intent')
      return {
        ...metadata,
        operation,
        outcome: 'recorded',
        intentToken: 'B'.repeat(43),
        recoveryToken: 'D'.repeat(43),
        browserIntentToken: 'C'.repeat(43),
        browserCursor: selected().cursor,
        expiresAt: '2026-11-13T12:15:00.000Z',
      };
    if (operation === 'reauthenticate-password')
      return {
        ...metadata,
        operation,
        outcome: 'proved',
        reauthenticationToken: 'E'.repeat(43),
        expiresAt: '2026-11-13T12:05:00.000Z',
      };
    throw new Error('Unexpected private operation');
  });
});
afterEach(() => vi.useRealTimers());

describe('source-bound public provider Settings broker', () => {
  it('keeps the real public readiness gate dark despite environment and request claims', async () => {
    const result = await broker({
      ready: undefined,
      environment: { ...environment, PROVIDER_SECURITY_READY: 'true' },
    }).methods(request('methods', undefined, { 'x-provider-ready': 'true' }));
    expect(result.status).toBe(503);
    expect(readSelection).not.toHaveBeenCalled();
    expect(clientFactory).not.toHaveBeenCalled();
    expect(result.headers.getSetCookie()).toEqual([]);
  });
  it.each(['CURRENT_STORE_PROVIDER_SECURITY_MODE', 'CURRENT_STORE_BROWSER_BINDING_MODE'] as const)(
    'refuses absent required %s without fallback',
    async (mode) => {
      const result = await broker({ environment: { ...environment, [mode]: undefined } }).methods(request('methods'));
      expect(result.status).toBe(503);
      expect(readSelection).not.toHaveBeenCalled();
    },
  );
  it.each(['canonical-token', 'legacy-jwe'] as const)(
    'projects only source-free methods for the actual %s actor',
    async (kind) => {
      readSelection.mockImplementation(async () => structuredClone(selected(kind)));
      const result = await broker().methods(request('methods'));
      expect(result.status).toBe(200);
      const text = await result.text();
      expect(JSON.parse(text)).toMatchObject({
        outcome: 'available',
        methods: [{ provider: 'google' }],
        passwordUsable: true,
      });
      for (const privateField of [
        'actual-opaque-token',
        'actual-signed-JWE',
        'owned-user',
        'owned-session',
        'authenticatedAt',
        'browserBindingToken',
      ])
        expect(text).not.toContain(privateField);
      expect(readSelection).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenCalledWith('methods', {
        actor: captureProviderBrowserContext(selected(kind), now).actor,
      });
      expect(result.headers.get('cache-control')).toBe('no-store, private');
      expect(result.headers.getSetCookie()).toEqual([]);
    },
  );
  it.each([
    ['unavailable', 503, 'unavailable'],
    ['conflict', 409, 'identity_changed'],
    ['missing-binding', 401, 'unauthenticated'],
    ['proof-required', 401, 'unauthenticated'],
    ['denied', 401, 'unauthenticated'],
  ] as const)('preserves central %s refusal without a private command', async (status, expectedStatus, outcome) => {
    readSelection.mockResolvedValue({ status });
    const result = await broker().methods(request('methods'));
    expect(result.status).toBe(expectedStatus);
    expect(await result.json()).toEqual({ outcome });
    expect(execute).not.toHaveBeenCalled();
  });
  it('refuses a different accepted UI view before loading another account’s methods', async () => {
    const current = request('methods', undefined, { [PROVIDER_SETTINGS_VIEW_HEADER]: 'f'.repeat(64) });
    const result = await broker().methods(current);
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ outcome: 'identity_changed' });
    expect(execute).not.toHaveBeenCalled();
    expect(result.headers.getSetCookie()).toEqual([]);
  });
  it('requires the accepted view correlation header on methods', async () => {
    const current = request('methods');
    current.headers.delete(PROVIDER_SETTINGS_VIEW_HEADER);
    expect((await broker().methods(current)).status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
  it('resumes only actual owned flow metadata with no private command or bearer publication', async () => {
    const current = request('resume', undefined, {
      cookie: await cookieHeader(),
      [PROVIDER_SETTINGS_OPERATION_HEADER]: operationKey,
    });
    const result = await broker().resume(current);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      providerSecurityResumeVersion: 1,
      outcome: 'resumable',
      operationKey,
      actorContextKey: intent().actorContextKey,
      action: 'link',
      provider: 'apple',
      methodId: null,
      reauthenticationReady: false,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(readSelection).toHaveBeenCalledTimes(2);
    expect(result.headers.getSetCookie()).toEqual([]);
  });
  it('does not resume another account or emit fresh reauthentication proof', async () => {
    const current = request('resume', undefined, {
      cookie: await cookieHeader(),
      [PROVIDER_SETTINGS_OPERATION_HEADER]: operationKey,
    });
    readSelection.mockImplementation(async () => ({
      ...selected(),
      session: { ...selected().session, userId: 'different-user' },
      user: { ...selected().user, id: 'different-user' },
    }));
    expect((await broker().resume(current)).status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['https://attacker.invalid', 'null', 'https://app.boardsesh.test'])(
    'refuses POST Origin %s before reader or body consumption',
    async (claimedOrigin) => {
      const result = await broker().intent(request('intent', intent(), { origin: claimedOrigin }));
      expect(result.status).toBe(403);
      expect(readSelection).not.toHaveBeenCalled();
    },
  );
  it('refuses absent Origin and cross-site or same-site fetches before credentials', async () => {
    const missing = request('intent', intent());
    missing.headers.delete('origin');
    expect((await broker().intent(missing)).status).toBe(403);
    for (const site of ['cross-site', 'same-site'])
      expect((await broker().intent(request('intent', intent(), { 'sec-fetch-site': site }))).status).toBe(403);
    expect(readSelection).not.toHaveBeenCalled();
  });
  it('accepts the internal standalone URL only with canonical Host and exact configured POST Origin', async () => {
    const source = request('intent', intent());
    const current = new Request(`http://0.0.0.0:3000${PROVIDER_SETTINGS_PATHS.intent}`, {
      method: 'POST',
      headers: source.headers,
      body: await source.text(),
    });
    const result = await broker().intent(current);
    expect(result.status).toBe(200);
    expect(result.headers.getSetCookie()[0]).toContain('; Path=/; HttpOnly; Secure; SameSite=Lax;');
    expect(result.headers.get('location')).toBeNull();
  });
  it.each([
    undefined,
    'attacker.invalid',
    'www.boardsesh.test, attacker.invalid',
    'attacker.invalid, www.boardsesh.test',
  ])('refuses missing/wrong/combined Host %s despite forwarded assertions', async (host) => {
    const headers = new Headers({ origin, 'x-forwarded-host': 'www.boardsesh.test', 'x-forwarded-proto': 'https' });
    if (host !== undefined) headers.set('host', host);
    const current = new Request(`${origin}${PROVIDER_SETTINGS_PATHS.methods}`, { headers });
    expect((await broker().methods(current)).status).toBe(403);
    expect(readSelection).not.toHaveBeenCalled();
  });
  it.each(['link', 'unlink'] as const)(
    'seals %s command capabilities without exposing them in JSON or other cookies',
    async (action) => {
      const result = await broker().intent(
        request('intent', { ...intent(), action, ...(action === 'unlink' ? { methodId: 'f'.repeat(64) } : {}) }),
      );
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ outcome: 'reauthentication_required', operationKey });
      const cookie = responseCookie(result);
      const opened = await openProviderSecurityFlow(cookie.slice(cookie.indexOf('=') + 1), operationKey, secret, now);
      expect(opened).toMatchObject({ ...flow(), action, methodId: action === 'unlink' ? 'f'.repeat(64) : null });
      expect(cookie).not.toContain('B'.repeat(43));
      expect(result.headers.getSetCookie()[0]).toContain('; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=');
      expect(execute).toHaveBeenCalledWith('intent', {
        actor: captureProviderBrowserContext(selected(), now).actor,
        action,
        provider: 'apple',
        methodId: action === 'unlink' ? 'f'.repeat(64) : null,
      });
    },
  );
  it('checks the expected UI actor key before creating any intent', async () => {
    const result = await broker().intent(request('intent', { ...intent(), actorContextKey: '0'.repeat(64) }));
    expect(result.status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
    expect(result.headers.getSetCookie()).toEqual([]);
  });
  it('conservatively caps the sealed web deadline when the backend clock is ahead', async () => {
    execute.mockResolvedValue({
      ...metadata,
      operation: 'intent',
      outcome: 'recorded',
      intentToken: 'B'.repeat(43),
      recoveryToken: 'D'.repeat(43),
      browserIntentToken: 'C'.repeat(43),
      browserCursor: selected().cursor,
      expiresAt: '2026-11-13T12:15:00.100Z',
    });
    const result = await broker().intent(request('intent', intent()));
    expect(result.status).toBe(200);
    const cookie = responseCookie(result);
    const opened = await openProviderSecurityFlow(cookie.slice(cookie.indexOf('=') + 1), operationKey, secret, now);
    expect(opened.expiresAt).toBe('2026-11-13T12:15:00.000Z');
    expect(opened.credentialExpiresAt).toBe(flow().credentialExpiresAt);
    expect(opened.sourceCredentialProof).toEqual(flow().sourceCredentialProof);
  });
  it.each([undefined, '', 'too-short', ` ${secret}`])(
    'refuses an unusable sealing key before creating an intent (%s)',
    async (invalidSecret) => {
      const result = await broker({ environment: { ...environment, NEXTAUTH_SECRET: invalidSecret } }).intent(
        request('intent', intent()),
      );
      expect(result.status).toBe(503);
      expect(readSelection).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(result.headers.getSetCookie()).toEqual([]);
    },
  );
  it.each([{ actor: selected().actor }, { credential: 'hostile' }, { provider: 'facebook' }])(
    'rejects caller-owned actor/credential/provider fields %j',
    async (extra) => {
      const result = await broker().intent(request('intent', { ...intent(), ...extra }));
      expect(result.status).toBe(400);
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('withholds a new intent cookie when the current actor changes during private work', async () => {
    readSelection.mockResolvedValueOnce(selected()).mockResolvedValueOnce({ status: 'conflict' });
    const result = await broker().intent(request('intent', intent()));
    expect(result.status).toBe(409);
    expect(result.headers.getSetCookie()).toEqual([]);
  });
  it('withholds methods during primary outage after the private command', async () => {
    readSelection.mockResolvedValueOnce(selected()).mockResolvedValueOnce({ status: 'unavailable' });
    const result = await broker().methods(request('methods'));
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ outcome: 'unavailable' });
  });
  it('requires the actual password comparison and stores only the resulting sealed proof', async () => {
    const input = password();
    const result = await broker().reauthenticatePassword(request('password', input, { cookie: await cookieHeader() }));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ outcome: 'completed', operationKey });
    expect(execute).toHaveBeenCalledWith('reauthenticate-password', {
      actor: captureProviderBrowserContext(selected(), now).actor,
      intentToken: flow().intentToken,
      browserIntentToken: flow().browserIntentToken,
      password: input.password,
    });
    const cookie = responseCookie(result);
    const opened = await openProviderSecurityFlow(cookie.slice(cookie.indexOf('=') + 1), operationKey, secret, now);
    expect(opened).toEqual({
      ...flow(),
      reauthenticationToken: 'E'.repeat(43),
      reauthenticationExpiresAt: '2026-11-13T12:05:00.000Z',
    });
    expect(cookie).not.toContain(input.password);
    expect(cookie).not.toContain('E'.repeat(43));
    expect(opened.sourceCredentialProof.authenticatedAt).toBe('2026-08-01T00:00:00.000Z');
  });
  it('caps an ahead-clock password receipt to the existing web intent deadline', async () => {
    const later = new Date(now.getTime() + 10 * 60_000);
    execute.mockResolvedValue({
      ...metadata,
      operation: 'reauthenticate-password',
      outcome: 'proved',
      reauthenticationToken: 'E'.repeat(43),
      expiresAt: '2026-11-13T12:15:00.100Z',
    });
    const result = await broker({ clock: () => later }).reauthenticatePassword(
      request('password', password(), { cookie: await cookieHeader() }),
    );
    expect(result.status).toBe(200);
    const cookie = responseCookie(result);
    const opened = await openProviderSecurityFlow(cookie.slice(cookie.indexOf('=') + 1), operationKey, secret, later);
    expect(opened.reauthenticationExpiresAt).toBe(flow().expiresAt);
    expect(opened.sourceCredentialProof).toEqual(flow().sourceCredentialProof);
    expect(opened.credentialExpiresAt).toBe(flow().credentialExpiresAt);
  });
  it.each(['missing', 'duplicate', 'plaintext'] as const)(
    'refuses %s operation cookie before password comparison',
    async (type) => {
      const actual = await cookieHeader();
      const cookies =
        type === 'missing'
          ? ''
          : type === 'duplicate'
            ? `${actual}; ${actual}`
            : `${providerSecurityFlowCookieName(operationKey, true)}=${flow().intentToken}`;
      const result = await broker().reauthenticatePassword(request('password', password(), { cookie: cookies }));
      expect(result.status).toBe(type === 'plaintext' ? 503 : 400);
      expect(execute).not.toHaveBeenCalled();
      expect(result.headers.getSetCookie()).toEqual([]);
    },
  );
  it('does not consume the old sealed flow after a same-account generation changes', async () => {
    const current = selected();
    const previous = await cookieHeader();
    const changed = { ...current, session: { ...current.session, generation: current.session.generation + 1 } };
    readSelection.mockResolvedValue(changed);
    const result = await broker().reauthenticatePassword(
      request(
        'password',
        { ...password(), actorContextKey: captureProviderBrowserContext(changed, now).actorContextKey },
        { cookie: previous },
      ),
    );
    expect(result.status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  });
  it('withholds a verified proof cookie after primary availability changes', async () => {
    readSelection.mockResolvedValueOnce(selected()).mockResolvedValueOnce({ status: 'unavailable' });
    const result = await broker().reauthenticatePassword(
      request('password', password(), { cookie: await cookieHeader() }),
    );
    expect(result.status).toBe(503);
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('retains wrong-password refusal and does not emit any cookie', async () => {
    execute.mockResolvedValue({
      ...metadata,
      operation: 'reauthenticate-password',
      outcome: 'denied',
      code: 'invalid_proof',
    });
    const result = await broker().reauthenticatePassword(
      request('password', password(), { cookie: await cookieHeader() }),
    );
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ outcome: 'denied' });
    expect(result.headers.getSetCookie()).toEqual([]);
  });
  it('bounds password attempts using only the primary account, before the private comparison', async () => {
    rateLimit.mockReturnValue({ limited: true, retryAfterSeconds: 37 });
    const result = await broker().reauthenticatePassword(
      request('password', password(), { cookie: await cookieHeader(), 'x-forwarded-for': 'hostile-shared-proxy' }),
    );
    expect(result.status).toBe(429);
    expect(result.headers.get('retry-after')).toBe('37');
    expect(rateLimit).toHaveBeenCalledExactlyOnceWith('provider-security:password:owned-user', 5, 60_000);
    expect(execute).not.toHaveBeenCalled();
    expect(result.headers.getSetCookie()).toEqual([]);
  });
  it('bounds intent creation even when a caller discards its returned operation cookies', async () => {
    rateLimit.mockReturnValue({ limited: true, retryAfterSeconds: 20 });
    const result = await broker().intent(request('intent', intent()));
    expect(result.status).toBe(429);
    expect(rateLimit).toHaveBeenCalledExactlyOnceWith('provider-security:intent:owned-user', 10, 60_000);
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects actual UTF8 byte overflow rather than accepting a character-count budget', async () => {
    const oversized = JSON.stringify({ ...password(), password: '🧗'.repeat(16_384) });
    expect(oversized.length).toBeLessThan(65_536);
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(65_536);
    const current = new Request(`${origin}${PROVIDER_SETTINGS_PATHS.password}`, {
      method: 'POST',
      headers: { origin, host: 'www.boardsesh.test', 'content-type': 'application/json' },
      body: oversized,
    });
    expect((await broker().reauthenticatePassword(current)).status).toBe(400);
    expect(readSelection).not.toHaveBeenCalled();
  });
  it.each(['text/plain', 'application/json; charset=latin1'])(
    'refuses unsupported body type %s',
    async (contentType) => {
      expect((await broker().intent(request('intent', intent(), { 'content-type': contentType }))).status).toBe(400);
      expect(readSelection).not.toHaveBeenCalled();
    },
  );
  it('rejects malformed UTF8 and declared length drift before an actor read', async () => {
    const malformed = new Request(`${origin}${PROVIDER_SETTINGS_PATHS.intent}`, {
      method: 'POST',
      headers: { origin, host: 'www.boardsesh.test', 'content-type': 'application/json' },
      body: new Uint8Array([0xff]),
    });
    expect((await broker().intent(malformed)).status).toBe(400);
    expect((await broker().intent(request('intent', intent(), { 'content-length': '1' }))).status).toBe(400);
    expect(readSelection).not.toHaveBeenCalled();
  });
  it('bounds a body stream that never delivers data without attempting a command', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const current = new Request(`${origin}${PROVIDER_SETTINGS_PATHS.intent}`, {
      method: 'POST',
      headers: { origin, host: 'www.boardsesh.test', 'content-type': 'application/json' },
      body: new ReadableStream({ cancel }),
      duplex: 'half',
    } as RequestInit);
    const pending = broker().intent(current);
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await pending;
    expect(result.status).toBe(400);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not accept a valid JSON prefix when deadline cancellation closes an unfinished stream', async () => {
    vi.useFakeTimers();
    const current = new Request(`${origin}${PROVIDER_SETTINGS_PATHS.intent}`, {
      method: 'POST',
      headers: { origin, host: 'www.boardsesh.test', 'content-type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(intent())));
        },
      }),
      duplex: 'half',
    } as RequestInit);
    const pending = broker().intent(current);
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await pending;
    expect(result.status).toBe(400);
    expect(readSelection).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.headers.getSetCookie()).toEqual([]);
  });
  it('suppresses a sealed proof when the request aborts during private work', async () => {
    const controller = new AbortController();
    const current = request('password', password(), { cookie: await cookieHeader() });
    const aborted = new Request(current, { signal: controller.signal });
    const defaultExecute = execute.getMockImplementation();
    execute.mockImplementationOnce(async (operation, payload) => {
      controller.abort();
      return await defaultExecute!(operation, payload);
    });
    const result = await broker().reauthenticatePassword(aborted);
    expect(result.status).toBe(503);
    expect(result.headers.getSetCookie()).toEqual([]);
  });
});
