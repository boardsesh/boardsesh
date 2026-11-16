// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  coordinator: false,
  provider: false,
  signIn: vi.fn(),
  legacy: vi.fn(),
  session: vi.fn(),
}));
vi.mock('next-auth/react', () => ({ signIn: fixture.legacy, getSession: fixture.session }));
vi.mock('../browser-coordinator-readiness', () => ({ publicBrowserCoordinatorReady: () => fixture.coordinator }));
vi.mock('../provider-security-readiness', () => ({ publicProviderSecurityReady: () => fixture.provider }));
vi.mock('../browser-coordinator-client', () => ({ signInCanonicalBrowserCoordinator: fixture.signIn }));
import { registerCanonicalBrowserOrigin, getCanonicalBrowserOrigin } from '../canonical-browser-origin';
import { signInWithSessionIntent } from '../web-session-events';

const origin = 'https://www.provider-intent.example.test';
let send: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  fixture.coordinator = false;
  fixture.provider = false;
  fixture.signIn.mockReset();
  fixture.legacy.mockReset().mockResolvedValue({ ok: true, status: 200, error: undefined, url: null });
  fixture.session.mockReset().mockResolvedValue(null);
  send = vi.fn<typeof fetch>(async () => Response.json({}));
  vi.stubGlobal('window', { location: { origin, assign: vi.fn() }, dispatchEvent: vi.fn() });
  vi.stubGlobal('navigator', { locks: { request: vi.fn() } });
  vi.stubGlobal('fetch', send);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe('shared WWW sign-in wrapper', () => {
  it.each(['google', 'apple'] as const)('hands %s to the legacy NextAuth sign-in', async (provider) => {
    expect((await signInWithSessionIntent(provider, { callbackUrl: '/' }))?.ok).toBe(true);
    expect(fixture.legacy).toHaveBeenCalledExactlyOnceWith(provider, { callbackUrl: '/' });
    expect(fixture.signIn).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(fixture.session).toHaveBeenCalledOnce();
  });
  it.each([
    ['google', 'coordinator'],
    ['apple', 'coordinator'],
    ['google', 'provider'],
    ['apple', 'provider'],
  ] as const)('refuses %s while the %s gate is on, with no legacy fallback', async (provider, gate) => {
    fixture[gate] = true;
    expect(await signInWithSessionIntent(provider, { callbackUrl: '/' })).toMatchObject({ ok: false, status: 503 });
    expect(fixture.legacy).not.toHaveBeenCalled();
    expect(fixture.session).not.toHaveBeenCalled();
    expect(fixture.signIn).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it('keeps registration scoped and refuses conflicting static authorities', () => {
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
  it('keeps the existing credential call contract intact with the public gates false', async () => {
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
  it('refuses qualified credentials without a selected password publisher', async () => {
    fixture.coordinator = true;
    expect(
      await signInWithSessionIntent('credentials', {
        redirect: false,
        email: 'owned@example.test',
        password: 'supplied-password',
      }),
    ).toMatchObject({ ok: false, status: 503 });
    expect(fixture.legacy).not.toHaveBeenCalled();
    expect(fixture.session).not.toHaveBeenCalled();
    expect(fixture.signIn).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
