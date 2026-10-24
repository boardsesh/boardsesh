import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKER_STALL_CHECK_MS, WORKER_STALL_EXIT_MS, watchJobQueueStall } from '../stall-watchdog';

// The production limits, run on fake time: 10 minutes of silence, checked every 30 s.
describe('job queue stall watchdog (#6683)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exits once every round trip has failed for 10 minutes, and only once', async () => {
    const roundTrip = vi.fn(() => Promise.reject(new Error('timeout exceeded when trying to connect')));
    const onStalled = vi.fn();
    watchJobQueueStall({ roundTrip, isStopping: () => false, onStalled });

    await vi.advanceTimersByTimeAsync(WORKER_STALL_EXIT_MS - 1);
    expect(onStalled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onStalled).toHaveBeenCalledTimes(1);
    expect(onStalled).toHaveBeenCalledWith(WORKER_STALL_EXIT_MS);

    await vi.advanceTimersByTimeAsync(WORKER_STALL_EXIT_MS * 3);
    expect(onStalled).toHaveBeenCalledTimes(1);
  });

  it('exits when a round trip never settles, which is what a dead socket does without a read deadline', async () => {
    const roundTrip = vi.fn(() => new Promise<never>(() => {}));
    const onStalled = vi.fn();
    watchJobQueueStall({ roundTrip, isStopping: () => false, onStalled });

    await vi.advanceTimersByTimeAsync(WORKER_STALL_EXIT_MS);
    expect(onStalled).toHaveBeenCalledTimes(1);
    // One hung round trip, never a pile of them behind it.
    expect(roundTrip).toHaveBeenCalledTimes(1);
  });

  it('never trips while the job queue keeps answering, however long a job runs', async () => {
    const roundTrip = vi.fn(() => Promise.resolve());
    const onStalled = vi.fn();
    watchJobQueueStall({ roundTrip, isStopping: () => false, onStalled });

    // A 24 h batch job: it never touches this pool, so the round trips keep landing.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(onStalled).not.toHaveBeenCalled();
    expect(roundTrip).toHaveBeenCalledTimes((24 * 60 * 60_000) / WORKER_STALL_CHECK_MS);
  });

  it('counts the 10 minutes from the last success, so a blip does not add up', async () => {
    let answering = false;
    const roundTrip = vi.fn(() => (answering ? Promise.resolve() : Promise.reject(new Error('blip'))));
    const onStalled = vi.fn();
    watchJobQueueStall({ roundTrip, isStopping: () => false, onStalled });

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    answering = true;
    await vi.advanceTimersByTimeAsync(WORKER_STALL_CHECK_MS);
    answering = false;
    await vi.advanceTimersByTimeAsync(WORKER_STALL_EXIT_MS - 1);
    expect(onStalled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onStalled).toHaveBeenCalledTimes(1);
  });

  it('stays out of the way of a shutdown already under way', async () => {
    const roundTrip = vi.fn(() => Promise.reject(new Error('closing')));
    const onStalled = vi.fn();
    watchJobQueueStall({ roundTrip, isStopping: () => true, onStalled });

    await vi.advanceTimersByTimeAsync(WORKER_STALL_EXIT_MS * 2);
    expect(onStalled).not.toHaveBeenCalled();
    expect(roundTrip).not.toHaveBeenCalled();
  });

  it('stops for good when disposed', async () => {
    const roundTrip = vi.fn(() => Promise.reject(new Error('down')));
    const onStalled = vi.fn();
    const dispose = watchJobQueueStall({ roundTrip, isStopping: () => false, onStalled });

    await vi.advanceTimersByTimeAsync(WORKER_STALL_CHECK_MS);
    dispose();
    await vi.advanceTimersByTimeAsync(WORKER_STALL_EXIT_MS * 2);
    expect(onStalled).not.toHaveBeenCalled();
    expect(roundTrip).toHaveBeenCalledTimes(1);
  });
});
