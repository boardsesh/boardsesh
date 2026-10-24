import type { PgBoss } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../utils/logger';
import {
  WORKER_STALL_CHECK_MS,
  WORKER_STALL_EXIT_MS,
  watchJobQueueStall,
  watchWorkerJobQueue,
} from '../stall-watchdog';

vi.mock('../../utils/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const noJob = () => undefined;
const failing = () => vi.fn(() => Promise.reject(new Error('timeout exceeded when trying to connect')));
const answering = () => vi.fn(() => Promise.resolve());

// The production limits, run on fake time: 10 minutes of silence, checked every 30 s.
describe('job queue stall watchdog (#6683)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date', 'performance'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('exits once every round trip has failed for 10 minutes, only once, and leaves no timer behind', async () => {
    const onStalled = vi.fn();
    watchJobQueueStall({ roundTrip: failing(), isStopping: () => false, jobLeaseEndsAt: noJob, onStalled });

    await vi.advanceTimersByTimeAsync(WORKER_STALL_EXIT_MS - 1);
    expect(onStalled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onStalled).toHaveBeenCalledTimes(1);
    expect(onStalled).toHaveBeenCalledWith({ reason: 'job-queue-silent', silentMs: WORKER_STALL_EXIT_MS });
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(WORKER_STALL_EXIT_MS * 3);
    expect(onStalled).toHaveBeenCalledTimes(1);
  });

  it('exits when a round trip never settles, which is what a dead socket does without a read deadline', async () => {
    const roundTrip = vi.fn(() => new Promise<never>(() => {}));
    const onStalled = vi.fn();
    watchJobQueueStall({ roundTrip, isStopping: () => false, jobLeaseEndsAt: noJob, onStalled });

    await vi.advanceTimersByTimeAsync(WORKER_STALL_EXIT_MS);
    expect(onStalled).toHaveBeenCalledTimes(1);
    // One hung round trip, never a pile of them behind it.
    expect(roundTrip).toHaveBeenCalledTimes(1);
  });

  it('never trips while the job queue keeps answering and a long job is inside its lease', async () => {
    const roundTrip = answering();
    const onStalled = vi.fn();
    // A 24 h batch job with a 25 h lease: it never touches the pg-boss pool, so the round trips keep landing.
    const leaseEndsAt = performance.now() + 25 * 60 * 60_000;
    watchJobQueueStall({ roundTrip, isStopping: () => false, jobLeaseEndsAt: () => leaseEndsAt, onStalled });

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(onStalled).not.toHaveBeenCalled();
    expect(roundTrip).toHaveBeenCalledTimes((24 * 60 * 60_000) / WORKER_STALL_CHECK_MS);
  });

  it('exits when the loop is still inside one job 10 minutes after its lease ended, even with the queue answering', async () => {
    // The #6683 wedge on the application pool: the job's query never returns, the pg-boss pool is fine.
    const onStalled = vi.fn();
    const leaseEndsAt = performance.now() + 5 * 60_000;
    watchJobQueueStall({
      roundTrip: answering(),
      isStopping: () => false,
      jobLeaseEndsAt: () => leaseEndsAt,
      onStalled,
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000 + WORKER_STALL_EXIT_MS - 1);
    expect(onStalled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onStalled).toHaveBeenCalledTimes(1);
    expect(onStalled).toHaveBeenCalledWith({ reason: 'job-past-lease', overdueMs: WORKER_STALL_EXIT_MS });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts the 10 minutes from the last success, so a blip does not add up', async () => {
    let up = false;
    const roundTrip = vi.fn(() => (up ? Promise.resolve() : Promise.reject(new Error('blip'))));
    const onStalled = vi.fn();
    watchJobQueueStall({ roundTrip, isStopping: () => false, jobLeaseEndsAt: noJob, onStalled });

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    up = true;
    await vi.advanceTimersByTimeAsync(WORKER_STALL_CHECK_MS);
    up = false;
    await vi.advanceTimersByTimeAsync(WORKER_STALL_EXIT_MS - 1);
    expect(onStalled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onStalled).toHaveBeenCalledTimes(1);
  });

  it('does not count time the process was suspended, then still exits on real silence after it', async () => {
    // A VM backup in suspend mode or `docker pause`: the next check arrives 15 minutes late.
    let clock = 0;
    const onStalled = vi.fn();
    watchJobQueueStall({
      roundTrip: failing(),
      isStopping: () => false,
      jobLeaseEndsAt: noJob,
      onStalled,
      now: () => clock,
    });
    const check = async (elapsedMs: number) => {
      clock += elapsedMs;
      await vi.advanceTimersByTimeAsync(WORKER_STALL_CHECK_MS);
    };

    for (let i = 0; i < 10; i++) await check(WORKER_STALL_CHECK_MS);
    await check(15 * 60_000);
    expect(onStalled).not.toHaveBeenCalled();

    for (let i = 0; i < WORKER_STALL_EXIT_MS / WORKER_STALL_CHECK_MS - 1; i++) await check(WORKER_STALL_CHECK_MS);
    expect(onStalled).not.toHaveBeenCalled();
    await check(WORKER_STALL_CHECK_MS);
    expect(onStalled).toHaveBeenCalledWith({ reason: 'job-queue-silent', silentMs: WORKER_STALL_EXIT_MS });
  });

  it('runs on a monotonic clock, so a wall clock stepped back an hour does not delay the exit', async () => {
    const onStalled = vi.fn();
    watchJobQueueStall({ roundTrip: failing(), isStopping: () => false, jobLeaseEndsAt: noJob, onStalled });
    vi.setSystemTime(Date.now() - 60 * 60_000);

    await vi.advanceTimersByTimeAsync(WORKER_STALL_EXIT_MS);
    expect(onStalled).toHaveBeenCalledTimes(1);
  });

  it('stays out of the way of a shutdown already under way', async () => {
    const roundTrip = failing();
    const onStalled = vi.fn();
    watchJobQueueStall({ roundTrip, isStopping: () => true, jobLeaseEndsAt: () => 0, onStalled });

    await vi.advanceTimersByTimeAsync(WORKER_STALL_EXIT_MS * 2);
    expect(onStalled).not.toHaveBeenCalled();
    expect(roundTrip).not.toHaveBeenCalled();
  });

  it('stops for good when disposed and leaves no timer behind', async () => {
    const roundTrip = failing();
    const onStalled = vi.fn();
    const dispose = watchJobQueueStall({ roundTrip, isStopping: () => false, jobLeaseEndsAt: noJob, onStalled });

    await vi.advanceTimersByTimeAsync(WORKER_STALL_CHECK_MS);
    dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(WORKER_STALL_EXIT_MS * 2);
    expect(onStalled).not.toHaveBeenCalled();
    expect(roundTrip).toHaveBeenCalledTimes(1);
  });

  it('never keeps the process alive on its own', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const dispose = watchJobQueueStall({
      roundTrip: answering(),
      isStopping: () => false,
      jobLeaseEndsAt: noJob,
      onStalled: vi.fn(),
    });
    const handle = setIntervalSpy.mock.results[0]?.value as { hasRef(): boolean };
    expect(handle.hasRef()).toBe(false);
    dispose();
    setIntervalSpy.mockRestore();
  });
});

describe('the watchdog as the worker wires it', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date', 'performance'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("round-trips on the worker's own pg-boss pool and logs why it gives up", async () => {
    // The pool the round trip must use. A check on the application pool would miss #6683.
    const executeSql = vi.fn((_text: string) => Promise.resolve({ rows: [{ recovery: false, read_only: 'off' }] }));
    const boss = { getDb: () => ({ executeSql }) } as unknown as Pick<PgBoss, 'getDb'>;
    const onStalled = vi.fn();
    watchWorkerJobQueue({
      boss,
      role: 'interactive-import',
      isStopping: () => false,
      jobLeaseEndsAt: noJob,
      onStalled,
    });

    await vi.advanceTimersByTimeAsync(WORKER_STALL_CHECK_MS);
    expect(executeSql).toHaveBeenCalledTimes(1);
    expect(executeSql).toHaveBeenCalledWith(expect.stringContaining('pg_is_in_recovery()'));

    executeSql.mockImplementation(() => Promise.reject(new Error('timeout exceeded when trying to connect')));
    await vi.advanceTimersByTimeAsync(WORKER_STALL_EXIT_MS);
    expect(onStalled).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      '[worker] job queue unreachable, exiting so Docker restarts the worker',
      expect.objectContaining({ role: 'interactive-import' }),
    );
  });
});
