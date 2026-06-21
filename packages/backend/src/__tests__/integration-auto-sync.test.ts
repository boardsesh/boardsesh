// @ts-nocheck — __tests__ is excluded from tsconfig.json, so the type-aware
// lint can't resolve node globals or `node:*` specifiers. Type-checking happens
// at test-run time via vitest.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// --- db mock ----------------------------------------------------------------
// select(...).from(...).where(...) is awaited directly (no .limit) for the
// participant-credentials fan-out, and .where(...).limit(...) for the per-user
// lookups inside syncPartySessionForUser. insert/update record their calls so
// we can assert export rows + credential status writes. The claim insert
// chains `.returning()` after `.onConflictDoUpdate(...)`; `claimReturning`
// controls whether the next claim wins ([row]) or loses ([]).
const selectResults = [];
let selectIndex = 0;
const insertCalls = [];
const updateCalls = [];
const claimReturning = [];
let claimIndex = 0;

function makeSelectChain() {
  const current = selectIndex++;
  const resolved = selectResults[current] ?? [];
  // `.where(...)` is awaited directly for the credential fan-out and chained to
  // `.limit(...)` for the per-user lookups. Return a real Promise (so awaiting
  // works) with a `.limit` method attached (so the chained form works too).
  const whereResult = Promise.resolve(resolved);
  whereResult.limit = vi.fn(() => Promise.resolve(resolved));
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => whereResult),
  };
  return chain;
}

vi.mock('../db/client', () => {
  const db = {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => ({
      values: vi.fn((values) => ({
        onConflictDoUpdate: vi.fn((config) => {
          insertCalls.push({ values, set: config?.set });
          // upsertSuccessExport/upsertErrorExport await this directly; the
          // claim insert chains .returning() — default to a won claim that
          // echoes the inserted values (claimExport verifies the returned row
          // carries its own status + syncedAt).
          const result = Promise.resolve(undefined);
          result.returning = vi.fn(() => {
            const claimResult = claimReturning[claimIndex] ?? [{ ...values }];
            claimIndex += 1;
            return Promise.resolve(claimResult);
          });
          return result;
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values) => ({
        where: vi.fn(() => {
          updateCalls.push({ set: values });
          return Promise.resolve(undefined);
        }),
      })),
    })),
  };
  return { db };
});

// --- credentials mock -------------------------------------------------------
const getFreshAccessToken = vi.fn();
const recordSyncSuccess = vi.fn(() => Promise.resolve());
vi.mock('../integrations/credentials', () => ({
  getFreshAccessToken: (...args) => getFreshAccessToken(...args),
  recordSyncSuccess: (...args) => recordSyncSuccess(...args),
}));

// --- provider registry mock -------------------------------------------------
const uploadSessionActivity = vi.fn();
vi.mock('../integrations/registry', async () => {
  const actual = await vi.importActual('../integrations/registry');
  return {
    ...actual,
    getProvider: vi.fn(() => ({
      provider: 'strava',
      uploadSessionActivity: (...args) => uploadSessionActivity(...args),
      activityUrl: (externalActivityId) => `https://www.strava.com/activities/${externalActivityId}`,
    })),
  };
});

import { IntegrationHttpError } from '../integrations/strava';
import { autoSyncSessionToIntegrations, syncPartySessionForUser } from '../integrations/export-service';

function resetState() {
  selectResults.length = 0;
  selectIndex = 0;
  insertCalls.length = 0;
  updateCalls.length = 0;
  claimReturning.length = 0;
  claimIndex = 0;
  vi.clearAllMocks();
  getFreshAccessToken.mockResolvedValue('access-token');
  recordSyncSuccess.mockResolvedValue(undefined);
}

function summaryWith(participants, overrides = {}) {
  return {
    sessionId: 'session-1',
    totalSends: 0,
    totalAttempts: 0,
    gradeDistribution: [],
    hardestClimb: null,
    participants,
    startedAt: '2026-06-01T10:00:00.000Z',
    endedAt: '2026-06-01T11:00:00.000Z',
    durationMinutes: 60,
    ...overrides,
  };
}

describe('autoSyncSessionToIntegrations', () => {
  beforeEach(resetState);

  it('skips when the summary is missing start/end times', async () => {
    await autoSyncSessionToIntegrations(
      'session-1',
      summaryWith([{ userId: 'user-1', sends: 1, attempts: 1 }], { startedAt: null }),
      'kilter/1',
    );
    // No credential lookup, no upload.
    expect(uploadSessionActivity).not.toHaveBeenCalled();
  });

  it('skips when there are no participants', async () => {
    await autoSyncSessionToIntegrations('session-1', summaryWith([]), 'kilter/1');
    expect(uploadSessionActivity).not.toHaveBeenCalled();
  });

  it('uploads only for active, auto-sync-enabled credentials returned by the query', async () => {
    // The auto-sync query already filters to active + autoSyncEnabled rows, so
    // the credential fan-out returns just user-1. Each user then loads its
    // credential and takes the export claim (insert) before uploading.
    selectResults.push([{ id: 1n, userId: 'user-1', provider: 'strava', status: 'active', autoSyncEnabled: true }]);
    selectResults.push([
      {
        id: 1n,
        userId: 'user-1',
        provider: 'strava',
        status: 'active',
        encryptedAccessToken: 'x',
        encryptedRefreshToken: 'y',
      },
    ]); // user-1 loadCredential
    uploadSessionActivity.mockResolvedValueOnce({
      externalActivityId: '111',
      url: 'https://www.strava.com/activities/111',
    });

    await autoSyncSessionToIntegrations(
      'session-1',
      summaryWith([{ userId: 'user-1', sends: 2, attempts: 4 }]),
      'kilter/1',
    );

    expect(uploadSessionActivity).toHaveBeenCalledTimes(1);
    // A success export row was upserted.
    const successRow = insertCalls.find((call) => call.values.status === 'success');
    expect(successRow).toBeTruthy();
    expect(successRow.values.externalActivityId).toBe('111');
  });

  it("one user's upload failure does not prevent the next user's upload", async () => {
    selectResults.push([
      { id: 1n, userId: 'user-1', provider: 'strava', status: 'active', autoSyncEnabled: true },
      { id: 2n, userId: 'user-2', provider: 'strava', status: 'active', autoSyncEnabled: true },
    ]);
    // user-1: loadCredential
    selectResults.push([
      {
        id: 1n,
        userId: 'user-1',
        provider: 'strava',
        status: 'active',
        encryptedAccessToken: 'x',
        encryptedRefreshToken: 'y',
      },
    ]);
    // user-2: loadCredential
    selectResults.push([
      {
        id: 2n,
        userId: 'user-2',
        provider: 'strava',
        status: 'active',
        encryptedAccessToken: 'x',
        encryptedRefreshToken: 'y',
      },
    ]);

    uploadSessionActivity
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockResolvedValueOnce({ externalActivityId: '222', url: 'https://www.strava.com/activities/222' });

    await autoSyncSessionToIntegrations(
      'session-1',
      summaryWith([
        { userId: 'user-1', sends: 1, attempts: 1 },
        { userId: 'user-2', sends: 2, attempts: 2 },
      ]),
      'kilter/1',
    );

    expect(uploadSessionActivity).toHaveBeenCalledTimes(2);
    // user-1 got an error export row; user-2 got a success export row.
    expect(insertCalls.some((call) => call.values.status === 'error')).toBe(true);
    const successRow = insertCalls.find((call) => call.values.status === 'success');
    expect(successRow?.values.externalActivityId).toBe('222');
  });

  it('marks the credential expired and records an error row on a 401 upload', async () => {
    selectResults.push([{ id: 7n, userId: 'user-1', provider: 'strava', status: 'active', autoSyncEnabled: true }]);
    selectResults.push([
      {
        id: 7n,
        userId: 'user-1',
        provider: 'strava',
        status: 'active',
        encryptedAccessToken: 'x',
        encryptedRefreshToken: 'y',
      },
    ]);
    uploadSessionActivity.mockRejectedValueOnce(new IntegrationHttpError('unauthorized', 401));

    await autoSyncSessionToIntegrations(
      'session-1',
      summaryWith([{ userId: 'user-1', sends: 1, attempts: 1 }]),
      'kilter/1',
    );

    // Error export row recorded.
    expect(insertCalls.some((call) => call.values.status === 'error')).toBe(true);
    // Credential status set to 'expired'.
    expect(updateCalls.some((call) => call.set.status === 'expired')).toBe(true);
  });
});

describe('syncPartySessionForUser export claim', () => {
  beforeEach(resetState);

  it('does not upload when another export already claimed the session', async () => {
    // loadCredential
    selectResults.push([
      {
        id: 1n,
        userId: 'user-1',
        provider: 'strava',
        status: 'active',
        encryptedAccessToken: 'x',
        encryptedRefreshToken: 'y',
      },
    ]);
    // The blocking row read after the lost claim: the concurrent auto-sync
    // already finished successfully.
    selectResults.push([
      {
        status: 'success',
        externalActivityId: '999',
        error: null,
        syncedAt: new Date('2026-06-01T11:00:00.000Z'),
      },
    ]);
    claimReturning.push([]); // claim lost

    const result = await syncPartySessionForUser(
      'strava',
      'user-1',
      'session-1',
      summaryWith([{ userId: 'user-1', sends: 1, attempts: 1 }]),
      'kilter/1',
    );

    expect(uploadSessionActivity).not.toHaveBeenCalled();
    expect(result.externalActivityId).toBe('999');
    expect(result.error).toBeNull();
  });
});
