import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState = { generation: 1, current: true };
const getAuthTokenMock = vi.fn();
const isTokenExpiringSoonMock = vi.fn();
const deduplicatedRefreshMock = vi.fn();
const reportHandledErrorMock = vi.hoisted(() => vi.fn());

type RefreshResult =
  | { status: 'refreshed'; generation: number }
  | { status: 'rejected'; generation: number }
  | { status: 'unavailable'; generation: number; error: unknown }
  | { status: 'superseded' };

vi.mock('../auth-store', () => ({
  captureAuthCredentialGeneration: () => authState.generation,
  getAuthToken: () => getAuthTokenMock(),
  isAuthCredentialGenerationCurrent: () => authState.current,
  isTokenExpiringSoon: () => isTokenExpiringSoonMock(),
}));

vi.mock('../auth-interceptor', () => ({ deduplicatedRefresh: () => deduplicatedRefreshMock() }));
vi.mock('../error-reporting', () => ({
  reportHandledError: (...args: unknown[]) => reportHandledErrorMock(...args),
}));

// The resolver asks the connectivity store before spending a refresh round trip
// on a backend it already knows is unreachable (issue #4862).
const connectivity = vi.hoisted(() => ({ snapshot: { effectiveOffline: false, reason: null as string | null } }));
vi.mock('../connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => connectivity.snapshot,
}));

import { resolveAuthSession } from '../auth-session';
import { BackendUnavailableError } from '../connectivity/backend-unavailable-error';

beforeEach(() => {
  authState.generation = 1;
  authState.current = true;
  getAuthTokenMock.mockReset();
  getAuthTokenMock.mockResolvedValue('old-jwt');
  isTokenExpiringSoonMock.mockReset();
  isTokenExpiringSoonMock.mockResolvedValue(true);
  deduplicatedRefreshMock.mockReset();
  deduplicatedRefreshMock.mockResolvedValue({ status: 'refreshed', generation: 1 } satisfies RefreshResult);
  reportHandledErrorMock.mockReset();
  connectivity.snapshot = { effectiveOffline: false, reason: null };
});

describe('resolveAuthSession while the backend is unreachable (#4862)', () => {
  // Refreshing would hang or fail, and `unavailable` is exactly what that
  // failure resolves to — so take the same outcome without the round trip and
  // keep the already-established local session. The climber stays signed in
  // through the outage.
  it('degrades an expiring token instead of refreshing, and never calls the interceptor', async () => {
    connectivity.snapshot = { effectiveOffline: true, reason: 'backend_unreachable' };

    const session = await resolveAuthSession();

    expect(deduplicatedRefreshMock).not.toHaveBeenCalled();
    expect(session).toMatchObject({ status: 'authenticated', token: 'old-jwt', generation: 1 });
    const degraded = (session as { degraded?: { stage: string; error: unknown } }).degraded;
    expect(degraded?.stage).toBe('refresh-unavailable');
    expect(degraded?.error).toBeInstanceOf(BackendUnavailableError);
    expect((degraded?.error as BackendUnavailableError).reason).toBe('backend_unreachable');
  });

  it('carries the offline-mode reason through so the UI can say why', async () => {
    connectivity.snapshot = { effectiveOffline: true, reason: 'offline_mode' };

    const session = await resolveAuthSession();

    const degraded = (session as { degraded?: { error: unknown } }).degraded;
    expect((degraded?.error as BackendUnavailableError).reason).toBe('offline_mode');
  });

  // A token that is NOT expiring never reaches the connectivity check, so an
  // outage must not change the ordinary signed-in answer.
  it('leaves a healthy token completely untouched', async () => {
    connectivity.snapshot = { effectiveOffline: true, reason: 'backend_unreachable' };
    isTokenExpiringSoonMock.mockResolvedValue(false);

    await expect(resolveAuthSession()).resolves.toEqual({
      status: 'authenticated',
      token: 'old-jwt',
      generation: 1,
    });
  });

  it('refreshes as usual once connectivity is fine', async () => {
    getAuthTokenMock.mockResolvedValueOnce('old-jwt').mockResolvedValueOnce('new-jwt');

    await expect(resolveAuthSession()).resolves.toEqual({
      status: 'authenticated',
      token: 'new-jwt',
      generation: 1,
    });
    expect(deduplicatedRefreshMock).toHaveBeenCalledTimes(1);
  });
});

describe('resolveAuthSession local credential provenance', () => {
  it('returns anonymous only when the initial token read confirms there is no JWT', async () => {
    getAuthTokenMock.mockResolvedValue(null);

    await expect(resolveAuthSession()).resolves.toEqual({ status: 'anonymous', generation: 1 });
    expect(isTokenExpiringSoonMock).not.toHaveBeenCalled();
    expect(deduplicatedRefreshMock).not.toHaveBeenCalled();
  });

  it('keeps an initial token-read failure unavailable instead of inventing an authenticated session', async () => {
    const keychainError = new Error('keychain locked');
    getAuthTokenMock.mockRejectedValue(keychainError);

    await expect(resolveAuthSession()).resolves.toEqual({
      status: 'unavailable',
      stage: 'token-read',
      error: keychainError,
      generation: 1,
    });
  });

  it('returns a clean authenticated session when the stored JWT is not expiring', async () => {
    isTokenExpiringSoonMock.mockResolvedValue(false);

    await expect(resolveAuthSession()).resolves.toEqual({
      status: 'authenticated',
      token: 'old-jwt',
      generation: 1,
    });
    expect(deduplicatedRefreshMock).not.toHaveBeenCalled();
  });

  it('preserves the established session when the expiry metadata read fails', async () => {
    const expiryReadError = new Error('expiry key unavailable');
    isTokenExpiringSoonMock.mockRejectedValue(expiryReadError);

    await expect(resolveAuthSession()).resolves.toEqual({
      status: 'authenticated',
      token: 'old-jwt',
      generation: 1,
      degraded: { stage: 'expiry-read', error: expiryReadError },
    });
  });
});

describe('resolveAuthSession refresh status mapping', () => {
  it('still attempts refresh when expiry metadata says the token is expiring or has no stored expiry', async () => {
    isTokenExpiringSoonMock.mockResolvedValue(true);
    getAuthTokenMock.mockResolvedValueOnce('old-jwt').mockResolvedValueOnce('fresh-jwt');

    await expect(resolveAuthSession()).resolves.toEqual({
      status: 'authenticated',
      token: 'fresh-jwt',
      generation: 1,
    });
    expect(deduplicatedRefreshMock).toHaveBeenCalledOnce();
  });

  it('maps an explicitly rejected refresh to anonymous', async () => {
    deduplicatedRefreshMock.mockResolvedValue({ status: 'rejected', generation: 1 } satisfies RefreshResult);

    await expect(resolveAuthSession()).resolves.toEqual({ status: 'anonymous', generation: 1 });
  });

  it('keeps the original JWT authenticated when refresh is unavailable', async () => {
    const networkError = new Error('Network request failed');
    deduplicatedRefreshMock.mockResolvedValue({
      status: 'unavailable',
      generation: 1,
      error: networkError,
    } satisfies RefreshResult);

    await expect(resolveAuthSession()).resolves.toEqual({
      status: 'authenticated',
      token: 'old-jwt',
      generation: 1,
      degraded: { stage: 'refresh-unavailable', error: networkError },
    });
    expect(getAuthTokenMock).toHaveBeenCalledOnce();
    expect(reportHandledErrorMock).not.toHaveBeenCalled();
  });

  it('defensively preserves and reports the original cause when the refresh promise rejects', async () => {
    const refreshError = new Error('refresh implementation rejected');
    deduplicatedRefreshMock.mockRejectedValue(refreshError);

    await expect(resolveAuthSession()).resolves.toEqual({
      status: 'authenticated',
      token: 'old-jwt',
      generation: 1,
      degraded: { stage: 'refresh-unavailable', error: refreshError },
    });
    expect(reportHandledErrorMock).toHaveBeenCalledWith(refreshError, {
      tags: { source: 'auth-session', auth_stage: 'refresh-unavailable' },
    });
  });

  it('returns the refreshed token when refresh succeeds', async () => {
    getAuthTokenMock.mockResolvedValueOnce('old-jwt').mockResolvedValueOnce('fresh-jwt');

    await expect(resolveAuthSession()).resolves.toEqual({
      status: 'authenticated',
      token: 'fresh-jwt',
      generation: 1,
    });
  });

  it('preserves the original JWT when the refreshed-token read throws', async () => {
    const rereadError = new Error('keychain relocked');
    getAuthTokenMock.mockResolvedValueOnce('old-jwt').mockRejectedValueOnce(rereadError);

    await expect(resolveAuthSession()).resolves.toEqual({
      status: 'authenticated',
      token: 'old-jwt',
      generation: 1,
      degraded: { stage: 'refreshed-token-read', error: rereadError },
    });
  });

  it('preserves the original JWT when a successful refresh is followed by an unexpected null read', async () => {
    getAuthTokenMock.mockResolvedValueOnce('old-jwt').mockResolvedValueOnce(null);

    const result = await resolveAuthSession();

    expect(result).toMatchObject({
      status: 'authenticated',
      token: 'old-jwt',
      generation: 1,
      degraded: { stage: 'refreshed-token-read' },
    });
    if (result.status !== 'authenticated') throw new Error('Expected an authenticated result');
    expect(result.degraded?.error).toBeInstanceOf(Error);
  });
});

describe('resolveAuthSession generation isolation', () => {
  it('returns superseded when an old foreground refresh finishes after a newer login', async () => {
    let releaseRefresh!: (result: RefreshResult) => void;
    deduplicatedRefreshMock.mockReturnValueOnce(
      new Promise<RefreshResult>((resolve) => {
        releaseRefresh = resolve;
      }),
    );

    const oldSessionCheck = resolveAuthSession();
    await vi.waitFor(() => expect(deduplicatedRefreshMock).toHaveBeenCalledOnce());
    authState.current = false;
    releaseRefresh({ status: 'unavailable', generation: 1, error: new Error('offline') });

    await expect(oldSessionCheck).resolves.toEqual({ status: 'superseded' });
  });

  it('returns superseded when generation changes during a successful expiry read', async () => {
    let releaseExpiryRead!: (expiring: boolean) => void;
    isTokenExpiringSoonMock.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        releaseExpiryRead = resolve;
      }),
    );

    const oldSessionCheck = resolveAuthSession();
    await vi.waitFor(() => expect(isTokenExpiringSoonMock).toHaveBeenCalledOnce());
    authState.current = false;
    releaseExpiryRead(false);

    await expect(oldSessionCheck).resolves.toEqual({ status: 'superseded' });
  });

  it('returns superseded when generation changes before a failing expiry read settles', async () => {
    let rejectExpiryRead!: (error: Error) => void;
    isTokenExpiringSoonMock.mockReturnValueOnce(
      new Promise<boolean>((_resolve, reject) => {
        rejectExpiryRead = reject;
      }),
    );

    const oldSessionCheck = resolveAuthSession();
    await vi.waitFor(() => expect(isTokenExpiringSoonMock).toHaveBeenCalledOnce());
    authState.current = false;
    rejectExpiryRead(new Error('old expiry read failed'));

    await expect(oldSessionCheck).resolves.toEqual({ status: 'superseded' });
  });

  it('returns superseded without telemetry when generation changes before a rejected refresh settles', async () => {
    let rejectRefresh!: (error: Error) => void;
    deduplicatedRefreshMock.mockReturnValueOnce(
      new Promise<RefreshResult>((_resolve, reject) => {
        rejectRefresh = reject;
      }),
    );

    const oldSessionCheck = resolveAuthSession();
    await vi.waitFor(() => expect(deduplicatedRefreshMock).toHaveBeenCalledOnce());
    authState.current = false;
    rejectRefresh(new Error('old refresh failed'));

    await expect(oldSessionCheck).resolves.toEqual({ status: 'superseded' });
    expect(reportHandledErrorMock).not.toHaveBeenCalled();
  });

  it('returns superseded when generation changes before the refreshed-token read rejects', async () => {
    let rejectRefreshedTokenRead!: (error: Error) => void;
    getAuthTokenMock.mockResolvedValueOnce('old-jwt').mockReturnValueOnce(
      new Promise<string>((_resolve, reject) => {
        rejectRefreshedTokenRead = reject;
      }),
    );

    const oldSessionCheck = resolveAuthSession();
    await vi.waitFor(() => expect(getAuthTokenMock).toHaveBeenCalledTimes(2));
    authState.current = false;
    rejectRefreshedTokenRead(new Error('old keychain read failed'));

    await expect(oldSessionCheck).resolves.toEqual({ status: 'superseded' });
  });

  it('returns superseded instead of unavailable when an old initial token read rejects after an account switch', async () => {
    let rejectTokenRead!: (error: Error) => void;
    getAuthTokenMock.mockReturnValueOnce(
      new Promise<string>((_resolve, reject) => {
        rejectTokenRead = reject;
      }),
    );

    const oldSessionCheck = resolveAuthSession();
    authState.current = false;
    rejectTokenRead(new Error('old keychain read failed'));

    await expect(oldSessionCheck).resolves.toEqual({ status: 'superseded' });
  });
});
