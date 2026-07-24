import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuroraRequestError } from '../api/errors';
import { CredentialSyncError, formatSyncHealthSummary, SyncRunner, type SyncHealthSnapshot } from './sync-runner';
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
};

const { mockDecrypt, mockEncrypt, mockSignIn, mockSyncUserData, mockSyncSharedData, mockSyncAuroraBoardLocations } =
  vi.hoisted(() => ({
    mockDecrypt: vi.fn(),
    mockEncrypt: vi.fn(),
    mockSignIn: vi.fn(),
    mockSyncUserData: vi.fn(),
    mockSyncSharedData: vi.fn(),
    mockSyncAuroraBoardLocations: vi.fn(),
  }));

vi.mock('@boardsesh/crypto', () => ({
  decrypt: mockDecrypt,
  encrypt: mockEncrypt,
}));

vi.mock('../sync/user-sync', () => ({
  syncUserData: mockSyncUserData,
}));

vi.mock('../sync/shared-sync', () => ({
  syncSharedData: mockSyncSharedData,
}));

vi.mock('../sync/locations-sync', () => ({
  AURORA_LOCATION_BOARDS: ['tension', 'decoy', 'touchstone', 'grasshopper', 'soill'],
  syncAuroraBoardLocations: mockSyncAuroraBoardLocations,
  syncAllAuroraBoardLocations: vi.fn(),
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

    mockDecrypt.mockImplementation((value: string) => `decrypted-${value}`);
    mockEncrypt.mockReturnValue('encrypted-token');
    mockSyncUserData.mockResolvedValue(undefined);
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
    // postgres-js is lazy; getClient() builds a client object but won't open a
    // connection until something runs a query. The throttle tests never get
    // there because syncSharedData is mocked.
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/test';
  });

  it('runs shared sync the first time it is asked for a board', async () => {
    const runner = new SyncRunner();
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    await runnerPrivates.maybeRunSharedSync('decoy', 'token-abc', 'user-1');

    expect(mockSyncSharedData).toHaveBeenCalledTimes(1);
    expect(mockSyncSharedData).toHaveBeenCalledWith(expect.anything(), 'decoy', 'token-abc', expect.any(Function));
    expect(mockSyncAuroraBoardLocations).toHaveBeenCalledTimes(1);
  });

  it('skips shared sync when called again within the cooldown window', async () => {
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000 });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    await runnerPrivates.maybeRunSharedSync('decoy', 'token-1', 'user-1');
    await runnerPrivates.maybeRunSharedSync('decoy', 'token-2', 'user-2');
    await runnerPrivates.maybeRunSharedSync('decoy', 'token-3', 'user-3');

    expect(mockSyncSharedData).toHaveBeenCalledTimes(1);
    expect(mockSyncAuroraBoardLocations).toHaveBeenCalledTimes(1);
  });

  it('runs shared sync again once the cooldown has elapsed', async () => {
    vi.useFakeTimers();
    try {
      const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000 });
      const runnerPrivates = runner as unknown as SyncRunnerPrivates;

      await runnerPrivates.maybeRunSharedSync('decoy', 'token-1', 'user-1');
      vi.advanceTimersByTime(30_000);
      await runnerPrivates.maybeRunSharedSync('decoy', 'token-2', 'user-2');
      vi.advanceTimersByTime(31_000);
      await runnerPrivates.maybeRunSharedSync('decoy', 'token-3', 'user-3');

      expect(mockSyncSharedData).toHaveBeenCalledTimes(2);
      expect(mockSyncAuroraBoardLocations).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throttles per board independently', async () => {
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000 });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    await runnerPrivates.maybeRunSharedSync('decoy', 'tok', 'u1');
    await runnerPrivates.maybeRunSharedSync('tension', 'tok', 'u2');
    await runnerPrivates.maybeRunSharedSync('grasshopper', 'tok', 'u3');
    // re-trigger each board within cooldown
    await runnerPrivates.maybeRunSharedSync('decoy', 'tok', 'u4');
    await runnerPrivates.maybeRunSharedSync('tension', 'tok', 'u5');

    expect(mockSyncSharedData).toHaveBeenCalledTimes(3);
    expect(mockSyncSharedData.mock.calls.map((call) => call[1])).toEqual(['decoy', 'tension', 'grasshopper']);
    expect(mockSyncAuroraBoardLocations).toHaveBeenCalledTimes(3);
  });

  it('still respects the cooldown when the previous run failed', async () => {
    const runner = new SyncRunner({ sharedSyncCooldownMs: 60_000 });
    const runnerPrivates = runner as unknown as SyncRunnerPrivates;

    mockSyncSharedData.mockRejectedValueOnce(new Error('aurora down'));

    await runnerPrivates.maybeRunSharedSync('decoy', 'tok', 'u1');
    await runnerPrivates.maybeRunSharedSync('decoy', 'tok', 'u2');

    expect(mockSyncSharedData).toHaveBeenCalledTimes(1);
    expect(mockSyncAuroraBoardLocations).not.toHaveBeenCalled();
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
