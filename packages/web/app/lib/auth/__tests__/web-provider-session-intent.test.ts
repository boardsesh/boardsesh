// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_COORDINATOR_LOCK } from '@boardsesh/auth-protocol/browser-coordinator';
const fixture = vi.hoisted(() => ({
  coordinator: false,
  provider: false,
  preflight: vi.fn(),
  legacy: vi.fn(),
  session: vi.fn(),
}));
vi.mock('next-auth/react', () => ({ signIn: fixture.legacy, getSession: fixture.session }));
vi.mock('../browser-coordinator-readiness', () => ({ publicBrowserCoordinatorReady: () => fixture.coordinator }));
vi.mock('../provider-security-readiness', () => ({ publicProviderSecurityReady: () => fixture.provider }));
vi.mock('../browser-coordinator-client', () => ({ readCanonicalBrowserCoordinator: fixture.preflight }));
import { registerCanonicalBrowserOrigin, getCanonicalBrowserOrigin } from '../canonical-browser-origin';
import { signInWithSessionIntent } from '../web-session-events';

const origin = 'https://www.provider-intent.example.test';
const authorization = 'https://accounts.google.com/o/oauth2/v2/auth?state=actual-state';
const cleanups: Array<() => void> = [];
let held: boolean;
let navigate: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.fn<typeof fetch>>;
let lock: ReturnType<typeof vi.fn>;
function href(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
beforeEach(() => {
  fixture.coordinator = false;
  fixture.provider = false;
  held = false;
  fixture.preflight.mockReset().mockImplementation(async () => {
    expect(held).toBe(false);
  });
  fixture.legacy.mockReset().mockResolvedValue({ ok: true, status: 200, error: undefined, url: null });
  fixture.session.mockReset().mockResolvedValue(null);
  navigate = vi.fn(() => {
    expect(held).toBe(false);
  });
  lock = vi.fn(async (name: string, _options: unknown, invoke: () => Promise<void>) => {
    expect(name).toBe(BROWSER_COORDINATOR_LOCK);
    held = true;
    try {
      await invoke();
    } finally {
      held = false;
    }
  });
  send = vi.fn<typeof fetch>(async (input, options) => {
    expect(held).toBe(true);
    expect(options?.keepalive).toBe(false);
    expect(options?.redirect).toBe('error');
    if (href(input).endsWith('/acknowledge')) return Response.json({ outcome: 'none' });
    if (href(input).endsWith('/csrf')) return Response.json({ csrfToken: 'actual-csrf' });
    return Response.json({ url: authorization });
  });
  vi.stubGlobal('window', { location: { origin, assign: navigate }, dispatchEvent: vi.fn() });
  vi.stubGlobal('navigator', { locks: { request: lock } });
  vi.stubGlobal('fetch', send);
});
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
  vi.unstubAllGlobals();
});
function qualify() {
  fixture.coordinator = true;
  fixture.provider = true;
  cleanups.push(registerCanonicalBrowserOrigin(origin));
}
describe('shared WWW provider sign-in wrapper', () => {
  it('retains ordinary legacy provider behavior while the code gates are false', async () => {
    expect((await signInWithSessionIntent('google', { callbackUrl: '/' }))?.ok).toBe(true);
    expect(fixture.legacy).toHaveBeenCalledExactlyOnceWith('google', { callbackUrl: '/' });
    expect(fixture.preflight).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(fixture.session).toHaveBeenCalledOnce();
  });
  it('joins actual static-origin preflight, WWW lock, ACK/CSRF/start and navigation without a naked session read', async () => {
    qualify();
    expect(await signInWithSessionIntent('google', { callbackUrl: '/settings' })).toBeUndefined();
    expect(fixture.preflight).toHaveBeenCalledExactlyOnceWith(origin, expect.any(AbortSignal));
    expect(lock).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(authorization);
    expect(send).toHaveBeenCalledTimes(3);
    expect(fixture.legacy).not.toHaveBeenCalled();
    expect(fixture.session).not.toHaveBeenCalled();
  });
  it('joins exact localized Settings link fields through the same actual transport', async () => {
    qualify();
    const key = 'a'.repeat(64);
    const original = send.getMockImplementation()!;
    send.mockImplementation(async (input, options) => {
      if (href(input).endsWith('/signin/google')) {
        if (!(options?.body instanceof URLSearchParams)) throw new Error('Expected actual OAuth form');
        expect(Object.fromEntries(options.body)).toEqual({
          csrfToken: 'actual-csrf',
          callbackUrl: `${origin}/fr/settings?providerSecurityResume=${key}`,
          json: 'true',
          providerSecurityOperation: 'link',
          providerSecurityOperationKey: key,
        });
      }
      return original(input, options);
    });
    await signInWithSessionIntent('google', {
      callbackUrl: `${origin}/fr/settings?providerSecurityResume=${key}`,
      providerSecurityOperation: 'link',
      providerSecurityOperationKey: key,
    });
    expect(navigate).toHaveBeenCalledOnce();
    expect(fixture.legacy).not.toHaveBeenCalled();
  });
  it.each(['coordinator', 'provider'] as const)('refuses partially qualified %s without fallback', async (gate) => {
    fixture[gate] = true;
    cleanups.push(registerCanonicalBrowserOrigin(origin));
    expect(await signInWithSessionIntent('google')).toMatchObject({ ok: false, status: 503 });
    expect(send).not.toHaveBeenCalled();
    expect(fixture.legacy).not.toHaveBeenCalled();
    expect(fixture.session).not.toHaveBeenCalled();
  });
  it('does not infer an absent canonical origin from the actual document URL', async () => {
    fixture.coordinator = true;
    fixture.provider = true;
    expect(await signInWithSessionIntent('google')).toMatchObject({ ok: false, status: 503 });
    expect(send).not.toHaveBeenCalled();
    expect(fixture.preflight).not.toHaveBeenCalled();
  });
  it('keeps registration scoped and refuses conflicting static authorities', async () => {
    const first = registerCanonicalBrowserOrigin(origin);
    const second = registerCanonicalBrowserOrigin(origin);
    expect(getCanonicalBrowserOrigin()).toBe(origin);
    first();
    expect(getCanonicalBrowserOrigin()).toBe(origin);
    const other = registerCanonicalBrowserOrigin('https://other.example.test');
    expect(getCanonicalBrowserOrigin()).toBeNull();
    other();
    expect(getCanonicalBrowserOrigin()).toBe(origin);
    second();
    expect(getCanonicalBrowserOrigin()).toBeNull();
  });
  it.each([
    { userId: 'claimed-user' },
    { actor: null },
    { providerSecurityOperation: 'link' },
    { providerSecurityOperationKey: 'a'.repeat(64) },
  ])('rejects extra or incomplete provider input %j before transport', async (options) => {
    qualify();
    expect(await signInWithSessionIntent('google', options)).toMatchObject({ ok: false, status: 503 });
    expect(send).not.toHaveBeenCalled();
    expect(fixture.preflight).not.toHaveBeenCalled();
    expect(fixture.legacy).not.toHaveBeenCalled();
  });
  it('carries a captured Settings lifetime abort through physical pending network settlement', async () => {
    qualify();
    const external = new AbortController();
    let resolveNetwork!: (response: Response) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const network = new Promise<Response>((resolve) => {
      resolveNetwork = resolve;
    });
    const original = send.getMockImplementation()!;
    send.mockImplementation(async (input, options) => {
      if (href(input).endsWith('/signin/google')) {
        signalStarted();
        return network;
      }
      return original(input, options);
    });
    const operation = signInWithSessionIntent('google', { callbackUrl: '/settings' }, { signal: external.signal });
    await started;
    external.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(held).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    resolveNetwork(Response.json({ url: authorization }));
    expect(await operation).toMatchObject({ ok: false, status: 503 });
    expect(held).toBe(false);
    expect(send).toHaveBeenCalledTimes(3);
    expect(fixture.legacy).not.toHaveBeenCalled();
    expect(fixture.session).not.toHaveBeenCalled();
  });
  it('keeps the existing credential call contract intact', async () => {
    qualify();
    await signInWithSessionIntent('credentials', {
      redirect: false,
      email: 'owned@example.test',
      password: 'supplied-password',
    });
    expect(fixture.legacy).toHaveBeenCalledExactlyOnceWith('credentials', {
      redirect: false,
      email: 'owned@example.test',
      password: 'supplied-password',
    });
    expect(send).not.toHaveBeenCalled();
    expect(fixture.session).toHaveBeenCalledOnce();
  });
});
