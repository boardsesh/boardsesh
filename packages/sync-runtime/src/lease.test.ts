import { describe, it, expect, vi } from 'vite-plus/test';

import { DaemonLease, DaemonLeaseLostError } from './lease';
import { runDaemonLoop } from './daemon';

// ---------------------------------------------------------------------------
// Daemon lease holder + loop standby (#3539)
//
// The lease is best effort: it stops the common case (a rolling deploy with two
// healthy containers both syncing) but it carries no fencing token, so a holder
// that stalls past the TTL loses the lease while still running. Two behaviours
// have to hold for that to be safe to ship:
//   1. the loser IDLES — a crash-looping loser during a deploy is worse than
//      the duplicate work the lease exists to prevent;
//   2. a holder that loses the lease MID-CYCLE stops at its next checkpoint
//      rather than running to completion alongside the new holder.
// ---------------------------------------------------------------------------

/** A never-quiet clock so the loop's quiet-hours branch is never taken. */
const NOISY_HOURS = { timeZone: 'UTC', quietHoursStart: 3, quietHoursEnd: 4 };
const noonUtc = () => new Date('2026-01-01T12:00:00Z');

/** Abort the loop after `cycles` sleeps so the test terminates. */
function abortAfterSleeps(controller: AbortController, sleeps: number) {
  let seen = 0;
  return async (_ms: number) => {
    if (++seen >= sleeps) controller.abort();
  };
}

describe('DaemonLease', () => {
  it('reports the lease as held once acquired, and starts a heartbeat', async () => {
    const acquireOrRenew = vi.fn().mockResolvedValue(true);
    const setIntervalSpy = vi.fn().mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
    const lease = new DaemonLease(
      'test-daemon',
      { acquireOrRenew, release: vi.fn().mockResolvedValue(undefined) },
      { setInterval: setIntervalSpy, clearInterval: vi.fn(), heartbeatMs: 1000 },
    );

    expect(await lease.acquire()).toBe(true);
    expect(lease.isHeld()).toBe(true);
    // The heartbeat runs on its own timer, not on the cycle cadence — a catalog
    // pull can outlast the TTL many times over.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(1000);
    expect(() => lease.assertStillHeld()).not.toThrow();
  });

  it('does not start a heartbeat when the lease was not acquired', async () => {
    const setIntervalSpy = vi.fn().mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
    const lease = new DaemonLease(
      'test-daemon',
      { acquireOrRenew: vi.fn().mockResolvedValue(false), release: vi.fn() },
      { setInterval: setIntervalSpy, clearInterval: vi.fn() },
    );

    expect(await lease.acquire()).toBe(false);
    expect(lease.isHeld()).toBe(false);
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('assertStillHeld throws once a heartbeat observes a takeover mid-cycle', async () => {
    let heartbeat: (() => void) | null = null;
    // First call takes the lease; the heartbeat then finds it gone (the stalled
    // holder case — another instance took over while we were still working).
    const acquireOrRenew = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const logged: string[] = [];
    const lease = new DaemonLease(
      'test-daemon',
      { acquireOrRenew, release: vi.fn().mockResolvedValue(undefined) },
      {
        setInterval: (handler) => {
          heartbeat = handler;
          return 0 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: vi.fn(),
        onLog: (message) => logged.push(message),
      },
    );

    await lease.acquire();
    expect(() => lease.assertStillHeld()).not.toThrow();

    heartbeat!();
    await vi.waitFor(() => expect(lease.isHeld()).toBe(false));

    expect(() => lease.assertStillHeld()).toThrow(DaemonLeaseLostError);
    expect(logged.join('\n')).toContain('Lost the test-daemon daemon lease');
  });

  it('a heartbeat error does not hand the lease away on its own', async () => {
    let heartbeat: (() => void) | null = null;
    const acquireOrRenew = vi.fn().mockResolvedValueOnce(true).mockRejectedValue(new Error('connection reset'));
    const onError = vi.fn();
    const lease = new DaemonLease(
      'test-daemon',
      { acquireOrRenew, release: vi.fn() },
      {
        setInterval: (handler) => {
          heartbeat = handler;
          return 0 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: vi.fn(),
        onError,
      },
    );

    await lease.acquire();
    heartbeat!();
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());

    // A transient DB blip must not stand the daemon down — only a real takeover
    // (or the TTL elapsing) does that.
    expect(lease.isHeld()).toBe(true);
    expect(() => lease.assertStillHeld()).not.toThrow();
  });

  it('stop releases exactly once and is safe to call again', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const lease = new DaemonLease(
      'test-daemon',
      { acquireOrRenew: vi.fn().mockResolvedValue(true), release },
      { setInterval: vi.fn().mockReturnValue(0 as unknown as ReturnType<typeof setInterval>), clearInterval: vi.fn() },
    );

    await lease.acquire();
    await lease.stop();
    // Both the daemon loop's finally and close()/stop() call this; a double
    // release would risk evicting the next holder's row.
    await lease.stop();

    expect(release).toHaveBeenCalledTimes(1);
    expect(lease.isHeld()).toBe(false);
  });

  it('a heartbeat that lands mid-shutdown does not resurrect the released row', async () => {
    // SIGTERM race: stop() deletes the row while a heartbeat upsert is already
    // in flight. If that upsert lands after the DELETE it re-creates the lease
    // under a dying process's holder id, and the incoming container waits out a
    // full TTL instead of the milliseconds the release exists to buy.
    let heartbeat: (() => void) | null = null;
    let resolveRenew: ((held: boolean) => void) | null = null;
    const release = vi.fn().mockResolvedValue(undefined);
    const acquireOrRenew = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveRenew = resolve;
          }),
      );

    const lease = new DaemonLease(
      'test-daemon',
      { acquireOrRenew, release },
      {
        setInterval: (handler) => {
          heartbeat = handler;
          return 0 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: vi.fn(),
      },
    );

    await lease.acquire();
    heartbeat!(); // renew now parked in flight
    let stopSettled = false;
    const stopCompletion = lease.stop().then(() => {
      stopSettled = true;
    });
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);
    expect(stopSettled).toBe(false);

    // The parked renew resolves as "we still hold it" — i.e. it re-created the
    // row after the DELETE. A compensating release must clear the zombie.
    resolveRenew!(true);
    await stopCompletion;
    expect(release).toHaveBeenCalledTimes(2);
    expect(stopSettled).toBe(true);
    expect(lease.isHeld()).toBe(false);
  });

  it('a heartbeat scheduled before stop() never fires a renew after it', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const acquireOrRenew = vi.fn().mockResolvedValue(true);
    let heartbeat: (() => void) | null = null;
    const lease = new DaemonLease(
      'test-daemon',
      { acquireOrRenew, release },
      {
        setInterval: (handler) => {
          heartbeat = handler;
          return 0 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: vi.fn(),
      },
    );

    await lease.acquire();
    await lease.stop();
    acquireOrRenew.mockClear();

    // A timer callback already queued when stop() ran must be a no-op.
    heartbeat!();
    await Promise.resolve();
    expect(acquireOrRenew).not.toHaveBeenCalled();
  });

  it('a failed release is reported, not thrown, so shutdown still completes', async () => {
    const onError = vi.fn();
    const lease = new DaemonLease(
      'test-daemon',
      { acquireOrRenew: vi.fn().mockResolvedValue(true), release: vi.fn().mockRejectedValue(new Error('pool closed')) },
      {
        setInterval: vi.fn().mockReturnValue(0 as unknown as ReturnType<typeof setInterval>),
        clearInterval: vi.fn(),
        onError,
      },
    );

    await lease.acquire();
    await expect(lease.stop()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });
});

describe('runDaemonLoop standby', () => {
  it('the loser runs no cycles and keeps polling instead of crashing', async () => {
    const controller = new AbortController();
    const runCycle = vi.fn().mockResolvedValue(undefined);
    const sleeps: number[] = [];
    const logged: string[] = [];

    await runDaemonLoop(
      runCycle,
      { ...NOISY_HOURS, standbyPollMs: 5000 },
      {
        now: noonUtc,
        signal: controller.signal,
        acquireSlot: async () => false,
        onLog: (message) => logged.push(message),
        sleep: async (ms) => {
          sleeps.push(ms);
          if (sleeps.length >= 3) controller.abort();
        },
      },
    );

    expect(runCycle).not.toHaveBeenCalled();
    // Short standby poll, not the 1-15 minute working delay: when the active
    // instance goes away the standby one should take over in seconds.
    expect(sleeps).toEqual([5000, 5000, 5000]);
    // One transition line, not one per poll.
    expect(logged.filter((line) => line.includes('standing by'))).toHaveLength(1);
  });

  it('a throwing slot gate fails CLOSED and keeps the loop alive', async () => {
    const controller = new AbortController();
    const runCycle = vi.fn().mockResolvedValue(undefined);
    const onCycleError = vi.fn();

    await runDaemonLoop(
      runCycle,
      { ...NOISY_HOURS, standbyPollMs: 1000 },
      {
        now: noonUtc,
        signal: controller.signal,
        acquireSlot: async () => {
          throw new Error('database unreachable');
        },
        onCycleError,
        sleep: abortAfterSleeps(controller, 2),
      },
    );

    // A daemon that can't reach Postgres can't sync anyway, so standing by
    // costs nothing — and running unguarded would resurrect the bug.
    expect(runCycle).not.toHaveBeenCalled();
    expect(onCycleError).toHaveBeenCalled();
  });

  it('the winner runs its cycle and uses the normal jittered delay', async () => {
    const controller = new AbortController();
    const runCycle = vi.fn().mockResolvedValue(undefined);
    const sleeps: number[] = [];

    await runDaemonLoop(
      runCycle,
      { ...NOISY_HOURS, minDelayMinutes: 7, maxDelayMinutes: 7, standbyPollMs: 1000 },
      {
        now: noonUtc,
        signal: controller.signal,
        acquireSlot: async () => true,
        sleep: async (ms) => {
          sleeps.push(ms);
          controller.abort();
        },
      },
    );

    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([7 * 60_000]);
  });

  it('logs the takeover when standby ends', async () => {
    const controller = new AbortController();
    const logged: string[] = [];
    let holdsLease = false;

    await runDaemonLoop(
      vi.fn().mockResolvedValue(undefined),
      { ...NOISY_HOURS, standbyPollMs: 1000 },
      {
        now: noonUtc,
        signal: controller.signal,
        // Standby for two polls, then the other instance goes away.
        acquireSlot: async () => holdsLease,
        onLog: (message) => logged.push(message),
        sleep: async () => {
          holdsLease = true;
          if (logged.some((line) => line.includes('Took over'))) controller.abort();
        },
      },
    );

    expect(logged.some((line) => line.includes('standing by'))).toBe(true);
    expect(logged.some((line) => line.includes('Took over the daemon lease'))).toBe(true);
  });

  it('a cycle that loses the lease mid-flight is reported and drops into standby', async () => {
    const controller = new AbortController();
    const onCycleError = vi.fn();
    const cycles: number[] = [];
    let holdsLease = true;

    await runDaemonLoop(
      async () => {
        cycles.push(Date.now());
        // Model the checkpoint: the heartbeat saw a takeover while we worked.
        holdsLease = false;
        throw new DaemonLeaseLostError('test-daemon');
      },
      { ...NOISY_HOURS, standbyPollMs: 1000 },
      {
        now: noonUtc,
        signal: controller.signal,
        acquireSlot: async () => holdsLease,
        onCycleError,
        sleep: abortAfterSleeps(controller, 2),
      },
    );

    // Exactly one cycle ran; the loop then stood by rather than starting
    // another one alongside the instance that took over.
    expect(cycles).toHaveLength(1);
    expect(onCycleError).toHaveBeenCalledTimes(1);
    expect(onCycleError.mock.calls[0][0]).toBeInstanceOf(DaemonLeaseLostError);
  });
});
