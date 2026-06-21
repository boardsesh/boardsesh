import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuroraRequestError } from '../api/errors';
import { SyncRunner } from './sync-runner';
import type { AuroraBoardName } from '../api/types';
import type { CredentialRecord } from './types';

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
    expect(updateCredentialStatus).toHaveBeenCalledWith('user-123', 'decoy', 'active', null, expect.any(Date), {
      credentialFailureCount: 0,
      lastCredentialFailureAt: null,
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
  });
});
