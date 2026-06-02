import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KilterApiError } from '../api/errors';
import type { KilterCredentialRecord, RunnerDb } from './types';

/**
 * SyncRunner orchestration tests. The runner is glued to three layers we
 * stub here:
 *   - postgres / drizzle (db handle): a hand-rolled fluent shim records
 *     UPDATE chains so we can assert on syncStatus transitions.
 *   - `@boardsesh/crypto` (encrypt/decrypt): identity-ish so we can spot
 *     check refresh-token rotation.
 *   - `refreshAccessToken` + `syncKilterUserData`: hoisted vi.fn() stubs.
 *
 * The runner reaches for `process.env.DATABASE_URL` / `KILTER_OAUTH_CLIENT_ID`
 * inside getClient() / getKeycloakClient(). For tests that only exercise
 * the orchestration path (not the DB connect path) we either spy on the
 * relevant private method or set the env var to a dummy value — getClient
 * is lazy and never opens a real connection because we replace the db
 * handle via spying.
 */

const { mockDecrypt, mockEncrypt, mockRefreshAccessToken, mockSyncKilterUserData } = vi.hoisted(() => ({
  mockDecrypt: vi.fn(),
  mockEncrypt: vi.fn(),
  mockRefreshAccessToken: vi.fn(),
  mockSyncKilterUserData: vi.fn(),
}));

vi.mock('@boardsesh/crypto', () => ({
  decrypt: mockDecrypt,
  encrypt: mockEncrypt,
}));

vi.mock('../api/keycloak', () => ({
  refreshAccessToken: mockRefreshAccessToken,
}));

vi.mock('../sync/user-sync', () => ({
  syncKilterUserData: mockSyncKilterUserData,
}));

// Import after the mocks are wired so the runner picks up the doubles.
import { SyncRunner } from './sync-runner';

type SyncRunnerPrivates = {
  getNextCredentialToSync: (db: RunnerDb) => Promise<KilterCredentialRecord | null>;
  runCycleForCredential: (db: RunnerDb, cred: KilterCredentialRecord) => Promise<void>;
  getClient: () => { client: unknown; db: RunnerDb };
};

type UpdateCall = { table: unknown; set: Record<string, unknown> };

/**
 * Minimal db shim — applyXxx writes flow through `tx.update(...).set(...).where(...)`.
 * We capture each .set(...) payload so tests can assert on the new
 * syncStatus, syncError, encryptedRefreshToken values.
 */
function createDbShim() {
  const updates: UpdateCall[] = [];
  const shim = {
    update(table: unknown) {
      return {
        set(payload: Record<string, unknown>) {
          updates.push({ table, set: payload });
          return {
            where: (_cond: unknown) => Promise.resolve(),
          };
        },
      };
    },
  };
  return { db: shim as unknown as RunnerDb, updates };
}

function credential(overrides: Partial<KilterCredentialRecord> = {}): KilterCredentialRecord {
  return {
    userId: 'user-123',
    boardType: 'kilter',
    encryptedRefreshToken: 'enc-refresh',
    syncStatus: 'active',
    syncError: null,
    lastSyncAt: null,
    ...overrides,
  };
}

describe('SyncRunner.syncNextUser', () => {
  beforeEach(() => {
    mockDecrypt.mockReset();
    mockEncrypt.mockReset();
    mockRefreshAccessToken.mockReset();
    mockSyncKilterUserData.mockReset();

    mockDecrypt.mockImplementation((value: string) => `decrypted-${value}`);
    mockEncrypt.mockImplementation((value: string) => `encrypted-${value}`);

    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/test';
    process.env.KILTER_OAUTH_CLIENT_ID = 'kilter-test-client';
  });

  it('returns total: 0 when there are no credentials to sync', async () => {
    const runner = new SyncRunner();
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db } = createDbShim();
    vi.spyOn(privates, 'getClient').mockReturnValue({ client: {}, db });
    vi.spyOn(privates, 'getNextCredentialToSync').mockResolvedValue(null);

    const summary = await runner.syncNextUser();
    expect(summary).toEqual({ total: 0, successful: 0, failed: 0, errors: [] });
  });

  it('happy path: refreshes token, runs syncKilterUserData, marks active', async () => {
    const runner = new SyncRunner();
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db, updates } = createDbShim();
    vi.spyOn(privates, 'getClient').mockReturnValue({ client: {}, db });
    vi.spyOn(privates, 'getNextCredentialToSync').mockResolvedValue(credential());

    mockRefreshAccessToken.mockResolvedValue({
      access_token: 'new-access-token',
      expires_in: 300,
      token_type: 'Bearer',
      // No refresh_token rotation in this case.
    });
    mockSyncKilterUserData.mockResolvedValue(undefined);

    const summary = await runner.syncNextUser();

    expect(summary.successful).toBe(1);
    expect(summary.failed).toBe(0);
    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(1);
    expect(mockSyncKilterUserData).toHaveBeenCalledTimes(1);
    expect(mockSyncKilterUserData.mock.calls[0][0]).toMatchObject({
      userId: 'user-123',
      accessToken: 'new-access-token',
    });
    // Exactly one UPDATE at the end of the cycle setting syncStatus active.
    const activeUpdate = updates.find((u) => u.set.syncStatus === 'active');
    expect(activeUpdate?.set).toMatchObject({
      syncStatus: 'active',
      syncError: null,
    });
  });

  it('transient error leaves syncStatus untouched and reports failure', async () => {
    const runner = new SyncRunner();
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db, updates } = createDbShim();
    vi.spyOn(privates, 'getClient').mockReturnValue({ client: {}, db });
    vi.spyOn(privates, 'getNextCredentialToSync').mockResolvedValue(credential());

    mockRefreshAccessToken.mockRejectedValue(new KilterApiError('timeout', 'keycloak timed out'));

    const onError = vi.fn();
    const runnerWithErr = new SyncRunner({ onError });
    const privates2 = runnerWithErr as unknown as SyncRunnerPrivates;
    vi.spyOn(privates2, 'getClient').mockReturnValue({ client: {}, db });
    vi.spyOn(privates2, 'getNextCredentialToSync').mockResolvedValue(credential());

    const summary = await runnerWithErr.syncNextUser();

    expect(summary.failed).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({
      userId: 'user-123',
      boardType: 'kilter',
      error: 'keycloak timed out',
    });
    // No syncStatus write — transient errors leave the credential alone.
    expect(updates.find((u) => u.set.syncStatus !== undefined)).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('permanent KilterApiError (invalid_client) marks syncStatus error', async () => {
    const runner = new SyncRunner();
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db, updates } = createDbShim();
    vi.spyOn(privates, 'getClient').mockReturnValue({ client: {}, db });
    vi.spyOn(privates, 'getNextCredentialToSync').mockResolvedValue(credential());

    mockRefreshAccessToken.mockRejectedValue(
      new KilterApiError('invalid_client', 'Keycloak rejected client credentials'),
    );

    const summary = await runner.syncNextUser();

    expect(summary.failed).toBe(1);
    const errorUpdate = updates.find((u) => u.set.syncStatus === 'error');
    expect(errorUpdate?.set).toMatchObject({
      syncStatus: 'error',
      syncError: 'Keycloak rejected client credentials',
    });
  });

  it('invalid_grant marks syncStatus expired (re-auth signal, not "error")', async () => {
    const runner = new SyncRunner();
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db, updates } = createDbShim();
    vi.spyOn(privates, 'getClient').mockReturnValue({ client: {}, db });
    vi.spyOn(privates, 'getNextCredentialToSync').mockResolvedValue(credential());

    mockRefreshAccessToken.mockRejectedValue(new KilterApiError('invalid_grant', 'Refresh token rejected by Keycloak'));

    const summary = await runner.syncNextUser();

    expect(summary.failed).toBe(1);
    const expiredUpdate = updates.find((u) => u.set.syncStatus === 'expired');
    expect(expiredUpdate?.set).toMatchObject({
      syncStatus: 'expired',
      syncError: 'Refresh token rejected by Keycloak',
    });
    // Make sure we didn't ALSO mark it as 'error'.
    expect(updates.find((u) => u.set.syncStatus === 'error')).toBeUndefined();
  });

  it('persists rotated refresh tokens encrypted (write-back path)', async () => {
    const runner = new SyncRunner();
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db, updates } = createDbShim();
    vi.spyOn(privates, 'getClient').mockReturnValue({ client: {}, db });
    vi.spyOn(privates, 'getNextCredentialToSync').mockResolvedValue(credential());

    mockRefreshAccessToken.mockResolvedValue({
      access_token: 'new-access-token',
      expires_in: 300,
      token_type: 'Bearer',
      // refresh_token is different from `decrypted-enc-refresh` → triggers re-encrypt+write
      refresh_token: 'rotated-refresh-token',
    });
    mockSyncKilterUserData.mockResolvedValue(undefined);

    await runner.syncNextUser();

    expect(mockEncrypt).toHaveBeenCalledWith('rotated-refresh-token');
    const rotationUpdate = updates.find((u) => u.set.encryptedRefreshToken === 'encrypted-rotated-refresh-token');
    expect(rotationUpdate).toBeDefined();
  });

  it('does not write back when Keycloak returns the same refresh token', async () => {
    const runner = new SyncRunner();
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db, updates } = createDbShim();
    vi.spyOn(privates, 'getClient').mockReturnValue({ client: {}, db });
    vi.spyOn(privates, 'getNextCredentialToSync').mockResolvedValue(credential());

    mockRefreshAccessToken.mockResolvedValue({
      access_token: 'new-access-token',
      expires_in: 300,
      token_type: 'Bearer',
      refresh_token: 'decrypted-enc-refresh', // matches the decrypted incoming value → no rotation
    });
    mockSyncKilterUserData.mockResolvedValue(undefined);

    await runner.syncNextUser();

    expect(updates.find((u) => u.set.encryptedRefreshToken !== undefined)).toBeUndefined();
  });

  it('treats a missing refresh token as invalid_grant → expired', async () => {
    const runner = new SyncRunner();
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db, updates } = createDbShim();
    vi.spyOn(privates, 'getClient').mockReturnValue({ client: {}, db });
    vi.spyOn(privates, 'getNextCredentialToSync').mockResolvedValue(credential({ encryptedRefreshToken: null }));

    const summary = await runner.syncNextUser();

    expect(summary.failed).toBe(1);
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
    const expiredUpdate = updates.find((u) => u.set.syncStatus === 'expired');
    expect(expiredUpdate).toBeDefined();
    expect((expiredUpdate?.set.syncError as string) ?? '').toContain('must reconnect');
  });

  it('treats a generic non-KilterApiError as transient (fail-open)', async () => {
    const runner = new SyncRunner();
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db, updates } = createDbShim();
    vi.spyOn(privates, 'getClient').mockReturnValue({ client: {}, db });
    vi.spyOn(privates, 'getNextCredentialToSync').mockResolvedValue(credential());

    mockRefreshAccessToken.mockRejectedValue(new TypeError('something parsed wrong'));

    const summary = await runner.syncNextUser();

    expect(summary.failed).toBe(1);
    // No syncStatus write — generic errors are transient by design.
    expect(updates.find((u) => u.set.syncStatus !== undefined)).toBeUndefined();
  });
});
