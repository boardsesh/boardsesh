// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { createProviderSettingsClient } from '../provider-security-client';
import { providerSettingsViewFrame, PROVIDER_SETTINGS_VIEW_HEADER } from '../provider-security-view';
import type { ProviderMethodAction } from '@/app/components/account/provider-methods-section';
import type { signInWithSessionIntent } from '../web-session-events';

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
const owner = (userId = 'owned-user', generation = 3) => ({
  userId,
  authSessionId: `sid-${userId}`,
  generation,
  cursor: { bindingId: 'a'.repeat(64), version: 2 },
});
function selected(userId = 'owned-user', generation = 3) {
  const scope = owner(userId, generation);
  return {
    user: { id: userId },
    authSessionId: scope.authSessionId,
    authGeneration: generation,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: scope,
  };
}
const methods = () => ({
  outcome: 'available',
  actorContextKey: 'a'.repeat(64),
  methods: [{ methodId: 'c'.repeat(64), provider: 'google', usable: true, canUnlink: true }],
  configuredProviders: ['google', 'apple'],
  passwordUsable: true,
  googleReauthenticationAvailable: true,
});
const unlink = { action: 'unlink', provider: 'google', methodId: 'c'.repeat(64) } as const;
const operationKey = 'b'.repeat(64);
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});
function fixture(
  options: {
    ready?: () => boolean;
    response?: (path: string, init: RequestInit | undefined) => Promise<Response>;
  } = {},
) {
  const authority = createBrowserBackendClient({
    ready: () => true,
    fetch: async () => {
      throw new Error('No lease network expected');
    },
    endpoint: '/unused',
    now: () => 1,
    schedule: () => () => {},
  });
  const session = selected();
  authority.acceptSession(session);
  const send = vi.fn<typeof fetch>(async (input, init) => {
    const path = requestUrl(input);
    if (options.response) return options.response(path, init);
    if (path.endsWith('/methods')) return Response.json(methods());
    if (path.endsWith('/intent')) return Response.json({ outcome: 'reauthentication_required', operationKey });
    if (path.endsWith('/reauthenticate-password')) return Response.json({ outcome: 'completed', operationKey });
    if (path.endsWith('/acknowledge')) return Response.json({ outcome: 'identity_changed' }, { status: 409 });
    if (path.endsWith('/resume'))
      return Response.json({
        providerSecurityResumeVersion: 1,
        outcome: 'resumable',
        operationKey,
        actorContextKey: 'a'.repeat(64),
        action: 'unlink',
        provider: 'google',
        methodId: 'c'.repeat(64),
        reauthenticationReady: true,
      });
    if (path.endsWith('/unlink')) return Response.json({ outcome: 'completed' });
    throw new Error('Unexpected Settings route');
  });
  const signIn = vi.fn<typeof signInWithSessionIntent>(async () => undefined);
  const invalidate = vi.fn(() => authority.retire());
  const refresh = vi.fn();
  const onOperation = vi.fn();
  const client = createProviderSettingsClient({
    session,
    authority,
    ready: options.ready ?? (() => true),
    fetch: send,
    signIn,
    invalidate,
    refresh,
    onOperation,
    locale: 'fr',
    canonicalOrigin: 'https://www.boardsesh.test',
    hash: async (frame) => createHash('sha256').update(frame).digest('hex'),
  });
  cleanups.push(() => {
    client.dispose();
    authority.dispose();
  });
  return { authority, session, send, client, signIn, invalidate, refresh, onOperation };
}
async function prepared(current: ReturnType<typeof fixture>) {
  await current.client.readMethods();
  expect(await current.client.action(unlink)).toEqual({ outcome: 'reauthentication_required' });
  expect(await current.client.reauthenticate({ method: 'password', password: ' exact password ' })).toEqual({
    outcome: 'completed',
  });
}
async function untilDispatched(current: ReturnType<typeof fixture>, suffix: string) {
  for (let index = 0; index < 50; index++) {
    if (current.send.mock.calls.some(([path]) => requestUrl(path).endsWith(suffix))) return;
    await Promise.resolve();
  }
  throw new Error('Expected owned request not dispatched');
}

describe('provider Settings accepted-view client', () => {
  it('correlates methods with the actual accepted public view and retains no bearer', async () => {
    const current = fixture();
    expect(await current.client.readMethods()).toEqual(methods());
    const request = current.send.mock.calls[0]![1]!;
    expect(new Headers(request.headers).get(PROVIDER_SETTINGS_VIEW_HEADER)).toBe(
      createHash('sha256').update(providerSettingsViewFrame(owner())).digest('hex'),
    );
    expect(request.credentials).toBe('include');
    expect(request.cache).toBe('no-store');
    expect(new Headers(request.headers).get('authorization')).toBeNull();
  });
  it('runs explicit intent, actual password and one unlink before refreshing primary', async () => {
    const current = fixture();
    await prepared(current);
    expect(await current.client.action(unlink)).toEqual({ outcome: 'completed' });
    expect(current.send.mock.calls.map(([path]) => requestUrl(path).split('/').at(-1))).toEqual([
      'methods',
      'intent',
      'reauthenticate-password',
      'unlink',
    ]);
    expect(JSON.parse(current.send.mock.calls[2]![1]!.body as string)).toEqual({
      actorContextKey: 'a'.repeat(64),
      operationKey,
      password: ' exact password ',
    });
    expect(current.onOperation.mock.calls).toEqual([[operationKey], [null]]);
    expect(current.invalidate).toHaveBeenCalledTimes(1);
    expect(current.refresh).toHaveBeenCalledTimes(1);
  });
  it('retires the exact UI view when methods confirms its selection changed', async () => {
    const current = fixture({ response: async () => Response.json({ outcome: 'identity_changed' }, { status: 409 }) });
    await expect(current.client.readMethods()).rejects.toThrow();
    expect(current.invalidate).toHaveBeenCalledTimes(1);
    expect(current.refresh).toHaveBeenCalledTimes(1);
  });
  it('starts only qualified Google verification and an exact localized Settings return', async () => {
    const current = fixture();
    await current.client.readMethods();
    await current.client.action(unlink);
    expect(await current.client.reauthenticate({ method: 'google' })).toEqual({ outcome: 'redirecting' });
    expect(current.signIn).toHaveBeenCalledExactlyOnceWith(
      'google',
      {
        callbackUrl: `https://www.boardsesh.test/fr/settings?providerSecurityResume=${operationKey}`,
        providerSecurityOperation: 'reauthenticate-google',
        providerSecurityOperationKey: operationKey,
      },
      { signal: expect.any(AbortSignal) },
    );
    const captured = current.signIn.mock.calls[0]?.[2]?.signal;
    expect(captured?.aborted).toBe(false);
    current.authority.acceptSession(selected('other-user'));
    expect(captured?.aborted).toBe(true);
  });
  it('links Apple only after operation-bound password verification', async () => {
    const current = fixture();
    await current.client.readMethods();
    const action = { action: 'link', provider: 'apple' } as const;
    await current.client.action(action);
    expect(current.signIn).not.toHaveBeenCalled();
    await current.client.reauthenticate({ method: 'password', password: ' exact password ' });
    expect(await current.client.action(action)).toEqual({ outcome: 'redirecting' });
    expect(current.signIn.mock.calls[0]?.[0]).toBe('apple');
    expect(current.signIn.mock.calls[0]?.[1]).toMatchObject({
      providerSecurityOperation: 'link',
      providerSecurityOperationKey: operationKey,
    });
  });
  it('resumes the sealed operation only after a read-only ACK refusal', async () => {
    const current = fixture();
    await current.client.readMethods();
    expect(await current.client.resume(operationKey)).toMatchObject({
      status: 'resumable',
      metadata: { reauthenticationReady: true, action: 'unlink' },
    });
    expect(await current.client.action(unlink)).toEqual({ outcome: 'completed' });
    expect(current.send.mock.calls.map(([path]) => requestUrl(path).split('/').at(-1))).toEqual([
      'methods',
      'acknowledge',
      'resume',
      'unlink',
    ]);
  });
  it('keeps current B alive when stale A’s held unlink rejects on retirement', async () => {
    const current = fixture();
    await prepared(current);
    const defaultSend = current.send.getMockImplementation()!;
    current.send.mockImplementation(async (input, init) =>
      requestUrl(input).endsWith('/unlink') ? new Promise<Response>(() => {}) : defaultSend(input, init),
    );
    const pending = current.client.action(unlink);
    await untilDispatched(current, '/unlink');
    const later = selected('later-user');
    current.authority.acceptSession(later);
    expect(await pending).toEqual({ outcome: 'identity_changed' });
    expect(current.invalidate).not.toHaveBeenCalled();
    expect(current.refresh).not.toHaveBeenCalled();
    expect(current.authority.isSessionCurrent(later)).toBe(true);
  });
  it('refuses A→B→A resurrection before a new request', async () => {
    const current = fixture();
    await current.client.readMethods();
    current.authority.acceptSession(selected('later-user'));
    current.authority.acceptSession(selected());
    expect(await current.client.action(unlink)).toEqual({ outcome: 'identity_changed' });
    expect(current.send).toHaveBeenCalledTimes(1);
    expect(current.onOperation).not.toHaveBeenCalled();
  });
  it.each(['unavailable', 'malformed-success'] as const)(
    'retires only captured A after an uncertain %s unlink reply',
    async (mode) => {
      const current = fixture();
      await prepared(current);
      const defaultSend = current.send.getMockImplementation()!;
      current.send.mockImplementation(async (input, init) =>
        requestUrl(input).endsWith('/unlink')
          ? mode === 'unavailable'
            ? Response.json({ outcome: 'unavailable' }, { status: 503 })
            : Response.json({ unrelated: true })
          : defaultSend(input, init),
      );
      expect(await current.client.action(unlink)).toEqual({ outcome: 'unavailable' });
      expect(current.invalidate).toHaveBeenCalledTimes(1);
      expect(current.refresh).toHaveBeenCalledTimes(1);
      expect(current.onOperation.mock.calls).toEqual([[operationKey]]);
      expect(current.send.mock.calls.filter(([path]) => requestUrl(path).endsWith('/unlink'))).toHaveLength(1);
    },
  );
  it.each(['fetch', 'json'] as const)(
    'bounds an abort-ignoring %s during unknown unlink acknowledgement',
    async (kind) => {
      const current = fixture();
      await prepared(current);
      const timeout = new AbortController();
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
      const defaultSend = current.send.getMockImplementation()!;
      current.send.mockImplementation(async (input, init) => {
        if (!requestUrl(input).endsWith('/unlink')) return defaultSend(input, init);
        if (kind === 'fetch') return new Promise<Response>(() => {});
        const response = new Response(null, { status: 200 });
        vi.spyOn(response, 'json').mockImplementation(() => new Promise<unknown>(() => {}));
        return response;
      });
      const pending = current.client.action(unlink);
      await untilDispatched(current, '/unlink');
      await Promise.resolve();
      timeout.abort();
      expect(await pending).toEqual({ outcome: 'unavailable' });
      expect(timeoutSpy).toHaveBeenCalledWith(15_000);
      expect(current.invalidate).toHaveBeenCalledTimes(1);
      expect(current.refresh).toHaveBeenCalledTimes(1);
    },
  );
  it('cannot treat a copied public session tuple as an accepted session', async () => {
    const current = fixture();
    const send = vi.fn<typeof fetch>();
    const copied = createProviderSettingsClient({
      session: structuredClone(current.session),
      authority: current.authority,
      fetch: send,
      ready: () => true,
      locale: 'en-US',
      canonicalOrigin: 'https://www.boardsesh.test',
    });
    cleanups.push(() => copied.dispose());
    await expect(copied.readMethods()).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it('never starts a Facebook intent even from an invalid runtime caller', async () => {
    const current = fixture();
    await current.client.readMethods();
    expect(
      await current.client.action({ action: 'link', provider: 'facebook' } as unknown as ProviderMethodAction),
    ).toEqual({ outcome: 'unavailable' });
    expect(current.send).toHaveBeenCalledTimes(1);
    expect(current.signIn).not.toHaveBeenCalled();
  });
  it('keeps the default code-owned gate dark before dispatch', async () => {
    const current = fixture({ ready: () => false });
    await expect(current.client.readMethods()).rejects.toThrow();
    expect(current.send).not.toHaveBeenCalled();
  });
});
