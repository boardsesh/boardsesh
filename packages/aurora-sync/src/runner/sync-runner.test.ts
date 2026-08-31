import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR } from '@boardsesh/shared-schema/sync-error-codes';
import { SHARED_SYNC_COOLDOWN_CURSOR } from '@boardsesh/db/queries';
import { AuroraRequestError } from '../api/errors';
import {
  CredentialSyncError,
  formatSyncHealthSummary,
  sharedSyncCooldownAfterError,
  SyncRunner,
  type SyncHealthSnapshot,
} from './sync-runner';
import type { AuroraBoardName } from '../api/types';
import type { CredentialRecord, SyncErrorContext } from './types';

type SyncRunnerPrivates = {
  updateCredentialStatus: (
    userId: string,
    boardType: string,
    status: string,
    error?: string | null,
    lastSyncAt?: Date,
    credentialFailureUpdate?: {
      credentialFailureCount?: number;
      lastCredentialFailureAt?: Date | null;
    },
  ) => Promise<void>;
  updateStoredToken: (userId: string, boardType: string, token: string) => Promise<void>;
  syncSingleCredential: (cred: CredentialRecord) => Promise<void>;
  maybeRunSharedSync: (boardType: AuroraBoardName, token: string, userId: string) => Promise<void>;
  getActiveCredentials: () => Promise<CredentialRecord[]>;
  getNextCredentialToSync: () => Promise<CredentialRecord | null>;
  recordSyncFailure: (cred: CredentialRecord, errorMsg: string) => Promise<void>;
  recordInvalidCredentialFailure: (
    cred: CredentialRecord,
    errorMessage: string,
  ) => Promise<{ storedErrorMessage: string; status: string; quarantined: boolean }>;
  getSyncHealthSnapshot: () => Promise<SyncHealthSnapshot>;
};

const {
  mockDecrypt,
  mockEncrypt,
  mockSignIn,
  mockSyncUserData,
  mockHasForeignOwnedCircuitPlaylists,
  mockSyncSharedData,
  mockSyncAuroraBoardLocations,
  mockCrawlGymWalls,
  mockFindGymsDueForWallCrawl,
  mockClaimSharedSyncSlot,
  mockStampSharedSyncFinished,
  mockReadSharedSyncCursor,
} = vi.hoisted(() => ({
  mockDecrypt: vi.fn(),
  mockEncrypt: vi.fn(),
  mockSignIn: vi.fn(),
  mockSyncUserData: vi.fn(),
  mockHasForeignOwnedCircuitPlaylists: vi.fn(),
  mockSyncSharedData: vi.fn(),
  mockSyncAuroraBoardLocations: vi.fn(),
  mockCrawlGymWalls: vi.fn(),
  mockFindGymsDueForWallCrawl: vi.fn(),
  mockClaimSharedSyncSlot: vi.fn(),
  mockStampSharedSyncFinished: vi.fn(),
  mockReadSharedSyncCursor: vi.fn(),
}));

// The cooldown now lives in board_shared_syncs behind a compare-and-set instead
// of an in-memory Map, so these runner-level tests assert the runner DELEGATES
// correctly: claims before running, honours a refusal, and re-stamps whether
// the run succeeded or failed. The CAS semantics themselves — one winner under
// genuine concurrency, restart survival, cooldown expiry — are covered against
// real Postgres in packages/backend/src/__tests__/shared-sync-cooldown-cas.test.ts.
vi.mock('@boardsesh/db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/db/queries')>();
  return {
    ...actual,
    claimSharedSyncSlot: mockClaimSharedSyncSlot,
    stampSharedSyncFinished: mockStampSharedSyncFinished,
    readSharedSyncCursor: mockReadSharedSyncCursor,
    findGymsDueForWallCrawl: mockFindGymsDueForWallCrawl,
  };
});

vi.mock('@boardsesh/crypto', () => ({
  decrypt: mockDecrypt,
  encrypt: mockEncrypt,
}));

vi.mock('../sync/user-sync', () => ({
  syncUserData: mockSyncUserData,
  hasForeignOwnedCircuitPlaylists: mockHasForeignOwnedCircuitPlaylists,
}));

vi.mock('../sync/shared-sync', () => ({
  syncSharedData: mockSyncSharedData,
}));

vi.mock('../sync/locations-sync', () => ({
  AURORA_LOCATION_BOARDS: ['tension', 'decoy', 'touchstone', 'grasshopper', 'soill'],
  GYM_WALL_CRAWL_SLICE: 25,
  syncAuroraBoardLocations: mockSyncAuroraBoardLocations,
  syncAllAuroraBoardLocations: vi.fn(),
  crawlGymWallsForSourceKeys: mockCrawlGymWalls,
}));

vi.mock('../sync/gym-wall-fetcher', () => ({
  createAuroraGymUserFetcher: vi.fn(),
  createAuroraGymUserFetcherForToken: vi.fn(() => vi.fn()),
}));

vi.mock('../api/aurora-client', () => ({
  AuroraClimbingClient: class MockAuroraClimbingClient {
    signIn = mockSignIn;
  },
}));

describe('SyncRunner login failure handling', () => {
  beforeEach(() => {
    mockDecrypt.mockReset();
    mockEncrypt.mockReset();
    mockSignIn.mockReset();
    mockSyncUserData.mockReset();
    mockHasForeignOwnedCircuitPlaylists.mockReset();

    mockDecrypt.mockImplementation((value: string) => `decrypted-${value}`);
    mockEncrypt.mockReturnValue('encrypted-token');
    mockSyncUserData.mockResolvedValue({});
    mockHasForeignOwnedCircuitPlaylists.mockResolvedValue(false);
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  });

  it('keeps credential state unchanged for transient Aurora login failures', async () => {
    const runner = new SyncRunner();
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;
    const updateCredentialStatus = vi.spyOn(runnerPrivates, 'updateCredentialStatus').mockResolvedValue(undefined);

    mockSignIn.mockRejectedValue(
      new AuroraRequestError({
        code: 'http',
        message: 'Aurora HTTP 503 Service Unavailable',
        status: 503,
        statusText: 'Service Unavailable',
        url: 'https://decoyboardapp.com/sessions',
      }),
    );

    await expect(runnerPrivates.syncSingleCredential(createCredential())).rejects.toThrow(
      'Aurora HTTP 503 Service Unavailable',
    );

    expect(updateCredentialStatus).not.toHaveBeenCalled();
  });

  it('marks the first invalid credential failure as an error', async () => {
    const runner = new SyncRunner();
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;
    const updateCredentialStatus = vi.spyOn(runnerPrivates, 'updateCredentialStatus').mockResolvedValue(undefined);

    mockSignIn.mockRejectedValue(
      new AuroraRequestError({
        code: 'invalid_credentials',
        message: 'Invalid username or password',
        status: 422,
        statusText: 'Unprocessable Entity',
        url: 'https://decoyboardapp.com/sessions',
      }),
    );

    await expect(runnerPrivates.syncSingleCredential(createCredential())).rejects.toThrow(
      'Login failed: Invalid username or password',
    );

    expect(updateCredentialStatus).toHaveBeenCalledWith(
      'user-123',
      'decoy',
      'error',
      'Login failed: Invalid username or password',
      undefined,
      {
        credentialFailureCount: 1,
        lastCredentialFailureAt: expect.any(Date),
      },
    );
  });

  it('expires credentials after the second invalid credential failure', async () => {
    const runner = new SyncRunner();
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;
    const updateCredentialStatus = vi.spyOn(runnerPrivates, 'updateCredentialStatus').mockResolvedValue(undefined);

    mockSignIn.mockRejectedValue(
      new AuroraRequestError({
        code: 'invalid_credentials',
        message: 'Invalid username or password',
        status: 422,
        statusText: 'Unprocessable Entity',
        url: 'https://decoyboardapp.com/sessions',
      }),
    );

    await expect(runnerPrivates.syncSingleCredential(createCredential({ credentialFailureCount: 1 }))).rejects.toThrow(
      'Login failed: Invalid username or password (expired after 2 failed credential attempts; reconnect to resume sync)',
    );

    expect(updateCredentialStatus).toHaveBeenCalledWith(
      'user-123',
      'decoy',
      'expired',
      'Login failed: Invalid username or password (expired after 2 failed credential attempts; reconnect to resume sync)',
      undefined,
      {
        credentialFailureCount: 2,
        lastCredentialFailureAt: expect.any(Date),
      },
    );
  });

  it('clears credential failure counters after a successful login', async () => {
    const runner = new SyncRunner();
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    const updateStoredToken = vi.spyOn(runnerPrivates, 'updateStoredToken').mockResolvedValue(undefined);
    const updateCredentialStatus = vi.spyOn(runnerPrivates, 'updateCredentialStatus').mockResolvedValue(undefined);
    vi.spyOn(runnerPrivates, 'maybeRunSharedSync').mockResolvedValue(undefined);

    mockSignIn.mockResolvedValue({ token: 'fresh-token', user_id: 42 });

    await runnerPrivates.syncSingleCredential(
      createCredential({
        credentialFailureCount: 1,
        lastCredentialFailureAt: new Date('2026-06-16T00:00:00.000Z'),
      }),
    );

    expect(updateStoredToken).toHaveBeenCalledWith('user-123', 'decoy', 'fresh-token');
    // Success now also advances the attempt clock and clears the general
    // backoff counter + observability error.
    expect(updateCredentialStatus).toHaveBeenCalledWith('user-123', 'decoy', 'active', null, expect.any(Date), {
      credentialFailureCount: 0,
      lastCredentialFailureAt: null,
      lastSyncAttemptAt: expect.any(Date),
      consecutiveFailures: 0,
      lastSyncError: null,
    });
  });

  it('surfaces the duplicate-account sync_error CODE when circuits were skipped, without failing the cycle (#3526)', async () => {
    // Only the circuits were refused — the Aurora account is linked to another
    // Boardsesh user who owns the playlists. Everything else synced, so the
    // credential stays 'active' (a failed status would stop the daemon
    // re-picking it) but carries the machine-readable code the board card
    // localises: an empty playlist list with no explanation reads as "I have
    // no circuits".
    const runner = new SyncRunner();
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    vi.spyOn(runnerPrivates, 'updateStoredToken').mockResolvedValue(undefined);
    const updateCredentialStatus = vi.spyOn(runnerPrivates, 'updateCredentialStatus').mockResolvedValue(undefined);
    vi.spyOn(runnerPrivates, 'maybeRunSharedSync').mockResolvedValue(undefined);

    mockSignIn.mockResolvedValue({ token: 'fresh-token', user_id: 42 });
    mockHasForeignOwnedCircuitPlaylists.mockResolvedValue(true);

    await runnerPrivates.syncSingleCredential(createCredential());

    const [, , status, syncErrorCode] = updateCredentialStatus.mock.calls[0];
    expect(status).toBe('active');
    // A code, not a sentence: `es` / `fr` users get their own wording, and a
    // raw English string here is exactly what the board card can't localise.
    expect(syncErrorCode).toBe(DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR);
  });

  it('keeps the sync_error on a later cycle where Aurora returned no circuits at all (#3526)', async () => {
    // Aurora's user sync is incremental: once the watermark has advanced, a
    // cycle where nothing changed upstream carries no circuit rows. Deriving
    // the flag from "what did this cycle refuse" would clear the message right
    // back to null and leave the second user with a silent empty list again.
    const runner = new SyncRunner();
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    vi.spyOn(runnerPrivates, 'updateStoredToken').mockResolvedValue(undefined);
    const updateCredentialStatus = vi.spyOn(runnerPrivates, 'updateCredentialStatus').mockResolvedValue(undefined);
    vi.spyOn(runnerPrivates, 'maybeRunSharedSync').mockResolvedValue(undefined);

    mockSignIn.mockResolvedValue({ token: 'fresh-token', user_id: 42 });
    // No circuits in this delta at all...
    mockSyncUserData.mockResolvedValue({ circuits: { synced: 0 } });
    // ...but the duplicate link is still there in the data.
    mockHasForeignOwnedCircuitPlaylists.mockResolvedValue(true);

    await runnerPrivates.syncSingleCredential(createCredential());

    const [, , , syncErrorCode] = updateCredentialStatus.mock.calls[0];
    expect(syncErrorCode).toBe(DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR);
  });

  it('still marks the cycle successful when the duplicate-owner check itself fails (#3526)', async () => {
    // Fail-open. By this point every row the cycle wrote is committed and the
    // only thing left is a cosmetic status field, so a failed read here must
    // not drag the whole cycle into the failure path — that would bump
    // consecutive_failures, widen the backoff and leave last_sync_at
    // un-advanced, i.e. record a successful sync as a failure over a message.
    const runner = new SyncRunner();
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    vi.spyOn(runnerPrivates, 'updateStoredToken').mockResolvedValue(undefined);
    const updateCredentialStatus = vi.spyOn(runnerPrivates, 'updateCredentialStatus').mockResolvedValue(undefined);
    vi.spyOn(runnerPrivates, 'maybeRunSharedSync').mockResolvedValue(undefined);

    mockSignIn.mockResolvedValue({ token: 'fresh-token', user_id: 42 });
    mockHasForeignOwnedCircuitPlaylists.mockRejectedValue(new Error('relation "board_circuits" does not exist'));

    // Must not throw — the cycle succeeded.
    await expect(runnerPrivates.syncSingleCredential(createCredential())).resolves.toBeUndefined();

    const [, , status, errorMessage] = updateCredentialStatus.mock.calls[0];
    expect(status).toBe('active');
    // No duplicate reported, since we could not determine one.
    expect(errorMessage).toBeNull();
  });

  it('leaves sync_error null when circuits synced cleanly', async () => {
    // The negative case for the state check: a healthy account must never see
    // the duplicate-account message.
    const runner = new SyncRunner();
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    vi.spyOn(runnerPrivates, 'updateStoredToken').mockResolvedValue(undefined);
    const updateCredentialStatus = vi.spyOn(runnerPrivates, 'updateCredentialStatus').mockResolvedValue(undefined);
    vi.spyOn(runnerPrivates, 'maybeRunSharedSync').mockResolvedValue(undefined);

    mockSignIn.mockResolvedValue({ token: 'fresh-token', user_id: 42 });
    mockSyncUserData.mockResolvedValue({ circuits: { synced: 3 } });
    mockHasForeignOwnedCircuitPlaylists.mockResolvedValue(false);

    await runnerPrivates.syncSingleCredential(createCredential());

    const [, , status, errorMessage] = updateCredentialStatus.mock.calls[0];
    expect(status).toBe('active');
    expect(errorMessage).toBeNull();
  });

  it('does not increment credential failure counters for non-auth login errors', async () => {
    const runner = new SyncRunner();
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;
    const updateCredentialStatus = vi.spyOn(runnerPrivates, 'updateCredentialStatus').mockResolvedValue(undefined);

    mockSignIn.mockRejectedValue(new Error('Login succeeded but no token returned'));

    await expect(runnerPrivates.syncSingleCredential(createCredential())).rejects.toThrow(
      'Login failed: Login succeeded but no token returned',
    );

    expect(updateCredentialStatus).toHaveBeenCalledWith(
      'user-123',
      'decoy',
      'error',
      'Login failed: Login succeeded but no token returned',
    );
  });
});

function createCredential(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return { ...baseCredential(), ...overrides };
}

function baseCredential(): CredentialRecord {
  return {
    userId: 'user-123',
    boardType: 'decoy',
    encryptedUsername: 'enc-user',
    encryptedPassword: 'enc-pass',
    auroraUserId: 42,
    auroraToken: null,
    syncStatus: 'active',
    syncError: null,
    credentialFailureCount: 0,
    lastCredentialFailureAt: null,
    lastSyncAt: null,
    lastSyncAttemptAt: null,
    consecutiveFailures: 0,
  };
}

describe('SyncRunner shared-sync per-board throttle', () => {
  beforeEach(() => {
    mockSyncSharedData.mockReset();
    mockSyncSharedData.mockResolvedValue({ complete: true, results: {}, newClimbs: [] });
    mockSyncAuroraBoardLocations.mockReset();
    mockSyncAuroraBoardLocations.mockResolvedValue({ boardsSeen: 0, boardsUpserted: 0, boardsSkipped: 0 });
    mockCrawlGymWalls.mockReset();
    mockCrawlGymWalls.mockResolvedValue(0);
    mockFindGymsDueForWallCrawl.mockReset();
    mockFindGymsDueForWallCrawl.mockResolvedValue([]);
    mockClaimSharedSyncSlot.mockReset();
    mockStampSharedSyncFinished.mockReset();
    mockStampSharedSyncFinished.mockResolvedValue(true);
    mockReadSharedSyncCursor.mockReset();
    mockReadSharedSyncCursor.mockResolvedValue(new Date(Date.now() - 60_000));
    // postgres-js is lazy; getClient() builds a client object but won't open a
    // connection until something runs a query. These tests never get there
    // because syncSharedData and the cooldown queries are mocked.
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/test';
  });

  it('claims the persisted cooldown slot before running, keyed on the board', async () => {
    mockClaimSharedSyncSlot.mockResolvedValue('2026-07-31 23:00:00.000000');
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000 });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    await runnerPrivates.maybeRunSharedSync('decoy', 'token-abc', 'user-1');

    expect(mockClaimSharedSyncSlot).toHaveBeenCalledTimes(1);
    expect(mockClaimSharedSyncSlot.mock.calls[0][1]).toMatchObject({
      boardType: 'decoy',
      cursorName: SHARED_SYNC_COOLDOWN_CURSOR,
      cooldownMs: 60_000,
    });
    expect(mockSyncSharedData).toHaveBeenCalledTimes(1);
    expect(mockSyncSharedData).toHaveBeenCalledWith(expect.anything(), 'decoy', 'token-abc', expect.any(Function));
    expect(mockSyncAuroraBoardLocations).toHaveBeenCalledTimes(1);
  });

  it('skips the whole run when the slot is already claimed', async () => {
    // The refusal every instance-2 and every within-cooldown cycle gets.
    mockClaimSharedSyncSlot.mockResolvedValue(null);
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000 });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    await runnerPrivates.maybeRunSharedSync('decoy', 'token-1', 'user-1');

    expect(mockSyncSharedData).not.toHaveBeenCalled();
    expect(mockSyncAuroraBoardLocations).not.toHaveBeenCalled();
    // Nothing to re-stamp: we never held the slot, so touching the cursor would
    // extend another instance's cooldown.
    expect(mockStampSharedSyncFinished).not.toHaveBeenCalled();
  });

  it('re-stamps the cursor after a successful run so the cooldown starts at the end', async () => {
    mockClaimSharedSyncSlot.mockResolvedValue('2026-07-31 23:00:00.000000');
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000 });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    await runnerPrivates.maybeRunSharedSync('decoy', 'tok', 'u1');

    expect(mockStampSharedSyncFinished).toHaveBeenCalledTimes(1);
    expect(mockStampSharedSyncFinished.mock.calls[0][1]).toMatchObject({
      boardType: 'decoy',
      cursorName: SHARED_SYNC_COOLDOWN_CURSOR,
      claimToken: '2026-07-31 23:00:00.000000',
      fullCooldownMs: 60_000,
      nextCooldownMs: 60_000,
    });
  });

  it('keeps the full cooldown after an unknown failure, so a broken board does not loop every cycle', async () => {
    mockClaimSharedSyncSlot.mockResolvedValue('2026-07-31 23:00:00.000000');
    mockSyncSharedData.mockRejectedValueOnce(new Error('aurora down'));
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000 });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    await runnerPrivates.maybeRunSharedSync('decoy', 'tok', 'u1');

    expect(mockSyncAuroraBoardLocations).not.toHaveBeenCalled();
    expect(mockStampSharedSyncFinished).toHaveBeenCalledTimes(1);
    expect(mockStampSharedSyncFinished.mock.calls[0][1]).toMatchObject({
      fullCooldownMs: 60_000,
      nextCooldownMs: 60_000,
    });
  });

  it('uses a five-minute cooldown after a transient Aurora shared-sync failure', async () => {
    mockClaimSharedSyncSlot.mockResolvedValue('2026-07-31 23:00:00.000000');
    mockSyncSharedData.mockRejectedValueOnce(
      new AuroraRequestError({
        code: 'http',
        message: 'Aurora HTTP 503 Service Unavailable',
        status: 503,
      }),
    );
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60 * 60 * 1000 });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    await runnerPrivates.maybeRunSharedSync('decoy', 'tok', 'u1');

    expect(mockStampSharedSyncFinished.mock.calls[0][1]).toMatchObject({
      fullCooldownMs: 60 * 60 * 1000,
      nextCooldownMs: 5 * 60 * 1000,
    });
  });

  it('keeps the full cooldown after a permanent Aurora client failure', async () => {
    mockClaimSharedSyncSlot.mockResolvedValue('2026-07-31 23:00:00.000000');
    mockSyncSharedData.mockRejectedValueOnce(
      new AuroraRequestError({
        code: 'http',
        message: 'Aurora HTTP 404 Not Found',
        status: 404,
      }),
    );
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60 * 60 * 1000 });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    await runnerPrivates.maybeRunSharedSync('decoy', 'tok', 'u1');

    expect(mockStampSharedSyncFinished.mock.calls[0][1]).toMatchObject({
      fullCooldownMs: 60 * 60 * 1000,
      nextCooldownMs: 60 * 60 * 1000,
    });
  });

  it('uses the transient cooldown when the location refresh fails with a canonical network error', async () => {
    mockClaimSharedSyncSlot.mockResolvedValue('2026-07-31 23:00:00.000000');
    mockSyncAuroraBoardLocations.mockRejectedValueOnce(
      new AuroraRequestError({
        code: 'network',
        message: 'Aurora pins request failed',
      }),
    );
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60 * 60 * 1000 });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    await runnerPrivates.maybeRunSharedSync('decoy', 'tok', 'u1');

    expect(mockSyncSharedData).toHaveBeenCalledTimes(1);
    expect(mockSyncAuroraBoardLocations).toHaveBeenCalledTimes(1);
    expect(mockStampSharedSyncFinished.mock.calls[0][1]).toMatchObject({
      fullCooldownMs: 60 * 60 * 1000,
      nextCooldownMs: 5 * 60 * 1000,
    });
  });

  it('swallows lost claim ownership without reporting a credential failure', async () => {
    mockClaimSharedSyncSlot.mockResolvedValue('2026-07-31 23:00:00.000000');
    mockStampSharedSyncFinished.mockResolvedValue(false);
    const onError = vi.fn();
    const logs: string[] = [];
    const runner = new SyncRunner({
      sharedSyncCooldownMs: 60_000,
      onError,
      onLog: (message) => logs.push(message),
    });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    await expect(runnerPrivates.maybeRunSharedSync('decoy', 'tok', 'u1')).resolves.toBeUndefined();

    expect(onError).not.toHaveBeenCalled();
    expect(logs.some((message) => message.includes('leaving the newer cursor intact'))).toBe(true);
  });

  it('a claim DB error never escapes into the credential status', async () => {
    // By this point the user-half of the cycle has committed and been marked
    // active, so an error from a cooldown query must not bubble out of
    // maybeRunSharedSync and record a credential failure for a user whose sync
    // actually succeeded. The in-memory Map could never fail this way.
    mockClaimSharedSyncSlot.mockRejectedValue(new Error('connection reset'));
    const onError = vi.fn();
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000, onError });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    await expect(runnerPrivates.maybeRunSharedSync('decoy', 'tok', 'u1')).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalled();
    expect(mockSyncSharedData).not.toHaveBeenCalled();
  });

  it('a re-stamp DB error never escapes either, on the success path or the failure path', async () => {
    // Same reasoning for the finally-block stamp. Worst case of a missed stamp
    // is that the cooldown measures from the start of the run instead of its end.
    mockClaimSharedSyncSlot.mockResolvedValue('2026-07-31 23:00:00.000000');
    mockStampSharedSyncFinished.mockRejectedValue(new Error('connection reset'));
    const onError = vi.fn();
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000, onError });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    await expect(runnerPrivates.maybeRunSharedSync('decoy', 'tok', 'u1')).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();

    // And when the shared sync itself also failed — the path where the old code
    // ran a second stamp from inside the catch, so a throwing stamp escaped.
    onError.mockClear();
    mockSyncSharedData.mockRejectedValueOnce(new Error('aurora down'));
    await expect(runnerPrivates.maybeRunSharedSync('decoy', 'tok', 'u1')).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it('claims per board independently', async () => {
    mockClaimSharedSyncSlot.mockResolvedValue('2026-07-31 23:00:00.000000');
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000 });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    await runnerPrivates.maybeRunSharedSync('decoy', 'tok', 'u1');
    await runnerPrivates.maybeRunSharedSync('tension', 'tok', 'u2');
    await runnerPrivates.maybeRunSharedSync('grasshopper', 'tok', 'u3');

    // One cursor row per board, so a busy board never throttles a quiet one.
    expect(mockClaimSharedSyncSlot.mock.calls.map((call) => call[1].boardType)).toEqual([
      'decoy',
      'tension',
      'grasshopper',
    ]);
    expect(mockSyncSharedData.mock.calls.map((call) => call[1])).toEqual(['decoy', 'tension', 'grasshopper']);
  });

  it('crawls a slice of gym walls on the same borrowed token', async () => {
    // Reuses the shared sync's credential rather than opening a session of its
    // own — a second login per cycle would double the auth load on a real
    // climber's account for nothing.
    mockClaimSharedSyncSlot.mockResolvedValue('2026-07-31 23:00:00.000000');
    mockFindGymsDueForWallCrawl.mockResolvedValue(['tension:269111', 'tension:253398']);
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000 });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    await runnerPrivates.maybeRunSharedSync('tension', 'borrowed-token', 'user-1');

    expect(mockCrawlGymWalls).toHaveBeenCalledTimes(1);
    expect(mockCrawlGymWalls.mock.calls[0][0]).toMatchObject({
      board: 'tension',
      sourceKeys: ['tension:269111', 'tension:253398'],
    });
  });

  it('skips the crawl entirely when no gym is due', async () => {
    // The weekly floor is what makes this self-throttling: once the fleet is
    // covered, most cycles must cost nothing at all.
    mockClaimSharedSyncSlot.mockResolvedValue('2026-07-31 23:00:00.000000');
    mockFindGymsDueForWallCrawl.mockResolvedValue([]);
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000 });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    await runnerPrivates.maybeRunSharedSync('tension', 'borrowed-token', 'user-1');

    expect(mockCrawlGymWalls).not.toHaveBeenCalled();
  });

  it('never lets a crawl failure reach the credential, and never fails the shared sync', async () => {
    // THE load-bearing guarantee of the borrowed-credential design. The token
    // belongs to a real climber; if a crawl error escaped it would be recorded
    // against their credential and could quarantine their personal sync. Catalog
    // upkeep must never cost a user their account sync.
    mockClaimSharedSyncSlot.mockResolvedValue('2026-07-31 23:00:00.000000');
    mockFindGymsDueForWallCrawl.mockResolvedValue(['tension:269111']);
    mockCrawlGymWalls.mockRejectedValue(new Error('aurora exploded mid-crawl'));
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000 });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;
    const recordSyncFailure = vi.spyOn(runnerPrivates, 'recordSyncFailure');

    await expect(runnerPrivates.maybeRunSharedSync('tension', 'borrowed-token', 'user-1')).resolves.toBeUndefined();

    expect(recordSyncFailure).not.toHaveBeenCalled();
    // The shared sync itself still counts as a success, so the cooldown is
    // stamped normally rather than dropping to the transient retry window.
    expect(mockStampSharedSyncFinished).toHaveBeenCalledTimes(1);
  });

  it('does not crawl walls for a board with no location support', async () => {
    mockClaimSharedSyncSlot.mockResolvedValue('2026-07-31 23:00:00.000000');
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000 });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    await runnerPrivates.maybeRunSharedSync('kilter', 'token-abc', 'user-1');

    expect(mockCrawlGymWalls).not.toHaveBeenCalled();
  });
});

describe('sharedSyncCooldownAfterError', () => {
  const transientError = new AuroraRequestError({
    code: 'timeout',
    message: 'Aurora request timed out',
  });

  it('clamps the transient retry to five minutes for the default one-hour cooldown', () => {
    expect(sharedSyncCooldownAfterError(transientError, 60 * 60 * 1000)).toBe(5 * 60 * 1000);
  });

  it('does not lengthen a configured cooldown shorter than five minutes', () => {
    expect(sharedSyncCooldownAfterError(transientError, 60_000)).toBe(60_000);
  });

  it('keeps the full configured cooldown at the five-minute boundary and for unknown errors', () => {
    expect(sharedSyncCooldownAfterError(transientError, 5 * 60 * 1000)).toBe(5 * 60 * 1000);
    expect(sharedSyncCooldownAfterError(new Error('database failed'), 60 * 60 * 1000)).toBe(60 * 60 * 1000);
  });
});

describe('SyncRunner per-user fault isolation', () => {
  it('continues syncing remaining users when one user throws a SQL error', async () => {
    vi.useFakeTimers();
    try {
      const runner = new SyncRunner();
      const runnerPrivates = runner as unknown as SyncRunnerPrivates;

      const credA = createCredential({ userId: 'user-A' });
      const credB = createCredential({ userId: 'user-B' });
      const credC = createCredential({ userId: 'user-C' });

      vi.spyOn(runnerPrivates, 'getActiveCredentials').mockResolvedValue([credA, credB, credC]);

      const dbError = new Error(
        'Database error [code=23503 constraint=board_walls_layout_fk table=board_walls]: detail=Key not present',
      );
      const syncSingle = vi.spyOn(runnerPrivates, 'syncSingleCredential').mockImplementation(async (cred) => {
        if (cred.userId === 'user-B') throw dbError;
      });
      // recordSyncFailure would open a real DB connection; stub it and assert it
      // fires for the failed credential — the deprecated `all` path must stamp
      // the attempt clock + backoff counter exactly like syncNextUser.
      const recordSyncFailure = vi.spyOn(runnerPrivates, 'recordSyncFailure').mockResolvedValue(undefined);

      const syncPromise = runner.syncAllUsers();
      // syncAllUsers sleeps 10s after each successful credential — fast-forward through them
      await vi.runAllTimersAsync();
      const summary = await syncPromise;

      expect(syncSingle).toHaveBeenCalledTimes(3);
      expect(summary.total).toBe(3);
      expect(summary.successful).toBe(2);
      expect(summary.failed).toBe(1);
      expect(summary.errors).toEqual([
        {
          userId: 'user-B',
          boardType: 'decoy',
          error: dbError.message,
        },
      ]);
      // The one failed credential is stamped; the two successes are not (their
      // scheduler fields are cleared on the success path inside syncSingleCredential).
      expect(recordSyncFailure).toHaveBeenCalledTimes(1);
      expect(recordSyncFailure).toHaveBeenCalledWith(credB, dbError.message);
    } finally {
      vi.useRealTimers();
    }
  });

  it('syncNextUser does not throw on a SQL error and reports it in the summary', async () => {
    const runner = new SyncRunner();
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    const cred = createCredential({ userId: 'user-X' });
    vi.spyOn(runnerPrivates, 'getNextCredentialToSync').mockResolvedValue(cred);

    const dbError = new Error('Database error [code=23503 constraint=board_walls_user_fk table=board_walls]');
    vi.spyOn(runnerPrivates, 'syncSingleCredential').mockRejectedValue(dbError);
    // recordSyncFailure would open a real DB connection; stub it and assert it
    // was invoked (the scheduler/observability stamping is covered separately).
    const recordSyncFailure = vi.spyOn(runnerPrivates, 'recordSyncFailure').mockResolvedValue(undefined);

    const summary = await runner.syncNextUser();

    expect(summary).toEqual({
      total: 1,
      successful: 0,
      failed: 1,
      errors: [
        {
          userId: 'user-X',
          boardType: 'decoy',
          error: dbError.message,
        },
      ],
    });
    // Every failure stamps the attempt clock + backoff counter + last error so
    // the credential rotates out and backs off instead of wedging the queue.
    expect(recordSyncFailure).toHaveBeenCalledWith(cred, dbError.message);
  });
});

describe('SyncRunner.recordSyncFailure', () => {
  it('stamps the attempt clock, bumps consecutive_failures, and records last_sync_error', async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/test';
    const updates: Array<Record<string, unknown>> = [];
    const dbShim = {
      update() {
        return {
          set(payload: Record<string, unknown>) {
            updates.push(payload);
            return { where: () => Promise.resolve() };
          },
        };
      },
    };

    const runner = new SyncRunner();
    const runnerPrivates = runner as unknown as SyncRunnerPrivates & {
      getClient: () => { client: unknown; db: unknown };
    };
    vi.spyOn(runnerPrivates, 'getClient').mockReturnValue({ client: {}, db: dbShim });

    await runnerPrivates.recordSyncFailure(createCredential({ userId: 'user-Z' }), 'aurora exploded');

    expect(updates).toHaveLength(1);
    expect(updates[0].lastSyncAttemptAt).toBeInstanceOf(Date);
    expect(updates[0].lastSyncError).toBe('aurora exploded');
    // consecutive_failures is a SQL increment expression (COALESCE(...) + 1),
    // not a literal, so just assert it is present in the write.
    expect(updates[0].consecutiveFailures).toBeDefined();
    // A transient/generic failure must NOT touch the user-facing status/error.
    expect(updates[0].syncStatus).toBeUndefined();
    expect(updates[0].syncError).toBeUndefined();
    // A failed cycle must NEVER advance last_sync_at — that is the user-facing
    // "last successful sync" and only the success path may stamp it.
    expect(updates[0].lastSyncAt).toBeUndefined();
  });

  it('logs a FLAPPING event exactly when consecutive_failures crosses the threshold', async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/test';
    const dbShim = {
      update() {
        return { set: () => ({ where: () => Promise.resolve() }) };
      },
    };

    const runFor = async (priorConsecutiveFailures: number): Promise<string[]> => {
      const logs: string[] = [];
      const runner = new SyncRunner({ onLog: (msg) => logs.push(msg) });
      const runnerPrivates = runner as unknown as SyncRunnerPrivates & {
        getClient: () => { client: unknown; db: unknown };
      };
      vi.spyOn(runnerPrivates, 'getClient').mockReturnValue({ client: {}, db: dbShim });
      await runnerPrivates.recordSyncFailure(
        createCredential({ consecutiveFailures: priorConsecutiveFailures }),
        'aurora exploded',
      );
      return logs;
    };

    // Threshold is 5: the 5th consecutive failure (prior 4 → new 5) fires once.
    const atThreshold = await runFor(4);
    expect(atThreshold.some((msg) => msg.includes('CREDENTIAL FLAPPING'))).toBe(true);
    expect(atThreshold.find((msg) => msg.includes('CREDENTIAL FLAPPING'))).toContain('consecutiveFailures=5');

    // One below the threshold (new 4): no flap yet.
    const belowThreshold = await runFor(3);
    expect(belowThreshold.some((msg) => msg.includes('CREDENTIAL FLAPPING'))).toBe(false);

    // Already past the threshold (new 6): no repeat — the crossing already fired.
    const pastThreshold = await runFor(5);
    expect(pastThreshold.some((msg) => msg.includes('CREDENTIAL FLAPPING'))).toBe(false);
  });
});

describe('SyncRunner.recordInvalidCredentialFailure quarantine event', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/test';
  });

  it('logs a QUARANTINED event only when the credential expires (2nd failure)', async () => {
    const secondFailureLogs: string[] = [];
    const secondRunner = new SyncRunner({ onLog: (msg) => secondFailureLogs.push(msg) });
    const secondPrivates = secondRunner as unknown as SyncRunnerPrivates;
    vi.spyOn(secondPrivates, 'updateCredentialStatus').mockResolvedValue(undefined);

    const secondResult = await secondPrivates.recordInvalidCredentialFailure(
      createCredential({ credentialFailureCount: 1 }),
      'Login failed: Invalid username or password',
    );

    expect(secondResult).toEqual({
      storedErrorMessage: expect.stringContaining('expired after 2 failed credential attempts'),
      status: 'expired',
      quarantined: true,
    });
    const quarantineLine = secondFailureLogs.find((msg) => msg.includes('CREDENTIAL QUARANTINED'));
    expect(quarantineLine).toBeDefined();
    expect(quarantineLine).toContain('reason=invalid_credentials');

    // First failure (count 0 → 1): still 'error', no quarantine event.
    const firstFailureLogs: string[] = [];
    const firstRunner = new SyncRunner({ onLog: (msg) => firstFailureLogs.push(msg) });
    const firstPrivates = firstRunner as unknown as SyncRunnerPrivates;
    vi.spyOn(firstPrivates, 'updateCredentialStatus').mockResolvedValue(undefined);

    const firstResult = await firstPrivates.recordInvalidCredentialFailure(
      createCredential({ credentialFailureCount: 0 }),
      'Login failed: Invalid username or password',
    );

    expect(firstResult.status).toBe('error');
    expect(firstResult.quarantined).toBe(false);
    expect(firstFailureLogs.some((msg) => msg.includes('CREDENTIAL QUARANTINED'))).toBe(false);
  });
});

describe('SyncRunner enriched onError context', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/test';
  });

  it('reports the post-attempt failure ledger from a CredentialSyncError', async () => {
    const contexts: SyncErrorContext[] = [];
    const runner = new SyncRunner({ onError: (_error, context) => contexts.push(context) });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    vi.spyOn(runnerPrivates, 'getNextCredentialToSync').mockResolvedValue(
      createCredential({ userId: 'user-Q', syncStatus: 'error', consecutiveFailures: 1 }),
    );
    vi.spyOn(runnerPrivates, 'recordSyncFailure').mockResolvedValue(undefined);
    vi.spyOn(runnerPrivates, 'syncSingleCredential').mockRejectedValue(
      new CredentialSyncError('Login failed: bad (expired ...)', { syncStatus: 'expired', quarantined: true }),
    );

    await runner.syncNextUser();

    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toEqual({
      userId: 'user-Q',
      board: 'decoy',
      boardType: 'decoy',
      syncStatus: 'expired',
      consecutiveFailures: 2,
      quarantined: true,
    });
  });

  it('falls back to pre-attempt status with quarantined=false for a generic (DB) error', async () => {
    const contexts: SyncErrorContext[] = [];
    const runner = new SyncRunner({ onError: (_error, context) => contexts.push(context) });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    vi.spyOn(runnerPrivates, 'getNextCredentialToSync').mockResolvedValue(
      createCredential({ userId: 'user-D', syncStatus: 'active', consecutiveFailures: 0 }),
    );
    vi.spyOn(runnerPrivates, 'recordSyncFailure').mockResolvedValue(undefined);
    vi.spyOn(runnerPrivates, 'syncSingleCredential').mockRejectedValue(new Error('Database error [code=23503]'));

    await runner.syncNextUser();

    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toEqual({
      userId: 'user-D',
      board: 'decoy',
      boardType: 'decoy',
      syncStatus: 'active',
      consecutiveFailures: 1,
      quarantined: false,
    });
  });
});

describe('formatSyncHealthSummary', () => {
  it('renders counts, backoff, and the oldest attempt as an ISO string', () => {
    const snapshot: SyncHealthSnapshot = {
      total: 12,
      active: 8,
      pending: 1,
      error: 2,
      expired: 1,
      inBackoff: 3,
      oldestAttemptAt: new Date('2026-01-02T03:04:05.000Z'),
    };
    expect(formatSyncHealthSummary(snapshot)).toBe(
      '[SyncRunner] Sync health: 12 aurora credentials — active=8 pending=1 error=2 expired=1; ' +
        'inBackoff=3; oldestAttempt=2026-01-02T03:04:05.000Z',
    );
  });

  it('renders "never" when some credential has never been attempted', () => {
    const snapshot: SyncHealthSnapshot = {
      total: 2,
      active: 1,
      pending: 1,
      error: 0,
      expired: 0,
      inBackoff: 0,
      oldestAttemptAt: null,
    };
    expect(formatSyncHealthSummary(snapshot)).toContain('oldestAttempt=never');
  });
});

describe('SyncRunner.getSyncHealthSnapshot', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/test';
  });

  // The aggregate SQL (counts + the `not credentialRetryReadySql()` backoff
  // filter) is exercised against Postgres in prod; the backoff predicate's
  // correctness is anchored by the tested JS mirror (isCredentialInBackoff in
  // credential-backoff.test.ts). This test pins the method's JS mapping: string
  // counts from postgres-js are coerced to numbers and a null min() stays null.
  it('coerces the aggregate row into a typed snapshot', async () => {
    const oldest = new Date('2026-05-06T07:08:09.000Z');
    const dbShim = {
      select: () => ({
        from: () => ({
          // postgres-js returns bigint counts as strings unless cast; assert
          // the Number() coercion holds even if a driver hands back strings.
          where: () =>
            Promise.resolve([
              {
                total: '9',
                active: 5,
                pending: '1',
                error: 2,
                expired: '1',
                inBackoff: 3,
                oldestAttemptAt: oldest,
              },
            ]),
        }),
      }),
    };

    const runner = new SyncRunner();
    const runnerPrivates = runner as unknown as SyncRunnerPrivates & {
      getClient: () => { client: unknown; db: unknown };
    };
    vi.spyOn(runnerPrivates, 'getClient').mockReturnValue({ client: {}, db: dbShim });

    const snapshot = await runnerPrivates.getSyncHealthSnapshot();

    expect(snapshot).toEqual({
      total: 9,
      active: 5,
      pending: 1,
      error: 2,
      expired: 1,
      inBackoff: 3,
      oldestAttemptAt: oldest,
    });
  });

  // The regression that mattered. The test above models postgres-js's
  // string-ness for the COUNTS and then hands oldestAttemptAt a real Date —
  // the same blind spot the production code had, which is why nothing caught
  // `snapshot.oldestAttemptAt.toISOString is not a function` for a month. Drive
  // the raw Postgres text shape all the way through to the formatted line.
  it('formats a health summary when the driver hands back a raw timestamp string', async () => {
    const dbShim = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              {
                total: '4',
                active: '4',
                pending: '0',
                error: '0',
                expired: '0',
                inBackoff: '0',
                // `timestamp without time zone` as postgres-js yields it when
                // no column decoder is attached to the min() aggregate.
                oldestAttemptAt: '2026-05-06 07:08:09.123',
              },
            ]),
        }),
      }),
    };

    const runner = new SyncRunner();
    const runnerPrivates = runner as unknown as SyncRunnerPrivates & {
      getClient: () => { client: unknown; db: unknown };
    };
    vi.spyOn(runnerPrivates, 'getClient').mockReturnValue({ client: {}, db: dbShim });

    const snapshot = await runnerPrivates.getSyncHealthSnapshot();

    // On main this throws instead of returning a line.
    expect(() => formatSyncHealthSummary(snapshot)).not.toThrow();
    expect(formatSyncHealthSummary(snapshot)).toContain('oldestAttempt=2026-05-06T07:08:09.123');
  });

  it('defaults counts to 0 and oldestAttemptAt to null when no rows come back', async () => {
    const dbShim = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    };
    const runner = new SyncRunner();
    const runnerPrivates = runner as unknown as SyncRunnerPrivates & {
      getClient: () => { client: unknown; db: unknown };
    };
    vi.spyOn(runnerPrivates, 'getClient').mockReturnValue({ client: {}, db: dbShim });

    const snapshot = await runnerPrivates.getSyncHealthSnapshot();

    expect(snapshot).toEqual({
      total: 0,
      active: 0,
      pending: 0,
      error: 0,
      expired: 0,
      inBackoff: 0,
      oldestAttemptAt: null,
    });
  });
});
