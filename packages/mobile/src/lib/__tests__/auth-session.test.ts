import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState = {
  generation: 1,
  current: true,
  token: 'old-jwt' as string | null,
  expiring: true,
};
const ensureFreshTokenMock = vi.fn();
const getAuthTokenMock = vi.fn();
const isTokenExpiringSoonMock = vi.fn();

vi.mock('../auth-store', () => ({
  captureAuthCredentialGeneration: () => authState.generation,
  getAuthToken: () => getAuthTokenMock(),
  isAuthCredentialGenerationCurrent: () => authState.current,
  isTokenExpiringSoon: () => isTokenExpiringSoonMock(),
}));

vi.mock('../auth-interceptor', () => ({
  ensureFreshToken: () => ensureFreshTokenMock(),
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
  ensureFreshTokenMock.mockReset();
  ensureFreshTokenMock.mockResolvedValue(true);
});

describe('resolveAuthSession generation isolation', () => {
  it('returns superseded when an old foreground refresh finishes after a newer login', async () => {
    let releaseRefresh!: (refreshed: boolean) => void;
    ensureFreshTokenMock.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        releaseRefresh = resolve;
      }),
    );

    const oldSessionCheck = resolveAuthSession();
    await vi.waitFor(() => expect(ensureFreshTokenMock).toHaveBeenCalledTimes(1));
    authState.current = false;
    authState.token = 'new-user-jwt';
    releaseRefresh(false);

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
