// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  provider: false,
  legacy: vi.fn(),
  session: vi.fn(),
}));
vi.mock('next-auth/react', () => ({ signIn: fixture.legacy, getSession: fixture.session }));
vi.mock('../provider-security-readiness', () => ({ publicProviderSecurityReady: () => fixture.provider }));
import { signInWithSessionIntent } from '../web-session-events';

const origin = 'https://www.provider-intent.example.test';
let send: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  fixture.provider = false;
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
    expect(send).not.toHaveBeenCalled();
    expect(fixture.session).toHaveBeenCalledOnce();
  });
  it.each(['google', 'apple'] as const)(
    'refuses %s while the provider security gate is on, with no legacy fallback',
    async (provider) => {
      fixture.provider = true;
      expect(await signInWithSessionIntent(provider, { callbackUrl: '/' })).toMatchObject({ ok: false, status: 503 });
      expect(fixture.legacy).not.toHaveBeenCalled();
      expect(fixture.session).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );
  it('keeps the existing credential call contract intact with the public gate false', async () => {
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
  it('refuses credentials while the provider security gate is on', async () => {
    fixture.provider = true;
    expect(
      await signInWithSessionIntent('credentials', {
        redirect: false,
        email: 'owned@example.test',
        password: 'supplied-password',
      }),
    ).toMatchObject({ ok: false, status: 503 });
    expect(fixture.legacy).not.toHaveBeenCalled();
    expect(fixture.session).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
