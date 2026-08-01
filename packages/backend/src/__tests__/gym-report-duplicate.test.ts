import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { resetAllRateLimits } from '../utils/rate-limiter';
import { logger } from '../utils/logger';

const { mockRedisEval, mockRedisIsConnected, mockRedisReadyHandlers, mockRedisSet } = vi.hoisted(() => ({
  mockRedisEval: vi.fn(),
  mockRedisIsConnected: vi.fn(),
  mockRedisReadyHandlers: [] as Array<
    (redisClient: {
      set: (...args: unknown[]) => Promise<unknown>;
      eval: (...args: unknown[]) => Promise<unknown>;
    }) => void | Promise<void>
  >,
  mockRedisSet: vi.fn(),
}));

vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: mockRedisIsConnected,
    getClients: () => ({
      publisher: {
        eval: mockRedisEval,
        set: mockRedisSet,
      },
    }),
    onRedisReady: (
      handler: (redisClient: {
        set: (...args: unknown[]) => Promise<unknown>;
        eval: (...args: unknown[]) => Promise<unknown>;
      }) => void | Promise<void>,
    ) => {
      mockRedisReadyHandlers.push(handler);
      return () => {};
    },
  },
}));

// The resolver imports the email module via '../../../email/email-service', which
// resolves to the same absolute path as '../email/email-service' from here, so this
// mock intercepts it. vi.mock is hoisted; the `import` below binds to the mock.
vi.mock('../email/email-service', () => ({
  sendGymDuplicateReportAdminNotification: vi.fn(() => Promise.resolve()),
}));

import { socialGymReportMutations } from '../graphql/resolvers/social/gym-reports';
import { sendGymDuplicateReportAdminNotification } from '../email/email-service';
import { resetGymDuplicateReportClaimsForTests } from '../utils/gym-duplicate-report-claims';

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;
const anonCtx = (): ConnectionContext =>
  ({ connectionId: `conn-anon-${connectionCounter++}`, isAuthenticated: false }) as ConnectionContext;

const REPORTER = 'gdr-reporter';
const STRANGER = 'gdr-stranger';

const insertUser = (id: string, name: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${name}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

const insertGym = async (opts: {
  name: string;
  ownerId?: string;
  isPublic?: boolean;
  deleted?: boolean;
  mergedIntoId?: number | null;
}): Promise<{ id: number; uuid: string }> => {
  const { name, ownerId = REPORTER, isPublic = true, deleted = false, mergedIntoId = null } = opts;
  const uuid = uuidv4();
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, deleted_at, merged_into_gym_id, created_at, updated_at)
    VALUES (${uuid}, ${name}, ${uuid}, ${ownerId}, ${isPublic}, ${deleted ? sql`now()` : null}, ${mergedIntoId}, now(), now())
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid };
};

const reportGymDuplicate = (input: unknown, ctx: ConnectionContext) =>
  socialGymReportMutations.reportGymDuplicate(null, { input }, ctx) as Promise<{
    status: 'reported' | 'already_reported';
  }>;

beforeEach(async () => {
  resetAllRateLimits();
  resetGymDuplicateReportClaimsForTests();
  mockRedisIsConnected.mockReset();
  mockRedisIsConnected.mockReturnValue(false);
  mockRedisEval.mockReset();
  mockRedisEval.mockResolvedValue(1);
  mockRedisSet.mockReset();
  mockRedisSet.mockResolvedValue('OK');
  vi.mocked(sendGymDuplicateReportAdminNotification).mockClear();
  vi.mocked(sendGymDuplicateReportAdminNotification).mockImplementation(() => Promise.resolve());
  await db.execute(sql`TRUNCATE TABLE "gym_members", "gyms" RESTART IDENTITY CASCADE`);
  await insertUser(REPORTER, 'Reporter Rae');
  await insertUser(STRANGER, 'Strange Stranger');
});

describe('reportGymDuplicate — validation', () => {
  it('requires authentication', async () => {
    const gym = await insertGym({ name: 'Bahnhof Bloc' });
    const dup = await insertGym({ name: 'Bahnhof Bloc (Kilter)' });
    await expect(reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid }, anonCtx())).rejects.toThrow(
      /Authentication required/,
    );
    expect(sendGymDuplicateReportAdminNotification).not.toHaveBeenCalled();
  });

  it('rejects a gym reported as a duplicate of itself', async () => {
    const gym = await insertGym({ name: 'Bahnhof Bloc' });
    await expect(
      reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: gym.uuid }, authCtx(REPORTER)),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(sendGymDuplicateReportAdminNotification).not.toHaveBeenCalled();
  });

  it('rejects when the reporting gym does not exist', async () => {
    const dup = await insertGym({ name: 'Bahnhof Bloc' });
    await expect(
      reportGymDuplicate({ gymUuid: uuidv4(), duplicateGymUuid: dup.uuid }, authCtx(REPORTER)),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(sendGymDuplicateReportAdminNotification).not.toHaveBeenCalled();
  });

  it('rejects when the reported duplicate does not exist', async () => {
    const gym = await insertGym({ name: 'Bahnhof Bloc' });
    await expect(
      reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: uuidv4() }, authCtx(REPORTER)),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it('treats a soft-deleted or already-merged gym as gone', async () => {
    const gym = await insertGym({ name: 'Bahnhof Bloc' });
    const deleted = await insertGym({ name: 'Bahnhof Bloc', deleted: true });
    const merged = await insertGym({ name: 'Bahnhof Bloc', mergedIntoId: gym.id });
    await expect(
      reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: deleted.uuid }, authCtx(REPORTER)),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    await expect(
      reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: merged.uuid }, authCtx(REPORTER)),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it("won't confirm or email a stranger's private gym (no existence oracle)", async () => {
    const gym = await insertGym({ name: 'Bahnhof Bloc' });
    // A private gym owned by someone else — invisible to this reporter.
    const strangerPrivate = await insertGym({ name: 'Secret Home Wall', ownerId: STRANGER, isPublic: false });
    await expect(
      reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: strangerPrivate.uuid }, authCtx(REPORTER)),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(sendGymDuplicateReportAdminNotification).not.toHaveBeenCalled();
  });

  it('lets a reporter flag their OWN private gym as a duplicate', async () => {
    const gym = await insertGym({ name: 'Bahnhof Bloc' });
    const ownPrivate = await insertGym({ name: 'My Garage', ownerId: REPORTER, isPublic: false });
    const result = await reportGymDuplicate(
      { gymUuid: gym.uuid, duplicateGymUuid: ownPrivate.uuid },
      authCtx(REPORTER),
    );
    expect(result).toEqual({ status: 'reported' });
    expect(sendGymDuplicateReportAdminNotification).toHaveBeenCalledTimes(1);
  });
});

describe('reportGymDuplicate — admin notification', () => {
  it('emails the team with both gyms and the reporter name, then returns reported', async () => {
    const gym = await insertGym({ name: 'Bahnhof Bloc' });
    const dup = await insertGym({ name: 'Bahnhof Bloc (Kilter)' });

    const result = await reportGymDuplicate(
      { gymUuid: gym.uuid, duplicateGymUuid: dup.uuid, note: 'Same wall, two entries' },
      authCtx(REPORTER),
    );

    expect(result).toEqual({ status: 'reported' });
    expect(sendGymDuplicateReportAdminNotification).toHaveBeenCalledTimes(1);
    expect(sendGymDuplicateReportAdminNotification).toHaveBeenCalledWith({
      gymName: 'Bahnhof Bloc',
      gymUuid: gym.uuid,
      duplicateGymName: 'Bahnhof Bloc (Kilter)',
      duplicateGymUuid: dup.uuid,
      reporterName: 'Reporter Rae',
      note: 'Same wall, two entries',
    });
  });
});

describe('reportGymDuplicate — de-duplication', () => {
  it('uses a distinct Redis SET NX PXAT claim after the per-user rate-limit eval', async () => {
    mockRedisIsConnected.mockReturnValue(true);
    const gym = await insertGym({ name: 'Bahnhof Bloc' });
    const dup = await insertGym({ name: 'Bahnhof Bloc (Kilter)' });

    const result = await reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid }, authCtx(REPORTER));

    expect(result).toEqual({ status: 'reported' });
    expect(mockRedisEval).toHaveBeenCalledTimes(1);
    expect(mockRedisEval.mock.calls[0][0]).toContain("redis.call('INCR'");
    const [lowUuid, highUuid] = [gym.uuid, dup.uuid].sort();
    expect(mockRedisSet).toHaveBeenCalledExactlyOnceWith(
      `gymDuplicateReport:${lowUuid}:${highUuid}`,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      'PXAT',
      expect.any(Number),
      'NX',
    );
  });

  it('de-dupes a repeat report of the same pair without re-emailing', async () => {
    const gym = await insertGym({ name: 'Bahnhof Bloc' });
    const dup = await insertGym({ name: 'Bahnhof Bloc (Kilter)' });

    const first = await reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid }, authCtx(REPORTER));
    const second = await reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid }, authCtx(REPORTER));

    expect(first).toEqual({ status: 'reported' });
    expect(second).toEqual({ status: 'already_reported' });
    expect(sendGymDuplicateReportAdminNotification).toHaveBeenCalledTimes(1);
  });

  it('de-dupes the same public pair across different reporters', async () => {
    const gym = await insertGym({ name: 'Bahnhof Bloc' });
    const dup = await insertGym({ name: 'Bahnhof Bloc (Kilter)' });

    await expect(
      reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid }, authCtx(REPORTER)),
    ).resolves.toEqual({ status: 'reported' });
    await expect(
      reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid }, authCtx(STRANGER)),
    ).resolves.toEqual({ status: 'already_reported' });

    expect(sendGymDuplicateReportAdminNotification).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent reversed-pair reports before the first email resolves', async () => {
    const gym = await insertGym({ name: 'Bahnhof Bloc' });
    const dup = await insertGym({ name: 'Bahnhof Bloc (Kilter)' });
    let finishEmail: (() => void) | undefined;
    vi.mocked(sendGymDuplicateReportAdminNotification).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishEmail = resolve;
        }),
    );

    const firstReport = reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid }, authCtx(REPORTER));
    await vi.waitFor(() => expect(sendGymDuplicateReportAdminNotification).toHaveBeenCalledTimes(1));

    const reversedReport = await reportGymDuplicate(
      { gymUuid: dup.uuid, duplicateGymUuid: gym.uuid },
      authCtx(REPORTER),
    );
    expect(reversedReport).toEqual({ status: 'already_reported' });

    finishEmail?.();
    await expect(firstReport).resolves.toEqual({ status: 'reported' });
    expect(sendGymDuplicateReportAdminNotification).toHaveBeenCalledTimes(1);
  });

  it('promotes a successful local claim when a later request observes Redis recovery', async () => {
    const gym = await insertGym({ name: 'Bahnhof Bloc' });
    const dup = await insertGym({ name: 'Bahnhof Bloc (Kilter)' });

    await expect(
      reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid }, authCtx(REPORTER)),
    ).resolves.toEqual({ status: 'reported' });

    mockRedisIsConnected.mockReturnValue(true);
    await expect(
      reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid }, authCtx(REPORTER)),
    ).resolves.toEqual({ status: 'already_reported' });

    expect(mockRedisSet).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^gymDuplicateReport:/),
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      'PXAT',
      expect.any(Number),
      'NX',
    );
    expect(sendGymDuplicateReportAdminNotification).toHaveBeenCalledTimes(1);
  });

  it('promotes on the Redis readiness hook before another process checks the pair', async () => {
    expect(mockRedisReadyHandlers).toHaveLength(1);
    let distributedOwnerToken: string | null = null;
    mockRedisSet.mockImplementation(async (_key: string, ownerToken: string) => {
      if (distributedOwnerToken !== null) return null;
      distributedOwnerToken = ownerToken;
      return 'OK';
    });
    const gym = await insertGym({ name: 'Recovery Bloc' });
    const dup = await insertGym({ name: 'Recovery Bloc (old)' });

    await expect(
      reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid }, authCtx(REPORTER)),
    ).resolves.toEqual({ status: 'reported' });
    expect(mockRedisSet).not.toHaveBeenCalled();

    await mockRedisReadyHandlers[0]({ set: mockRedisSet, eval: mockRedisEval });
    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^gymDuplicateReport:/),
      distributedOwnerToken,
      'PXAT',
      expect.any(Number),
      'NX',
    );

    // Drop this process's local memory. Redis alone now represents the other
    // instance/restart and must prevent a second notification.
    resetGymDuplicateReportClaimsForTests();
    mockRedisIsConnected.mockReturnValue(true);
    await expect(
      reportGymDuplicate({ gymUuid: dup.uuid, duplicateGymUuid: gym.uuid }, authCtx(REPORTER)),
    ).resolves.toEqual({ status: 'already_reported' });
    expect(sendGymDuplicateReportAdminNotification).toHaveBeenCalledTimes(1);
  });

  it('keeps a Redis claim effective after process-local state is reset', async () => {
    mockRedisIsConnected.mockReturnValue(true);
    let storedOwnerToken: string | null = null;
    mockRedisSet.mockImplementation(async (_key: string, ownerToken: string) => {
      if (storedOwnerToken !== null) return null;
      storedOwnerToken = ownerToken;
      return 'OK';
    });
    const gym = await insertGym({ name: 'Bahnhof Bloc' });
    const dup = await insertGym({ name: 'Bahnhof Bloc (Kilter)' });

    await expect(
      reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid }, authCtx(REPORTER)),
    ).resolves.toEqual({ status: 'reported' });
    resetGymDuplicateReportClaimsForTests();

    await expect(
      reportGymDuplicate({ gymUuid: dup.uuid, duplicateGymUuid: gym.uuid }, authCtx(REPORTER)),
    ).resolves.toEqual({ status: 'already_reported' });
    expect(mockRedisSet).toHaveBeenCalledTimes(2);
    expect(sendGymDuplicateReportAdminNotification).toHaveBeenCalledTimes(1);
  });

  it('de-dupes regardless of which gym is named first', async () => {
    const gym = await insertGym({ name: 'Bahnhof Bloc' });
    const dup = await insertGym({ name: 'Bahnhof Bloc (Kilter)' });

    await reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid }, authCtx(REPORTER));
    const flipped = await reportGymDuplicate({ gymUuid: dup.uuid, duplicateGymUuid: gym.uuid }, authCtx(REPORTER));

    expect(flipped).toEqual({ status: 'already_reported' });
    expect(sendGymDuplicateReportAdminNotification).toHaveBeenCalledTimes(1);
  });

  it('releases the pair when the email send fails, so a retry goes through', async () => {
    const gym = await insertGym({ name: 'Bahnhof Bloc' });
    const dup = await insertGym({ name: 'Bahnhof Bloc (Kilter)' });

    vi.mocked(sendGymDuplicateReportAdminNotification).mockRejectedValueOnce(new Error('SMTP down'));

    await expect(
      reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid }, authCtx(REPORTER)),
    ).rejects.toMatchObject({ extensions: { code: 'INTERNAL_SERVER_ERROR' } });

    const retry = await reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid }, authCtx(REPORTER));
    expect(retry).toEqual({ status: 'reported' });
    expect(sendGymDuplicateReportAdminNotification).toHaveBeenCalledTimes(2);
  });

  it('cleans an apply-then-throw Redis claim after email failure so retry succeeds', async () => {
    mockRedisIsConnected.mockReturnValue(true);
    let storedOwnerToken: string | null = null;
    mockRedisSet
      .mockImplementationOnce(async (_key: string, ownerToken: string) => {
        storedOwnerToken = ownerToken;
        throw new Error('connection closed after write');
      })
      .mockImplementationOnce(async (_key: string, ownerToken: string) => {
        if (storedOwnerToken !== null) return null;
        storedOwnerToken = ownerToken;
        return 'OK';
      });
    mockRedisEval.mockImplementation(
      async (_script: string, _numberOfKeys: number, claimKey: string, ownerToken: string) => {
        if (!claimKey.startsWith('gymDuplicateReport:')) return 1;
        if (storedOwnerToken === ownerToken) {
          storedOwnerToken = null;
          return 1;
        }
        return 0;
      },
    );
    const gym = await insertGym({ name: 'Bahnhof Bloc' });
    const dup = await insertGym({ name: 'Bahnhof Bloc (Kilter)' });
    vi.mocked(sendGymDuplicateReportAdminNotification).mockRejectedValueOnce(new Error('SMTP down'));

    await expect(
      reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid }, authCtx(REPORTER)),
    ).rejects.toMatchObject({ extensions: { code: 'INTERNAL_SERVER_ERROR' } });

    await expect(
      reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid }, authCtx(REPORTER)),
    ).resolves.toEqual({ status: 'reported' });
    expect(mockRedisSet).toHaveBeenCalledTimes(2);
    expect(sendGymDuplicateReportAdminNotification).toHaveBeenCalledTimes(2);
  });

  it('sanitizes email-provider errors, logs privacy-safe cleanup warnings, and preserves the failure', async () => {
    mockRedisIsConnected.mockReturnValue(true);
    mockRedisEval.mockImplementation(async (_script: string, _numberOfKeys: number, claimKey: string) => {
      if (!claimKey.startsWith('gymDuplicateReport:')) return 1;
      throw new Error('release failed');
    });
    const gym = await insertGym({ name: 'Bahnhof Bloc' });
    const dup = await insertGym({ name: 'Bahnhof Bloc (Kilter)' });
    const sensitiveNote = 'The owner told me this wall is private';
    const emailError = new Error(
      `Postmark rejected gym=${gym.uuid} duplicate=${dup.uuid} reporter=Reporter Rae note=${sensitiveNote}`,
    );
    vi.mocked(sendGymDuplicateReportAdminNotification).mockRejectedValueOnce(emailError);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    await expect(
      reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid, note: sensitiveNote }, authCtx(REPORTER)),
    ).rejects.toMatchObject({
      message: "We couldn't send that report. Try again in a moment.",
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });

    expect(errorSpy).toHaveBeenCalledWith(
      '[GymDuplicateReport] Failed to send admin notification:',
      expect.objectContaining({ message: 'Gym duplicate report admin notification delivery failed' }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[GymDuplicateReport] Redis claim cleanup failed; the claim will expire automatically.',
    );
    const warningOutput = JSON.stringify(warnSpy.mock.calls);
    const errorCalls = errorSpy.mock.calls as unknown as ReadonlyArray<readonly unknown[]>;
    const loggedError = errorCalls[0]?.[1];
    expect(loggedError).toBeInstanceOf(Error);
    if (!(loggedError instanceof Error)) throw new Error('Expected a sanitized Error log argument');
    const errorOutput = `${loggedError.name}: ${loggedError.message}`;
    expect(warningOutput).not.toContain(gym.uuid);
    expect(warningOutput).not.toContain(dup.uuid);
    expect(warningOutput).not.toContain(mockRedisSet.mock.calls[0][1] as string);
    expect(errorOutput).not.toContain(gym.uuid);
    expect(errorOutput).not.toContain(dup.uuid);
    expect(errorOutput).not.toContain('Reporter Rae');
    expect(errorOutput).not.toContain(sensitiveNote);

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('reportGymDuplicate — rate limit', () => {
  it('rate limits repeated reports with a RATE_LIMITED code', async () => {
    const rateLimitUser = `gdr-rl-${uuidv4()}`;
    await insertUser(rateLimitUser, 'Rate Limited');
    const ctx = authCtx(rateLimitUser);
    const gym = await insertGym({ name: 'Bahnhof Bloc' });

    // Distinct duplicate targets so the per-pair de-dup never short-circuits before
    // the per-user limiter (10/min) trips. The bound is generous, so this holds
    // whether Redis is connected or the in-memory fallback is active.
    const dups = await Promise.all(Array.from({ length: 40 }, (_, index) => insertGym({ name: `Twin ${index}` })));

    let code: string | undefined;
    for (const dup of dups) {
      try {
        await reportGymDuplicate({ gymUuid: gym.uuid, duplicateGymUuid: dup.uuid }, ctx);
      } catch (error) {
        code = (error as { extensions?: { code?: string } }).extensions?.code;
        if (code === 'RATE_LIMITED') break;
      }
    }
    expect(code).toBe('RATE_LIMITED');
  });
});
