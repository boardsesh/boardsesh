import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR } from '@boardsesh/shared-schema/sync-error-codes';
import { KilterApiError } from '../api/errors';
import { CATALOG_SYNC_COOLDOWN_CURSOR } from '@boardsesh/db/queries';
import { KILTER_BOARD_TYPE } from '../api/types';
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

const {
  mockDecrypt,
  mockEncrypt,
  mockRefreshAccessToken,
  mockSyncKilterUserData,
  mockSyncKilterCatalog,
  mockClaimSharedSyncSlot,
  mockStampSharedSyncFinished,
  mockReadSharedSyncCursor,
} = vi.hoisted(() => ({
  mockDecrypt: vi.fn(),
  mockEncrypt: vi.fn(),
  mockRefreshAccessToken: vi.fn(),
  mockSyncKilterUserData: vi.fn(),
  mockSyncKilterCatalog: vi.fn(),
  mockClaimSharedSyncSlot: vi.fn(),
  mockStampSharedSyncFinished: vi.fn(),
  mockReadSharedSyncCursor: vi.fn(),
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

// The catalog cooldown lives in board_shared_syncs behind a compare-and-set
// rather than an in-memory Map, so the tests below assert the runner DELEGATES
// correctly: claims before running, honours a refusal, re-stamps whether the
// run succeeded or failed, and never lets a cooldown DB error escape into the
// credential's status. The CAS semantics themselves are covered against real
// Postgres in packages/backend/src/__tests__/shared-sync-cooldown-cas.test.ts.
vi.mock('@boardsesh/db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/db/queries')>();
  return {
    ...actual,
    claimSharedSyncSlot: mockClaimSharedSyncSlot,
    stampSharedSyncFinished: mockStampSharedSyncFinished,
    readSharedSyncCursor: mockReadSharedSyncCursor,
  };
});

vi.mock('../sync/catalog-sync', () => ({
  syncKilterCatalog: mockSyncKilterCatalog,
}));

// Import after the mocks are wired so the runner picks up the doubles.
import { SyncRunner } from './sync-runner';

type SyncRunnerPrivates = {
  getNextCredentialToSync: (db: RunnerDb) => Promise<KilterCredentialRecord | null>;
  runCycleForCredential: (db: RunnerDb, cred: KilterCredentialRecord) => Promise<void>;
  getClient: () => { client: unknown; db: RunnerDb };
  maybeRunCatalogSync: (db: RunnerDb, cred: KilterCredentialRecord, currentToken: string) => Promise<void>;
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
    consecutiveFailures: 0,
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
    // Default to a clean cycle. syncKilterUserData returns a result object the
    // runner destructures (skippedForeignCircuits drives the duplicate-account
    // sync_error), so a bare `undefined` resolve would throw rather than fail
    // an assertion.
    mockSyncKilterUserData.mockResolvedValue({ skippedForeignCircuits: 0 });

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
    mockSyncKilterUserData.mockResolvedValue({ skippedForeignCircuits: 0 });

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
    // Success advances BOTH clocks: last_sync_at (user-facing "last synced")
    // and last_sync_attempt_at (scheduler fairness clock), and clears the
    // backoff counter + observability error.
    const activeUpdate = updates.find((u) => u.set.syncStatus === 'active');
    expect(activeUpdate?.set).toMatchObject({
      syncStatus: 'active',
      syncError: null,
      consecutiveFailures: 0,
      lastSyncError: null,
    });
    expect(activeUpdate?.set.lastSyncAt).toBeInstanceOf(Date);
    expect(activeUpdate?.set.lastSyncAttemptAt).toBeInstanceOf(Date);
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
    // No syncStatus write — transient errors leave the user-facing card alone.
    expect(updates.find((u) => u.set.syncStatus !== undefined)).toBeUndefined();
    // last_sync_attempt_at IS stamped (with a real Date — not null) so the
    // credential rotates to the back of the `last_sync_attempt_at ASC NULLS
    // FIRST` queue instead of monopolising it — but last_sync_at (the
    // user-facing "last successful sync") must NOT advance on a failed cycle.
    const attemptUpdate = updates.find((u) => u.set.lastSyncAttemptAt !== undefined);
    expect(attemptUpdate?.set.lastSyncAttemptAt).toBeInstanceOf(Date);
    expect(updates.find((u) => u.set.lastSyncAt !== undefined)).toBeUndefined();
    // The failure is no longer silent: the message is recorded (observability)
    // and the consecutive-failure counter is bumped (backoff) even though the
    // status stays untouched. This is the fix for the live kilter outage.
    expect(attemptUpdate?.set.lastSyncError).toBe('keycloak timed out');
    expect(attemptUpdate?.set.consecutiveFailures).toBeDefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('fail-CLOSED DB error (non-KilterApiError) → syncStatus=error, records last_sync_error, never last_sync_at', async () => {
    // A non-KilterApiError (a PostgresError, a TypeError) is now fail-CLOSED:
    // isTransientKilterError returns false, so the cycle escalates to
    // syncStatus='error' with an observable last_sync_error instead of
    // silently re-attempting forever (the live kilter outage). The credential
    // is NOT abandoned — 'error' stays selectable, so it retries on backoff —
    // but last_sync_at (the user-facing "last successful sync") must NOT
    // advance on a cycle that failed before applying data.
    const runner = new SyncRunner();
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db, updates } = createDbShim();
    vi.spyOn(privates, 'getClient').mockReturnValue({ client: {}, db });
    vi.spyOn(privates, 'getNextCredentialToSync').mockResolvedValue(credential());

    mockRefreshAccessToken.mockResolvedValue({
      access_token: 'new-access-token',
      expires_in: 300,
      token_type: 'Bearer',
    });
    mockSyncKilterUserData.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "boardsesh_ticks_kilter_id_unique"'),
    );

    const summary = await runner.syncNextUser();

    expect(summary.failed).toBe(1);
    const errorUpdate = updates.find((u) => u.set.syncStatus === 'error');
    expect(errorUpdate?.set.syncStatus).toBe('error');
    expect(errorUpdate?.set.lastSyncError).toContain('duplicate key value');
    expect(errorUpdate?.set.consecutiveFailures).toBeDefined();
    expect(errorUpdate?.set.lastSyncAttemptAt).toBeInstanceOf(Date);
    expect(updates.find((u) => u.set.lastSyncAt !== undefined)).toBeUndefined();
  });

  it('permanent error stamps syncStatus=error + last_sync_attempt_at, but NOT last_sync_at', async () => {
    // A permanent, non-invalid_grant KilterApiError maps to syncStatus
    // 'error' (which STAYS in the selection set), so it must also stamp
    // last_sync_attempt_at to avoid monopolising the queue — but a failed
    // cycle is not a successful sync, so last_sync_at must not advance.
    const runner = new SyncRunner();
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db, updates } = createDbShim();
    vi.spyOn(privates, 'getClient').mockReturnValue({ client: {}, db });
    vi.spyOn(privates, 'getNextCredentialToSync').mockResolvedValue(credential());

    mockRefreshAccessToken.mockRejectedValue(new KilterApiError('unknown', 'something broke'));

    const summary = await runner.syncNextUser();

    expect(summary.failed).toBe(1);
    const errorUpdate = updates.find((u) => u.set.syncStatus === 'error');
    expect(errorUpdate?.set).toMatchObject({ syncStatus: 'error', syncError: 'something broke' });
    // Permanent failures also record the observability error + bump the
    // backoff counter (an 'error' credential is still retried, so it must
    // back off).
    expect(errorUpdate?.set.lastSyncError).toBe('something broke');
    expect(errorUpdate?.set.consecutiveFailures).toBeDefined();
    expect(errorUpdate?.set.lastSyncAttemptAt).toBeInstanceOf(Date);
    expect(errorUpdate?.set.lastSyncAt).toBeUndefined();
  });

  it('transient KilterApiError (invalid_client) does NOT poison the credential — operator misconfig is retried', async () => {
    // invalid_client is an operator-level OAuth-client misconfig (wrong
    // KILTER_OAUTH_CLIENT_ID/SECRET) identical for every user, so it is
    // transient: the cycle fails but must not flip syncStatus to 'error'
    // (which would cascade across the whole user base as the daemon iterates).
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
    // No status-mutating update — the credential is left untouched for retry.
    expect(updates.find((u) => u.set.syncStatus === 'error')).toBeUndefined();
    expect(updates.find((u) => u.set.syncStatus === 'expired')).toBeUndefined();
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
    mockSyncKilterUserData.mockResolvedValue({ skippedForeignCircuits: 0 });

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
    mockSyncKilterUserData.mockResolvedValue({ skippedForeignCircuits: 0 });

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

  it('treats a generic non-KilterApiError as permanent (fail-closed) → syncStatus=error', async () => {
    const runner = new SyncRunner();
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db, updates } = createDbShim();
    vi.spyOn(privates, 'getClient').mockReturnValue({ client: {}, db });
    vi.spyOn(privates, 'getNextCredentialToSync').mockResolvedValue(credential());

    mockRefreshAccessToken.mockRejectedValue(new TypeError('something parsed wrong'));

    const summary = await runner.syncNextUser();

    expect(summary.failed).toBe(1);
    // Fail-closed: an unknown throw escalates to a visible 'error' with the
    // message recorded, instead of silently retrying as 'active' forever.
    const errorUpdate = updates.find((u) => u.set.syncStatus === 'error');
    expect(errorUpdate?.set.syncStatus).toBe('error');
    expect(errorUpdate?.set.lastSyncError).toBe('something parsed wrong');
  });

  it('resets consecutive_failures + last_sync_error to healthy on the next success', async () => {
    // A credential that had been failing (consecutiveFailures: 3) recovers:
    // the success path must zero the backoff counter and clear the error.
    const runner = new SyncRunner();
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db, updates } = createDbShim();
    vi.spyOn(privates, 'getClient').mockReturnValue({ client: {}, db });
    vi.spyOn(privates, 'getNextCredentialToSync').mockResolvedValue(credential({ consecutiveFailures: 3 }));

    mockRefreshAccessToken.mockResolvedValue({ access_token: 'tok', expires_in: 300, token_type: 'Bearer' });
    mockSyncKilterUserData.mockResolvedValue({ skippedForeignCircuits: 0 });

    await runner.syncNextUser();

    const activeUpdate = updates.find((u) => u.set.syncStatus === 'active');
    expect(activeUpdate?.set.consecutiveFailures).toBe(0);
    expect(activeUpdate?.set.lastSyncError).toBeNull();
  });

  it('surfaces the duplicate-account sync_error CODE when circuits were skipped, without failing the cycle (#3526)', async () => {
    // Everything else synced; only the circuits were refused because another
    // Boardsesh account owns the playlists. The credential must stay 'active'
    // (a failed status would stop the daemon re-picking it) but carry the
    // machine-readable code the board card localises — an empty playlist list
    // with no explanation reads as "I have no circuits".
    const runner = new SyncRunner();
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db, updates } = createDbShim();
    vi.spyOn(privates, 'getClient').mockReturnValue({ client: {}, db });
    vi.spyOn(privates, 'getNextCredentialToSync').mockResolvedValue(credential());

    mockRefreshAccessToken.mockResolvedValue({ access_token: 'tok', expires_in: 300, token_type: 'Bearer' });
    mockSyncKilterUserData.mockResolvedValue({ skippedForeignCircuits: 3 });

    const summary = await runner.syncNextUser();

    expect(summary.successful).toBe(1);
    expect(summary.failed).toBe(0);
    const activeUpdate = updates.find((u) => u.set.syncStatus === 'active');
    expect(activeUpdate?.set.syncStatus).toBe('active');
    // A code, not a sentence: `es` / `fr` users get their own wording, and a
    // raw English string here is exactly what the board card can't localise.
    expect(activeUpdate?.set.syncError).toBe(DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR);
    // Observability field stays clean: this was not a sync failure.
    expect(activeUpdate?.set.lastSyncError).toBeNull();
  });

  it('leaves sync_error null on a clean cycle', async () => {
    const runner = new SyncRunner();
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db, updates } = createDbShim();
    vi.spyOn(privates, 'getClient').mockReturnValue({ client: {}, db });
    vi.spyOn(privates, 'getNextCredentialToSync').mockResolvedValue(credential());

    mockRefreshAccessToken.mockResolvedValue({ access_token: 'tok', expires_in: 300, token_type: 'Bearer' });
    mockSyncKilterUserData.mockResolvedValue({ skippedForeignCircuits: 0 });

    await runner.syncNextUser();

    const activeUpdate = updates.find((u) => u.set.syncStatus === 'active');
    expect(activeUpdate?.set.syncError).toBeNull();
  });
});

describe('SyncRunner catalog-sync cooldown claim', () => {
  beforeEach(() => {
    mockSyncKilterCatalog.mockReset();
    mockSyncKilterCatalog.mockResolvedValue(undefined);
    mockClaimSharedSyncSlot.mockReset();
    mockStampSharedSyncFinished.mockReset();
    mockStampSharedSyncFinished.mockResolvedValue(undefined);
    mockReadSharedSyncCursor.mockReset();
    mockReadSharedSyncCursor.mockResolvedValue(new Date(Date.now() - 60_000));
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/test';
    process.env.KILTER_OAUTH_CLIENT_ID = 'kilter-test-client';
  });

  it('claims the persisted cooldown slot before pulling the catalog', async () => {
    mockClaimSharedSyncSlot.mockResolvedValue(true);
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000 });
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db } = createDbShim();

    await privates.maybeRunCatalogSync(db, credential(), 'access-token');

    expect(mockClaimSharedSyncSlot).toHaveBeenCalledTimes(1);
    expect(mockClaimSharedSyncSlot.mock.calls[0][1]).toMatchObject({
      boardType: KILTER_BOARD_TYPE,
      cursorName: CATALOG_SYNC_COOLDOWN_CURSOR,
      cooldownMs: 60_000,
    });
    expect(mockSyncKilterCatalog).toHaveBeenCalledTimes(1);
  });

  it('skips the catalog pull entirely when another instance holds the slot', async () => {
    // The refusal every instance-2 and every within-cooldown cycle gets. Before
    // the cooldown was persisted, a second container had its own empty Map and
    // would run a full catalog pull here.
    mockClaimSharedSyncSlot.mockResolvedValue(false);
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000 });
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db } = createDbShim();

    await privates.maybeRunCatalogSync(db, credential(), 'access-token');

    expect(mockSyncKilterCatalog).not.toHaveBeenCalled();
    // Nothing to re-stamp: we never held the slot, and touching the cursor
    // would extend the other instance's cooldown.
    expect(mockStampSharedSyncFinished).not.toHaveBeenCalled();
  });

  it('re-stamps the cursor after a successful pull so the cooldown starts at the end', async () => {
    mockClaimSharedSyncSlot.mockResolvedValue(true);
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000 });
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db } = createDbShim();

    await privates.maybeRunCatalogSync(db, credential(), 'access-token');

    expect(mockStampSharedSyncFinished).toHaveBeenCalledTimes(1);
    expect(mockStampSharedSyncFinished.mock.calls[0][1]).toMatchObject({
      boardType: KILTER_BOARD_TYPE,
      cursorName: CATALOG_SYNC_COOLDOWN_CURSOR,
    });
  });

  it('re-stamps when the pull failed, so a broken catalog does not loop every cycle', async () => {
    mockClaimSharedSyncSlot.mockResolvedValue(true);
    mockSyncKilterCatalog.mockRejectedValueOnce(new Error('kilter down'));
    const onError = vi.fn();
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000, onError });
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db } = createDbShim();

    await privates.maybeRunCatalogSync(db, credential(), 'access-token');

    expect(onError).toHaveBeenCalled();
    expect(mockStampSharedSyncFinished).toHaveBeenCalledTimes(1);
  });

  it('a claim DB error never escapes into the credential status', async () => {
    // The user-half of the cycle has already committed and been marked active
    // by this point, so an error from the cooldown query must not bubble out
    // and record a credential failure for a user whose sync succeeded.
    mockClaimSharedSyncSlot.mockRejectedValue(new Error('connection reset'));
    const onError = vi.fn();
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000, onError });
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db } = createDbShim();

    await expect(privates.maybeRunCatalogSync(db, credential(), 'access-token')).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalled();
    expect(mockSyncKilterCatalog).not.toHaveBeenCalled();
  });

  it('a re-stamp DB error never escapes either', async () => {
    // Same reasoning for the finally-block stamp: the worst case of a missed
    // stamp is that the cooldown measures from the start of the run.
    mockClaimSharedSyncSlot.mockResolvedValue(true);
    mockStampSharedSyncFinished.mockRejectedValue(new Error('connection reset'));
    const onError = vi.fn();
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000, onError });
    const privates = runner as unknown as SyncRunnerPrivates;
    const { db } = createDbShim();

    await expect(privates.maybeRunCatalogSync(db, credential(), 'access-token')).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalled();
  });
});
