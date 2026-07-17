import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureAuthCredentialGeneration, clearTokens, getAuthToken, synchronizeWebSession } from '../auth-store.web';
import { registerWithCredentials, signInWithCredentials, signOut, signOutForGeneration } from '../auth.web';

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
  fetchMock.mockReset();
  await clearTokens();
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
      '/api/auth/csrf',
      '/api/auth/callback/credentials',
      '/api/auth/session',
      '/api/internal/ws-auth',
    ]);
    const callbackOptions = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const callbackBody = new URLSearchParams(requestBody(1));
    expect(callbackBody.get('csrfToken')).toBe('csrf-token');
    expect(callbackBody.get('email')).toBe('climber@example.com');
    expect(callbackBody.get('password')).toBe('password');
    expect(callbackBody.get('callbackUrl')).toBe('/app');
    expect(callbackOptions.credentials).toBe('same-origin');
    expect(new Headers(callbackOptions.headers).get('X-Auth-Return-Redirect')).toBe('1');
    expect(captureAuthCredentialGeneration()).toBe(generationBeforeLogin + 1);
    await expect(getAuthToken()).resolves.toBe('backend-jwe');
  });

  it('maps a NextAuth credentials error without calling the token bridge', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/api/auth/error?error=CredentialsSignin' }));

    await expect(signInWithCredentials('climber@example.com', 'wrong')).resolves.toEqual({
      success: false,
      status: 401,
      error: 'invalid_credentials',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ url: '/app' }));

    await signOut();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/auth/csrf', '/api/auth/signout']);
    const signOutOptions = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const signOutBody = new URLSearchParams(requestBody(1));
    expect(signOutBody.get('csrfToken')).toBe('csrf-token');
    expect(signOutBody.get('callbackUrl')).toBe('/app');
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
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-token' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503));

    await expect(signOut()).rejects.toThrow('Could not sign out: HTTP 503');
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('clears the memory credential when NextAuth rejects the sign-out callback', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-1' }, authSessionId: 'login-1' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('backend-jwe'));
    await synchronizeWebSession();

    fetchMock.mockReset();
    fetchMock
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
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    await expect(signOut()).rejects.toThrow('Could not start sign-out: network');
    await expect(getAuthToken()).resolves.toBeNull();
  });

  it('does not let an old sign-out clear a newer browser credential owner', async () => {
    const oldGeneration = captureAuthCredentialGeneration();
    let resolveOldCsrf!: (response: Response) => void;
    fetchMock
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveOldCsrf = resolve;
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ user: { id: 'user-2' }, authSessionId: 'login-2' }))
      .mockResolvedValueOnce(authenticatedBridgeResponse('new-user-jwe', 'user-2', 'login-2'));

    const oldSignOut = signOutForGeneration(oldGeneration);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await clearTokens();
    await expect(synchronizeWebSession()).resolves.toEqual({
      status: 'authenticated',
      token: 'new-user-jwe',
      userId: 'user-2',
      authSessionId: 'login-2',
    });
    resolveOldCsrf(jsonResponse({ csrfToken: 'old-csrf' }));

    await expect(oldSignOut).resolves.toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/auth/csrf',
      '/api/auth/session',
      '/api/internal/ws-auth',
    ]);
    await expect(getAuthToken()).resolves.toBe('new-user-jwe');
  });
});
