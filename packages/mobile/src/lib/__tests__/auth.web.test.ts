import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureAuthCredentialGeneration, clearTokens, getAuthToken, synchronizeWebSession } from '../auth-store.web';
import {
  buildWebOAuthStartUrl,
  registerWithCredentials,
  requestPasswordReset,
  resetPassword,
  signInWithCredentials,
  signInWithGoogle,
  signOut,
  signOutForGeneration,
} from '../auth.web';

// The Expo-web app calls www's auth endpoints cross-origin (app.boardsesh.com →
// www.boardsesh.com), so the auth fetches target the absolute web origin
// (WEB_BASE_URL default) with credentials: 'include'. In this node test there is
// no same-origin window, so `webApiUrl` always resolves to the absolute form.
const WEB = 'https://www.boardsesh.com';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authenticatedBridgeResponse(token: string, userId = 'user-1', authSessionId = 'login-1'): Response {
  return jsonResponse({ authenticated: true, token, userId, authSessionId });
}

function requestBody(callIndex: number): string {
  const options = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  if (typeof options?.body !== 'string') throw new Error(`No string request body at call ${callIndex}`);
  return options.body;
}

beforeEach(async () => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  // Simulate the www-mounted export (experiments.baseUrl '/app'): Expo CLI
  // inlines this into the bundle as EXPO_BASE_URL, and appCallbackUrl derives
  // the NextAuth callback from it. The standalone subdomain export case
  // (no base path → '/') has its own test below.
  vi.stubEnv('EXPO_BASE_URL', '/app');
  await clearTokens();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Expo web OAuth', () => {
  it('starts Google on www and returns to the same-origin /app export', () => {
    const url = new URL(buildWebOAuthStartUrl('google', 'https://www.boardsesh.com'));

    expect(url.origin).toBe(WEB);
    expect(url.pathname).toBe('/auth/native-start');
    expect(url.searchParams.get('provider')).toBe('google');
    expect(url.searchParams.get('callbackUrl')).toBe('https://www.boardsesh.com/app');
  });

  it('starts Apple on www and returns to the standalone app root', () => {
    const url = new URL(buildWebOAuthStartUrl('apple', 'https://app.boardsesh.com', ''));

    expect(url.origin).toBe(WEB);
    expect(url.pathname).toBe('/auth/native-start');
    expect(url.searchParams.get('provider')).toBe('apple');
    expect(url.searchParams.get('callbackUrl')).toBe('https://app.boardsesh.com/');
  });

  it('reports browser navigation failures without throwing', async () => {
    vi.stubGlobal('window', {
      location: {
        origin: 'https://app.boardsesh.com',
        assign: vi.fn(() => {
          throw new Error('navigation blocked');
        }),
      },
    });

    await expect(signInWithGoogle()).resolves.toEqual({
      success: false,
      status: null,
      error: 'browser_unavailable',
    });
  });
});

describe('Expo web credentials auth', () => {
  it('uses the NextAuth CSRF callback and resolves the resulting cookie session', async () => {
    const generationBeforeLogin = captureAuthCredentialGeneration();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/app' }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('backend-jwe'));

    await expect(signInWithCredentials('climber@example.com', 'password')).resolves.toEqual({ success: true });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${WEB}/api/auth/csrf`,
      `${WEB}/api/auth/callback/credentials`,
      `${WEB}/api/auth/session`,
      `${WEB}/api/internal/ws-auth`,
    ]);
    const callbackOptions = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const callbackBody = new URLSearchParams(requestBody(1));
    expect(callbackBody.get('csrfToken')).toBe('csrf-token');
    expect(callbackBody.get('email')).toBe('climber@example.com');
    expect(callbackBody.get('password')).toBe('password');
    expect(callbackBody.get('callbackUrl')).toBe('/app');
    expect(callbackOptions.credentials).toBe('include');
    expect(new Headers(callbackOptions.headers).get('X-Auth-Return-Redirect')).toBe('1');
    expect(captureAuthCredentialGeneration()).toBe(generationBeforeLogin + 1);
    await expect(getAuthToken()).resolves.toBe('backend-jwe');
  });

  it('derives the callback from the export base — root on the standalone subdomain export', async () => {
    // On app.boardsesh.com the app is rooted at '/', and '/app' does not exist:
    // the stored NextAuth callback must point at the export's real base path.
    vi.stubEnv('EXPO_BASE_URL', '');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/' }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('backend-jwe'));

    await expect(signInWithCredentials('climber@example.com', 'password')).resolves.toEqual({ success: true });

    const callbackBody = new URLSearchParams(requestBody(1));
    expect(callbackBody.get('callbackUrl')).toBe('/');
  });

  it('maps a NextAuth credentials error after reconciling the unchanged cookie', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/api/auth/error?error=CredentialsSignin' }))
      .mockResolvedValueOnce(jsonResponse({}));

    await expect(signInWithCredentials('climber@example.com', 'wrong')).resolves.toEqual({
      success: false,
      status: 401,
      error: 'invalid_credentials',
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${WEB}/api/auth/csrf`,
      `${WEB}/api/auth/callback/credentials`,
      `${WEB}/api/auth/session`,
    ]);
  });

  it('adopts a new cookie even when the credentials callback body is truncated', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('old-user-jwe'));
    await synchronizeWebSession();

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }))
      .mockResolvedValueOnce(
        new Response('{', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-2' }, authSessionId: 'login-2' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('new-user-jwe', 'user-2', 'login-2'));

    await expect(signInWithCredentials('new-climber@example.com', 'password')).resolves.toEqual({ success: true });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${WEB}/api/auth/csrf`,
      `${WEB}/api/auth/callback/credentials`,
      `${WEB}/api/auth/session`,
      `${WEB}/api/internal/ws-auth`,
    ]);
    await expect(getAuthToken()).resolves.toBe('new-user-jwe');
  });

  it('restores the prior login when a failed credentials callback leaves its cookie unchanged', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('old-user-jwe'));
    await synchronizeWebSession();

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/api/auth/error?error=CredentialsSignin' }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('restored-user-jwe'));

    await expect(signInWithCredentials('other@example.com', 'wrong')).resolves.toEqual({
      success: false,
      status: 401,
      error: 'invalid_credentials',
    });
    await expect(getAuthToken()).resolves.toBe('restored-user-jwe');
  });

  it('keeps verification-required registration distinct from an authenticated result', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ requiresVerification: true, emailSent: true }));

    await expect(registerWithCredentials('climber@example.com', 'password', 'Climber')).resolves.toEqual({
      success: true,
      authenticated: false,
      requiresVerification: true,
      emailSent: true,
    });
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('preserves a failed verification-email delivery on a successful registration', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ requiresVerification: true, emailSent: false }));

    await expect(registerWithCredentials('climber@example.com', 'password', 'Climber')).resolves.toEqual({
      success: true,
      authenticated: false,
      requiresVerification: true,
      emailSent: false,
    });
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('reports account creation as successful when automatic login is unavailable', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ requiresVerification: false }))
      .mockRejectedValueOnce(new Error('offline'));

    await expect(registerWithCredentials('climber@example.com', 'password', 'Climber')).resolves.toEqual({
      success: true,
      authenticated: false,
      requiresVerification: false,
      autoLoginUnavailable: true,
    });
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('signs out through NextAuth and clears only the in-memory bridge token', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('backend-jwe'));
    await synchronizeWebSession();

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/app' }));

    await signOut();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${WEB}/api/auth/session`,
      `${WEB}/api/auth/csrf`,
      `${WEB}/api/auth/signout`,
    ]);
    const signOutOptions = fetchMock.mock.calls[2]?.[1] as RequestInit;
    const signOutBody = new URLSearchParams(requestBody(2));
    expect(signOutBody.get('csrfToken')).toBe('csrf-token');
    expect(signOutBody.get('callbackUrl')).toBe('/app');
    expect(signOutBody.get('expectedUserId')).toBe('user-1');
    expect(signOutBody.get('expectedAuthSessionId')).toBe('login-1');
    expect(new Headers(signOutOptions.headers).get('X-Auth-Return-Redirect')).toBe('1');
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('clears the exposed memory credential when durable sign-out fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('backend-jwe'));
    await synchronizeWebSession();

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503));

    await expect(signOut()).rejects.toThrow('Could not sign out: HTTP 503');
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('clears the exposed memory credential before a slow durable sign-out finishes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('backend-jwe'));
    await synchronizeWebSession();

    let resolveCsrf!: (response: Response) => void;
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveCsrf = resolve;
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ url: '/app' }));

    const pendingSignOut = signOut();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await expect(getAuthToken()).resolves.toBeNull();

    resolveCsrf(jsonResponse({ csrfToken: 'csrf-token' }));
    await expect(pendingSignOut).resolves.toBeUndefined();
  });

  it('clears the memory credential when NextAuth rejects the sign-out callback', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('backend-jwe'));
    await synchronizeWebSession();

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/api/auth/signout?csrf=true' }));

    await expect(signOut()).rejects.toThrow('Could not confirm sign-out');
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('clears the memory credential when the CSRF endpoint is unreachable', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('backend-jwe'));
    await synchronizeWebSession();

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockRejectedValueOnce(new Error('offline'));

    await expect(signOut()).rejects.toThrow('Could not start sign-out: network');
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('does not let an old sign-out clear a newer browser credential owner', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('old-user-jwe'));
    await synchronizeWebSession();

    fetchMock.mockReset();
    const oldGeneration = captureAuthCredentialGeneration();
    let resolveOldCsrf!: (response: Response) => void;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveOldCsrf = resolve;
        }),
      );

    const oldSignOut = signOutForGeneration(oldGeneration);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await clearTokens();
    resolveOldCsrf(jsonResponse({ csrfToken: 'old-csrf' }));
    await expect(oldSignOut).resolves.toBe(false);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-2' }, authSessionId: 'login-2' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('new-user-jwe', 'user-2', 'login-2'));
    await expect(synchronizeWebSession()).resolves.toEqual({
      status: 'authenticated',
      token: 'new-user-jwe',
      userId: 'user-2',
      authSessionId: 'login-2',
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${WEB}/api/auth/session`,
      `${WEB}/api/auth/csrf`,
      `${WEB}/api/auth/session`,
      `${WEB}/api/internal/ws-auth`,
    ]);
    await expect(getAuthToken()).resolves.toBe('new-user-jwe');
  });

  it('does not post sign-out when the shared cookie already belongs to a newer login', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('old-user-jwe'));
    await synchronizeWebSession();
    const oldGeneration = captureAuthCredentialGeneration();

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-2' }, authSessionId: 'login-2' }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-2' }, authSessionId: 'login-2' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('new-user-jwe', 'user-2', 'login-2'));

    await expect(signOutForGeneration(oldGeneration)).resolves.toBe(false);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${WEB}/api/auth/session`,
      `${WEB}/api/auth/session`,
      `${WEB}/api/internal/ws-auth`,
    ]);
    await expect(getAuthToken()).resolves.toBe('new-user-jwe');
  });

  it('adopts a newer login when the server identity guard rejects the sign-out POST', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('old-user-jwe'));
    await synchronizeWebSession();
    const oldGeneration = captureAuthCredentialGeneration();

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'signout_identity_changed' }, 409))
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-2' }, authSessionId: 'login-2' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('new-user-jwe', 'user-2', 'login-2'));

    await expect(signOutForGeneration(oldGeneration)).resolves.toBe(false);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${WEB}/api/auth/session`,
      `${WEB}/api/auth/csrf`,
      `${WEB}/api/auth/signout`,
      `${WEB}/api/auth/session`,
      `${WEB}/api/internal/ws-auth`,
    ]);
    await expect(getAuthToken()).resolves.toBe('new-user-jwe');
  });

  it('does not post sign-out when another tab already removed the shared cookie', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('old-user-jwe'));
    await synchronizeWebSession();
    const oldGeneration = captureAuthCredentialGeneration();

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await expect(signOutForGeneration(oldGeneration)).resolves.toBe(true);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${WEB}/api/auth/session`]);
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('does not adopt a newer generation while its local clear yields', async () => {
    const oldGeneration = captureAuthCredentialGeneration();

    const oldSignOut = signOutForGeneration(oldGeneration);
    await clearTokens();

    await expect(oldSignOut).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Expo web register + password-reset endpoints', () => {
  function credentials(callIndex: number): RequestCredentials | undefined {
    return (fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined)?.credentials;
  }

  it('registers cross-origin with credentials so the shared cookie is set', async () => {
    // requiresVerification keeps this to the single register POST (no auto-login).
    fetchMock.mockResolvedValueOnce(jsonResponse({ requiresVerification: true, emailSent: true }));

    await registerWithCredentials('climber@example.com', 'password', 'Climber');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${WEB}/api/auth/register`);
    expect(credentials(0)).toBe('include');
  });

  it('requests a password reset cross-origin with credentials', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await expect(requestPasswordReset('climber@example.com')).resolves.toEqual({ success: true });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${WEB}/api/auth/forgot-password`);
    expect(credentials(0)).toBe('include');
  });

  it('resets the password cross-origin with credentials', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await expect(resetPassword('climber@example.com', 'reset-token', 'newpass', 'newpass')).resolves.toEqual({
      success: true,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${WEB}/api/auth/reset-password`);
    expect(credentials(0)).toBe('include');
  });
});
