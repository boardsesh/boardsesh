import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PoolInstance } from '@boardsesh/db/client';
import { logger } from '../../utils/logger';
import {
  AdmissionReadStalledError,
  AUTH_ADMISSION_READ_WATCHDOG_MS,
  AUTH_ADMISSION_RECYCLE_BACKOFF_MS,
  closeAdmissionPool,
  readOnAdmissionConnection,
} from '../admission-pool';

type FakePool = {
  options: { parsers: Record<string, unknown>; serializers: Record<string, unknown> };
  end: ReturnType<typeof vi.fn>;
};

// The timing decisions, with a fake clock. The hang itself runs against real
// Postgres in admission-pool.test.ts.
const { fakePools } = vi.hoisted(() => ({ fakePools: [] as FakePool[] }));

vi.mock('@boardsesh/db/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/db/client')>()),
  createDedicatedPool: () => {
    const fakePool = { options: { parsers: {}, serializers: {} }, end: vi.fn(async () => undefined) };
    fakePools.push(fakePool);
    return fakePool as unknown as PoolInstance;
  },
}));

let clock = 0;

async function advance(milliseconds: number) {
  clock += milliseconds;
  await vi.advanceTimersByTimeAsync(milliseconds);
}

function neverAnswers() {
  return new Promise<never>(() => {});
}

function hangOneRead() {
  const outcome = readOnAdmissionConnection(() => {}, neverAnswers).catch((error: unknown) => error);
  return outcome;
}

describe('admission read watchdog', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clock = 0;
    fakePools.length = 0;
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(async () => {
    await closeAdmissionPool();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('fails a read with no answer at the watchdog and frees its connection', async () => {
    const outcome = hangOneRead();
    const secondOutcome = hangOneRead();
    await Promise.resolve();

    const started: string[] = [];
    const queued = readOnAdmissionConnection(
      () => started.push('queued'),
      async () => 'answered',
    );
    await advance(AUTH_ADMISSION_READ_WATCHDOG_MS - 1);
    expect(started).toEqual([]);

    await advance(1);
    await expect(outcome).resolves.toBeInstanceOf(AdmissionReadStalledError);
    await expect(outcome).resolves.toMatchObject({ code: 'ADMISSION_READ_STALLED' });
    await expect(secondOutcome).resolves.toBeInstanceOf(AdmissionReadStalledError);
    await expect(queued).resolves.toBe('answered');
    expect(started).toEqual(['queued']);
  });

  it('severs the stalled pool and opens a new one for the next read', async () => {
    const outcome = hangOneRead();
    await Promise.resolve();
    await advance(AUTH_ADMISSION_READ_WATCHDOG_MS);
    await outcome;
    expect(fakePools).toHaveLength(1);
    expect(fakePools[0].end).toHaveBeenCalledOnce();
    expect(fakePools[0].end).toHaveBeenCalledWith({ timeout: 0 });

    await readOnAdmissionConnection(
      () => {},
      async () => undefined,
    );
    expect(fakePools).toHaveLength(2);
  });

  it('leaves the pool alone when the read answers in time', async () => {
    await readOnAdmissionConnection(
      () => {},
      async () => undefined,
    );
    await advance(AUTH_ADMISSION_READ_WATCHDOG_MS * 2);
    expect(fakePools[0].end).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a pool that answered another read after the stalled one began', async () => {
    const stalledOutcome = hangOneRead();
    await Promise.resolve();
    await advance(500);
    await readOnAdmissionConnection(
      () => {},
      async () => 'answered',
    );

    await advance(AUTH_ADMISSION_READ_WATCHDOG_MS - 500);
    await expect(stalledOutcome).resolves.toBeInstanceOf(AdmissionReadStalledError);
    expect(fakePools[0].end).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('still replaces it when the only answer came before the stalled read began', async () => {
    await readOnAdmissionConnection(
      () => {},
      async () => 'answered',
    );
    await advance(100);
    const stalledOutcome = hangOneRead();
    await Promise.resolve();
    await advance(AUTH_ADMISSION_READ_WATCHDOG_MS);
    await stalledOutcome;
    expect(fakePools[0].end).toHaveBeenCalledOnce();
  });

  it('replaces the pool once when both of its reads stall together', async () => {
    const outcomes = [hangOneRead(), hangOneRead()];
    await Promise.resolve();
    await advance(AUTH_ADMISSION_READ_WATCHDOG_MS);
    await Promise.all(outcomes);

    expect(fakePools[0].end).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  /** One hung read after another until `untilMs`; returns when the pool was replaced. */
  async function replacementTimesWhileEveryReadHangs(untilMs: number) {
    const replacedAt: number[] = [];
    while (clock < untilMs) {
      const replacementsBefore = warn.mock.calls.length;
      const outcome = hangOneRead();
      await Promise.resolve();
      await advance(AUTH_ADMISSION_READ_WATCHDOG_MS);
      await expect(outcome).resolves.toBeInstanceOf(AdmissionReadStalledError);
      if (warn.mock.calls.length > replacementsBefore) replacedAt.push(clock);
    }
    return replacedAt;
  }

  it('backs off replacements to 5, 10, 20 and then 60 s while no read answers', async () => {
    expect(AUTH_ADMISSION_RECYCLE_BACKOFF_MS).toEqual([5000, 10_000, 20_000, 60_000]);
    const replacedAt = await replacementTimesWhileEveryReadHangs(160_000);

    // Reads expire every 2 s, so each replacement lands on the first expiry past its gap.
    expect(replacedAt).toEqual([2000, 8000, 18_000, 38_000, 98_000, 158_000]);
    // A minute of hanging replaces the pool four times, where a fixed 5 s gap allowed ten.
    expect(replacedAt.filter((replacedAtMs) => replacedAtMs <= 60_000)).toHaveLength(4);
  });

  it('starts the schedule again at 5 s once a read answers', async () => {
    expect(await replacementTimesWhileEveryReadHangs(40_000)).toEqual([2000, 8000, 18_000, 38_000]);

    await expect(
      readOnAdmissionConnection(
        () => {},
        async () => 'answered',
      ),
    ).resolves.toBe('answered');

    // Without the answer the next gap would be 60 s, at 98 s.
    expect((await replacementTimesWhileEveryReadHangs(50_000))[0]).toBe(44_000);
  });

  it('logs each replacement once, with no identifying detail', async () => {
    const outcome = hangOneRead();
    await Promise.resolve();
    await advance(AUTH_ADMISSION_READ_WATCHDOG_MS);
    await outcome;
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('[auth-admission] replaced the pool after a read stopped answering', {
      watchdogMs: AUTH_ADMISSION_READ_WATCHDOG_MS,
      replacementsSinceAnswer: 1,
    });
  });

  it('does not touch a pool that shutdown has already closed', async () => {
    const outcome = hangOneRead();
    await Promise.resolve();
    await closeAdmissionPool();
    expect(fakePools[0].end).toHaveBeenCalledOnce();

    await advance(AUTH_ADMISSION_READ_WATCHDOG_MS);
    await outcome;
    expect(fakePools[0].end).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });
});
