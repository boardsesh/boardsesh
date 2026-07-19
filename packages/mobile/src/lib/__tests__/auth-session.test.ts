import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState = {
  generation: 1,
  current: true,
  token: 'old-jwt' as string | null,
  expiring: true,
};
const getAuthTokenMock = vi.fn();
const isTokenExpiringSoonMock = vi.fn();
const deduplicatedRefreshMock = vi.fn();

type RefreshResult =
  | { status: 'refreshed'; generation: number }
  | { status: 'rejected'; generation: number }
  | { status: 'unavailable'; generation: number }
  | { status: 'superseded' };

vi.mock('../auth-store', () => ({
  captureAuthCredentialGeneration: () => authState.generation,
  getAuthToken: () => getAuthTokenMock(),
  isAuthCredentialGenerationCurrent: () => authState.current,
  isTokenExpiringSoon: () => isTokenExpiringSoonMock(),
}));

vi.mock('../auth-interceptor', () => ({
  deduplicatedRefresh: () => deduplicatedRefreshMock(),
}));

import { resolveAuthSession } from '../auth-session';

beforeEach(() => {
  authState.generation = 1;
  authState.current = true;
  authState.token = 'old-jwt';
  getAuthTokenMock.mockReset();
  getAuthTokenMock.mockImplementation(async () => authState.token);
  isTokenExpiringSoonMock.mockReset();
  isTokenExpiringSoonMock.mockResolvedValue(true);
  deduplicatedRefreshMock.mockReset();
  deduplicatedRefreshMock.mockResolvedValue({ status: 'refreshed', generation: 1 } satisfies RefreshResult);
});

describe('resolveAuthSession refresh status mapping', () => {
  it('maps a server-rejected refresh at expiry to anonymous', async () => {
    deduplicatedRefreshMock.mockResolvedValue({ status: 'rejected', generation: 1 } satisfies RefreshResult);

    await expect(resolveAuthSession()).resolves.toEqual({ status: 'anonymous' });
  });

  it('maps a transient network failure at expiry to unavailable, never anonymous', async () => {
    deduplicatedRefreshMock.mockResolvedValue({ status: 'unavailable', generation: 1 } satisfies RefreshResult);

    const result = await resolveAuthSession();

    expect(result.status).toBe('unavailable');
    expect(result.status).not.toBe('anonymous');
  });

  it('returns the refreshed token when the expiring credential refreshes', async () => {
    deduplicatedRefreshMock.mockResolvedValue({ status: 'refreshed', generation: 1 } satisfies RefreshResult);
    getAuthTokenMock.mockResolvedValue('fresh-jwt');

    await expect(resolveAuthSession()).resolves.toEqual({ status: 'authenticated', token: 'fresh-jwt' });
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
    await vi.waitFor(() => expect(deduplicatedRefreshMock).toHaveBeenCalledTimes(1));
    authState.current = false;
    authState.token = 'new-user-jwt';
    releaseRefresh({ status: 'refreshed', generation: 1 });

    await expect(oldSessionCheck).resolves.toEqual({ status: 'superseded' });
  });

  it('returns superseded when generation changes during the expiry read', async () => {
    let releaseExpiryRead!: (expiring: boolean) => void;
    isTokenExpiringSoonMock.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        releaseExpiryRead = resolve;
      }),
    );

    const oldSessionCheck = resolveAuthSession();
    await vi.waitFor(() => expect(isTokenExpiringSoonMock).toHaveBeenCalledTimes(1));
    authState.current = false;
    releaseExpiryRead(false);

    await expect(oldSessionCheck).resolves.toEqual({ status: 'superseded' });
  });

  it('returns superseded instead of unavailable when an old token read rejects after an account switch', async () => {
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
