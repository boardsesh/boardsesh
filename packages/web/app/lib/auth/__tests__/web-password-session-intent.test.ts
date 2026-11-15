// @vitest-environment node
import { beforeEach, afterEach, describe, it, expect, vi } from 'vite-plus/test';
const state = vi.hoisted(() => ({
  coordinator: false,
  password: false,
  legacy: vi.fn(),
  session: vi.fn(),
  canonical: vi.fn(),
  preflight: vi.fn(),
}));
vi.mock('next-auth/react', () => ({ signIn: state.legacy, getSession: state.session }));
vi.mock('../browser-coordinator-readiness', () => ({ publicBrowserCoordinatorReady: () => state.coordinator }));
vi.mock('../provider-security-readiness', () => ({ publicProviderSecurityReady: () => false }));
vi.mock('../browser-password-readiness', () => ({ publicBrowserPasswordReady: () => state.password }));
vi.mock('../canonical-password-signin', async (original) => ({
  ...(await original<typeof import('../canonical-password-signin')>()),
  signInCanonicalPassword: state.canonical,
}));
vi.mock('../browser-coordinator-client', () => ({
  signInCanonicalBrowserCoordinator: state.preflight,
  readCanonicalBrowserCoordinator: vi.fn(),
}));
import { signInWithSessionIntent } from '../web-session-events';
import { registerCanonicalBrowserOrigin } from '../canonical-browser-origin';
const origin = 'https://www.password-intent.test';
let cleanup: (() => void) | undefined;
beforeEach(() => {
  state.coordinator = false;
  state.password = false;
  state.legacy.mockReset().mockResolvedValue({ ok: true, status: 200 });
  state.session.mockReset().mockResolvedValue(null);
  state.canonical.mockReset().mockResolvedValue({ ok: true, status: 200, url: origin + '/settings' });
  vi.stubGlobal('window', { location: { origin, assign: vi.fn() }, dispatchEvent: vi.fn() });
  vi.stubGlobal('navigator', { locks: { request: vi.fn() } });
  cleanup = registerCanonicalBrowserOrigin(origin);
});
afterEach(() => {
  cleanup?.();
  vi.unstubAllGlobals();
});
describe('selected password session-intent entry', () => {
  it('preserves legacy password call bytes when all public gates are false', async () => {
    const options = { email: ' exact@example.test ', password: ' NUL\0ß ', redirect: false };
    await signInWithSessionIntent('credentials', options);
    expect(state.legacy).toHaveBeenCalledExactlyOnceWith('credentials', options);
    expect(state.canonical).not.toHaveBeenCalled();
    expect(state.session).toHaveBeenCalledOnce();
  });
  it('dispatches ready selected credentials into the complete canonical flow', async () => {
    state.coordinator = true;
    state.password = true;
    expect(
      await signInWithSessionIntent('credentials', {
        email: 'exact@example.test',
        password: 'exact password',
        redirect: false,
      }),
    ).toMatchObject({ ok: true });
    expect(state.canonical).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'exact@example.test',
        password: 'exact password',
        canonicalOrigin: origin,
        redirect: false,
      }),
      expect.objectContaining({ preflight: state.preflight }),
    );
    expect(state.legacy).not.toHaveBeenCalled();
    expect(state.session).not.toHaveBeenCalled();
  });
  it.each([
    [true, false],
    [false, true],
  ])('refuses partial gates (%s/%s) without fallback', async (coordinator, password) => {
    state.coordinator = coordinator;
    state.password = password;
    expect(await signInWithSessionIntent('credentials', { email: 'a', password: 'b' })).toMatchObject({
      ok: false,
      status: 503,
    });
    expect(state.canonical).not.toHaveBeenCalled();
    expect(state.legacy).not.toHaveBeenCalled();
  });
  it('rejects a public credential-kind claim before canonical transport', async () => {
    state.coordinator = true;
    state.password = true;
    expect(
      await signInWithSessionIntent('credentials', { email: 'a', password: 'b', credentialKind: 'canonical-token' }),
    ).toMatchObject({ ok: false, status: 503 });
    expect(state.canonical).not.toHaveBeenCalled();
    expect(state.legacy).not.toHaveBeenCalled();
  });
});
