// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
const control = vi.hoisted(() => ({ getToken: vi.fn(), decode: vi.fn(), legacyAdmission: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next-auth/jwt', () => ({ getToken: control.getToken, decode: control.decode }));
vi.mock('@/app/lib/auth/credential-admission.server', () => ({
  admitPresentedWebCredential: control.legacyAdmission,
  CredentialAuthorityUnavailable: class extends Error {},
}));
import { GET } from '../route';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe('actual ws-auth route public readiness fence', () => {
  it.each([
    ['legacy', '__Host-boardsesh.browser-binding=' + 'A'.repeat(43)],
    ['legacy', '__Host-boardsesh.browser-binding.malformed=held-pointer'],
    ['backend-staging', ''],
  ])('never reads a legacy B cookie for %s with correlation %s', async (mode, correlation) => {
    vi.stubEnv('CURRENT_STORE_BROWSER_BINDING_MODE', mode);
    vi.stubEnv('BROWSER_PUBLIC_READERS_READY', 'true');
    const response = await GET(
      new NextRequest('https://www.boardsesh.test/api/internal/ws-auth', {
        headers: {
          Cookie: [correlation, '__Secure-next-auth.session-token=foreign-older-login'].filter(Boolean).join('; '),
          'x-browser-consumers-ready': 'true',
        },
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unavailable' });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(control.getToken).not.toHaveBeenCalled();
    expect(control.decode).not.toHaveBeenCalled();
    expect(control.legacyAdmission).not.toHaveBeenCalled();
  });
});
