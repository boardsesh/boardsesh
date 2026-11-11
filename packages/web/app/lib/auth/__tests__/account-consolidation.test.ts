// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encode, decode, getToken } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
vi.mock('server-only', () => ({}));
const post = vi.hoisted(() => vi.fn());
vi.mock('../auth-command-transport.server', () => ({ createAuthCommandTransport: () => ({ post }) }));
import {
  consolidationSessionRequest,
  matchesConsolidatedSignOut,
  enrollConsolidationSignIn,
  revokeConsolidationCookie,
} from '../account-consolidation.server';
const secret = 'synthetic-account-consolidation-web-secret';
beforeEach(() => {
  vi.stubEnv('NEXTAUTH_SECRET', secret);
  vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.com');
  vi.stubEnv('ACCOUNT_CONSOLIDATION_BRIDGE_MODE', 'enabled');
  post.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
async function sourceRequest() {
  const credential = await encode({
    secret,
    maxAge: 1000000000,
    token: {
      sub: 'source',
      gen: 2,
      authSessionId: 'old-sid',
      auth_time: 100,
      profileDisplayName: 'Source',
      profileClaimsRefreshedAt: 50,
    },
  });
  return new NextRequest('https://www.boardsesh.com/api/auth/session', {
    headers: {
      cookie: `__Secure-next-auth.session-token=${credential}; other=retained`,
    },
  });
}
describe('writable consolidation session request', () => {
  it('carries canonical credentials to the cookie-writing NextAuth handler with original auth age', async () => {
    post.mockResolvedValue({
      status: 200,
      body: {
        outcome: 'transferred',
        sub: 'target',
        generation: 7,
        expiresAt: 2000000000,
        issuedAt: 100,
        sessionId: 'mapped-sid',
        receipt: { mergeId: 'merge', fromUserId: 'source', toUserId: 'target' },
      },
    });
    const request = await consolidationSessionRequest(await sourceRequest());
    const raw = await getToken({ req: request, secret, cookieName: '__Secure-next-auth.session-token', raw: true });
    const payload = await decode({ token: raw!, secret });
    expect(payload).toMatchObject({
      sub: 'target',
      id: 'target',
      gen: 7,
      authSessionId: 'mapped-sid',
      auth_time: 100,
      iat: 100,
      exp: 2000000000,
    });
    expect(payload?.profileDisplayName).toBeUndefined();
    expect(request.cookies.get('other')?.value).toBe('retained');
  });
  it('leaves unknown historical lineage to normal signin', async () => {
    post.mockResolvedValue({ status: 401, body: { outcome: 'ineligible' } });
    const request = await sourceRequest();
    expect(await consolidationSessionRequest(request)).toBe(request);
  });
  it('rejects a response whose receipt retargets another account', async () => {
    post.mockResolvedValue({
      status: 200,
      body: {
        outcome: 'transferred',
        sub: 'target',
        generation: 7,
        expiresAt: 2000000000,
        issuedAt: 100,
        sessionId: 'mapped-sid',
        receipt: { mergeId: 'merge', fromUserId: 'other', toUserId: 'target' },
      },
    });
    await expect(consolidationSessionRequest(await sourceRequest())).rejects.toThrow('temporarily unavailable');
  });
  it('permits a stale source tab to end only its own exact transferred lineage', () => {
    const token = {
      sub: 'target',
      authSessionId: 'mapped-sid',
      accountConsolidationFromSessionId: 'source-sid',
      accountConsolidation: { mergeId: 'merge', fromUserId: 'source', toUserId: 'target' },
    };
    expect(matchesConsolidatedSignOut(token, { userId: 'source', authSessionId: 'source-sid' })).toBe(true);
    expect(matchesConsolidatedSignOut(token, { userId: 'source', authSessionId: 'wrong-sid' })).toBe(false);
    expect(
      matchesConsolidatedSignOut(
        { sub: 'target', authSessionId: 'independent-new-login' },
        { userId: 'source', authSessionId: 'source-sid' },
      ),
    ).toBe(false);
    expect(matchesConsolidatedSignOut(token, { userId: 'unrelated', authSessionId: 'source-sid' })).toBe(false);
  });

  it('uses distinct enrollment and revocation commands and stays inert when disabled', async () => {
    post.mockResolvedValue({ status: 200, body: { outcome: 'recorded' } });
    await enrollConsolidationSignIn('cookie');
    await revokeConsolidationCookie('cookie');
    expect(post.mock.calls.map((entry) => entry[1].operation)).toEqual(['enroll', 'revoke']);
    vi.stubEnv('ACCOUNT_CONSOLIDATION_BRIDGE_MODE', 'off');
    await enrollConsolidationSignIn('other');
    expect(post).toHaveBeenCalledTimes(2);
  });
});
