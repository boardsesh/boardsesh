// @vitest-environment node
vi.mock('server-only', () => ({}));
import { describe, expect, it, vi, beforeEach, afterEach } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { encode } from 'next-auth/jwt';
import { GET } from '../route';
import {
  getAdmittedServerSession as getServerSession,
  getAdmittedRawServerToken,
} from '@/app/lib/auth/admitted-session.server';
import { CredentialAuthorityUnavailable } from '@/app/lib/auth/credential-admission.server';
import {
  issueNativeOAuthTransferToken,
  issueNativeOAuthAttempt,
  NATIVE_OAUTH_ATTEMPT_COOKIE,
} from '@/app/lib/auth/native-oauth-transfer';

// Mock dependencies before importing the route handler
vi.mock('@/app/lib/auth/admitted-session.server', () => ({
  getAdmittedServerSession: vi.fn(),
  getAdmittedRawServerToken: vi.fn(),
}));

vi.mock('@/app/lib/auth/auth-options', () => ({
  authOptions: {},
}));

vi.mock('@/app/lib/auth/native-oauth-transfer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/lib/auth/native-oauth-transfer')>()),
  issueNativeOAuthTransferToken: vi.fn(),
}));

const mockedGetRawToken = vi.mocked(getAdmittedRawServerToken);
const mockedGetServerSession = vi.mocked(getServerSession);
const mockedIssueToken = vi.mocked(issueNativeOAuthTransferToken);

const CALLBACK_SCHEME = 'com.boardsesh.app://auth/callback';

function createRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

/** Extract the deep link URL from the HTML body's JavaScript redirect. */
async function extractDeepLink(response: Response): Promise<string> {
  const html = await response.text();
  // Match the JSON.stringify'd URL in: window.location.href="..."
  const match = html.match(/window\.location\.href=(".*?")/);
  if (!match) throw new Error('No deep link found in response body');
  return JSON.parse(match[1]) as string;
}

describe('GET /api/auth/native/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXTAUTH_SECRET', 'native-attempt-test-secret');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('derives required proof from exact admitted raw claims ahead of displayed generation', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
    mockedGetServerSession.mockResolvedValue({
      user: { id: 'raw-source' },
      authSessionId: 'raw-source-login',
      authGeneration: 99,
      expires: '2026-10-11',
    });
    mockedIssueToken.mockReturnValue('raw-proof-transfer');
    const authenticatedAt = Math.floor(Date.now() / 1000) - 3600;
    mockedGetRawToken.mockResolvedValue(
      await encode({
        secret: 'native-attempt-test-secret',
        token: {
          sub: 'raw-source',
          authSessionId: 'raw-source-login',
          gen: 3,
          auth_time: authenticatedAt,
          link_guarded: true,
        },
      }),
    );
    const response = await GET(createRequest('/api/auth/native/callback'));
    expect(await extractDeepLink(response)).toContain('transferToken=');
    expect(mockedIssueToken).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 99,
        authSessionId: 'raw-source-login',
        credentialProof: {
          version: 1,
          userId: 'raw-source',
          authSessionId: 'raw-source-login',
          generation: 3,
          authenticatedAt: new Date(authenticatedAt * 1000).toISOString(),
          linkGuarded: true,
        },
      }),
    );
  });

  it('preserves signed no-SID ancestry when a renewed source has acquired a stable SID', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
    mockedGetServerSession.mockResolvedValue({
      user: { id: 'historical-source' },
      authSessionId: 'renewed-child',
      authGeneration: 99,
      expires: '2026-10-11',
    });
    mockedIssueToken.mockReturnValue('historical-transfer');
    mockedGetRawToken.mockResolvedValue(
      await encode({
        secret: 'native-attempt-test-secret',
        token: {
          sub: 'historical-source',
          authSessionId: 'renewed-child',
          gen: 0,
          legacy_no_sid: true,
        },
      }),
    );
    await GET(createRequest('/api/auth/native/callback'));
    expect(mockedIssueToken).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialProof: {
          version: 1,
          userId: 'historical-source',
          authSessionId: 'renewed-child',
          generation: 0,
          authenticatedAt: null,
          linkGuarded: false,
          requiresAccountCutoff: true,
        },
      }),
    );
  });

  it.each(['subject', 'sid'])('refuses raw source %s that differs from the admitted session', async (mismatch) => {
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
    mockedGetServerSession.mockResolvedValue({
      user: { id: 'raw-source' },
      authSessionId: 'raw-source-login',
      expires: '2026-10-11',
    });
    mockedGetRawToken.mockResolvedValue(
      await encode({
        secret: 'native-attempt-test-secret',
        token: {
          sub: mismatch === 'subject' ? 'different-source' : 'raw-source',
          authSessionId: mismatch === 'sid' ? 'different-login' : 'raw-source-login',
          gen: 3,
        },
      }),
    );
    const response = await GET(createRequest('/api/auth/native/callback'));
    expect(await extractDeepLink(response)).toContain('error=token_issue_failed');
    expect(mockedIssueToken).not.toHaveBeenCalled();
  });

  it('signs the exact receipt only for a matching fresh browser attempt and auth session', async () => {
    const userId = '602c83bf-e090-4c90-9f7e-08ca0b6b5dad';
    const attemptId = 'a'.repeat(32);
    const accountCreation = {
      userId,
      accountCreated: true,
      provider: 'apple' as const,
      createdAt: '2026-10-10T00:00:00.000Z',
    };
    const marker = issueNativeOAuthAttempt({ attemptId, provider: 'apple' });
    vi.advanceTimersByTime(1);
    mockedGetServerSession.mockResolvedValue({
      user: { id: userId },
      authSessionId: 'login-1',
      nativeOAuthCreationProof: {
        authSessionId: 'login-1',
        provider: 'apple',
        signedInAt: Date.now(),
        accountCreation,
      },
      expires: '2026-10-11',
    });
    mockedIssueToken.mockReturnValue('signed-transfer');
    const request = new NextRequest(
      `http://localhost:3000/api/auth/native/callback?provider=apple&attemptId=${attemptId}`,
      { headers: { Cookie: `${NATIVE_OAUTH_ATTEMPT_COOKIE}=${marker}` } },
    );
    const response = await GET(request);
    expect(mockedIssueToken).toHaveBeenCalledWith({
      generation: 0,
      userId,
      nextPath: '/',
      accountCreation,
      authSessionId: 'login-1',
      provider: 'apple',
      attemptId,
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it.each(['old-session', 'same-millisecond-session', 'wrong-provider', 'wrong-session', 'wrong-attempt'] as const)(
    'authenticates without signup proof for %s',
    async (mismatch) => {
      const userId = '602c83bf-e090-4c90-9f7e-08ca0b6b5dad';
      const attemptId = 'a'.repeat(32);
      const marker = issueNativeOAuthAttempt({ attemptId, provider: 'apple' });
      vi.advanceTimersByTime(1);
      mockedGetServerSession.mockResolvedValue({
        user: { id: userId },
        authSessionId: 'login-1',
        expires: '2026-10-11',
        nativeOAuthCreationProof: {
          authSessionId: mismatch === 'wrong-session' ? 'old-login' : 'login-1',
          provider: mismatch === 'wrong-provider' ? 'google' : 'apple',
          signedInAt: Date.now() - (mismatch === 'old-session' ? 2 : mismatch === 'same-millisecond-session' ? 1 : 0),
          accountCreation: { userId, accountCreated: true, provider: 'apple', createdAt: '2026-10-10T00:00:00.000Z' },
        },
      });
      mockedIssueToken.mockReturnValue('signed-transfer');
      const requestedAttempt = mismatch === 'wrong-attempt' ? 'b'.repeat(32) : attemptId;
      await GET(
        new NextRequest(`http://localhost:3000/api/auth/native/callback?provider=apple&attemptId=${requestedAttempt}`, {
          headers: { Cookie: `${NATIVE_OAUTH_ATTEMPT_COOKIE}=${marker}` },
        }),
      );
      expect(mockedIssueToken).toHaveBeenCalledWith({ generation: 0, userId, nextPath: '/', authSessionId: 'login-1' });
    },
  );

  it('forwards the admitted signed generation into the actual transfer producer', async () => {
    mockedGetServerSession.mockResolvedValue({
      user: { id: 'generation-callback-fixture' },
      authGeneration: 5,
      expires: '2099-01-01',
    });
    const actual = await vi.importActual<typeof import('@/app/lib/auth/native-oauth-transfer')>(
      '@/app/lib/auth/native-oauth-transfer',
    );
    mockedIssueToken.mockImplementationOnce(actual.issueNativeOAuthTransferToken);
    const response = await GET(createRequest('/api/auth/native/callback'));
    const deepLink = new URL(await extractDeepLink(response));
    const transfer = deepLink.searchParams.get('transferToken');
    expect(transfer).toBeTruthy();
    const claims = JSON.parse(Buffer.from(transfer!.split('.')[0], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(claims.gen).toBe(5);
    expect(claims).not.toHaveProperty('auth_time');
  });

  it('returns to the app with an error when the session cannot be verified', async () => {
    mockedGetServerSession.mockRejectedValue(new CredentialAuthorityUnavailable());

    const response = await GET(createRequest('http://localhost:3000/api/auth/native/callback?next=/'));

    expect(await extractDeepLink(response)).toContain('error=session_unavailable');
  });

  it('returns HTML redirect with error when session is missing', async () => {
    mockedGetServerSession.mockResolvedValue(null);

    const response = await GET(createRequest('/api/auth/native/callback?next=/'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await extractDeepLink(response)).toBe(`${CALLBACK_SCHEME}?error=session_missing`);
  });

  it('returns HTML redirect with error when session has no user id', async () => {
    mockedGetServerSession.mockResolvedValue({
      user: { id: '', email: 'test@test.com' },
      expires: '2099-01-01T00:00:00.000Z',
    });

    const response = await GET(createRequest('/api/auth/native/callback?next=/'));

    expect(response.status).toBe(200);
    expect(await extractDeepLink(response)).toBe(`${CALLBACK_SCHEME}?error=session_missing`);
  });

  it('returns HTML redirect with transfer token on success', async () => {
    mockedGetServerSession.mockResolvedValue({
      user: { id: 'user_123', email: 'test@test.com' },
      expires: '2099-01-01T00:00:00.000Z',
    });
    mockedIssueToken.mockReturnValue('test-transfer-token');

    const response = await GET(createRequest('/api/auth/native/callback?next=/settings'));

    expect(response.status).toBe(200);
    const deepLink = await extractDeepLink(response);
    expect(deepLink).toContain(`${CALLBACK_SCHEME}?transferToken=`);
    expect(deepLink).toContain('test-transfer-token');
    expect(deepLink).toContain('next=%2Fsettings');

    expect(mockedIssueToken).toHaveBeenCalledWith({ generation: 0, userId: 'user_123', nextPath: '/settings' });
  });

  it('sanitizes non-relative next path to root', async () => {
    mockedGetServerSession.mockResolvedValue({
      user: { id: 'user_123', email: 'test@test.com' },
      expires: '2099-01-01T00:00:00.000Z',
    });
    mockedIssueToken.mockReturnValue('token');

    const response = await GET(createRequest('/api/auth/native/callback?next=https://evil.com'));

    expect(response.status).toBe(200);
    expect(mockedIssueToken).toHaveBeenCalledWith({ generation: 0, userId: 'user_123', nextPath: '/' });
  });

  it('defaults next path to root when missing', async () => {
    mockedGetServerSession.mockResolvedValue({
      user: { id: 'user_123', email: 'test@test.com' },
      expires: '2099-01-01T00:00:00.000Z',
    });
    mockedIssueToken.mockReturnValue('token');

    await GET(createRequest('/api/auth/native/callback'));

    expect(mockedIssueToken).toHaveBeenCalledWith({ generation: 0, userId: 'user_123', nextPath: '/' });
  });

  it('returns HTML redirect with error when token issuance throws', async () => {
    mockedGetServerSession.mockResolvedValue({
      user: { id: 'user_123', email: 'test@test.com' },
      expires: '2099-01-01T00:00:00.000Z',
    });
    mockedIssueToken.mockImplementation(() => {
      throw new Error('NEXTAUTH_SECRET not set');
    });

    const response = await GET(createRequest('/api/auth/native/callback?next=/'));

    expect(response.status).toBe(200);
    expect(await extractDeepLink(response)).toBe(`${CALLBACK_SCHEME}?error=token_issue_failed`);
  });

  it('includes HTML-escaped URL in meta refresh attribute', async () => {
    mockedGetServerSession.mockResolvedValue(null);

    const response = await GET(createRequest('/api/auth/native/callback?next=/'));
    const html = await response.text();

    // meta refresh should contain HTML-escaped URL
    expect(html).toContain('<meta http-equiv="refresh"');
    // The scheme contains no characters that need escaping, but verify
    // the meta tag is present and well-formed
    expect(html).toContain('content="0;url=');
  });
});
