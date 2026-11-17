// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  legacy: vi.fn(),
  session: vi.fn(),
}));
vi.mock('next-auth/react', () => ({ signIn: fixture.legacy, getSession: fixture.session }));
import { signInWithSessionIntent } from '../web-session-events';

const origin = 'https://www.provider-intent.example.test';
let send: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  fixture.legacy.mockReset().mockResolvedValue({ ok: true, status: 200, error: undefined, url: null });
  fixture.session.mockReset().mockResolvedValue(null);
  send = vi.fn<typeof fetch>(async () => Response.json({}));
  vi.stubGlobal('window', { location: { origin, assign: vi.fn() }, dispatchEvent: vi.fn() });
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
  it('keeps the existing credential call contract intact', async () => {
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
