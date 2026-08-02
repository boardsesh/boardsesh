import { beforeEach, describe, expect, it, vi } from 'vitest';

const runnerHarness = vi.hoisted(() => ({
  database: { kind: 'test-database' },
  createDb: vi.fn(),
  closePool: vi.fn(),
  acquireOrRenewDaemonLease: vi.fn(),
  releaseDaemonLease: vi.fn(),
  syncMoonBoardLocations: vi.fn(),
}));

vi.mock('@boardsesh/db/client', () => ({
  createDb: runnerHarness.createDb,
  closePool: runnerHarness.closePool,
}));

vi.mock('@boardsesh/db/queries', () => ({
  MOONBOARD_SYNC_DAEMON: 'moonboard-sync',
  acquireOrRenewDaemonLease: runnerHarness.acquireOrRenewDaemonLease,
  releaseDaemonLease: runnerHarness.releaseDaemonLease,
}));

vi.mock('../sync/locations-sync', () => ({
  syncMoonBoardLocations: runnerHarness.syncMoonBoardLocations,
}));

import { DEFAULT_MOONBOARD_DAEMON_OPTIONS, MoonBoardSyncRunner } from './sync-runner';

const EMPTY_SUMMARY = {
  boardsSeen: 0,
  boardsUpserted: 0,
  boardsSkipped: 0,
  gymsSeen: 0,
  gymsUpserted: 0,
  skipped: [],
};

function abortError(): Error {
  const error = new Error('daemon stopped');
  error.name = 'AbortError';
  return error;
}

function createDeferred<DeferredResult>() {
  let resolvePromise!: (result: DeferredResult | PromiseLike<DeferredResult>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<DeferredResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

describe('MoonBoardSyncRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runnerHarness.createDb.mockReturnValue(runnerHarness.database);
    runnerHarness.closePool.mockResolvedValue(undefined);
    runnerHarness.acquireOrRenewDaemonLease.mockResolvedValue(true);
    runnerHarness.releaseDaemonLease.mockResolvedValue(undefined);
    runnerHarness.syncMoonBoardLocations.mockResolvedValue(EMPTY_SUMMARY);
  });

  it('stops a fresh runner without initializing sync resources', async () => {
    const runner = new MoonBoardSyncRunner({
      username: 'sync@example.com',
      password: 'secret',
    });

    await expect(runner.stop()).resolves.toBeUndefined();

    expect(runnerHarness.createDb).not.toHaveBeenCalled();
    expect(runnerHarness.acquireOrRenewDaemonLease).not.toHaveBeenCalled();
    expect(runnerHarness.releaseDaemonLease).not.toHaveBeenCalled();
    expect(runnerHarness.syncMoonBoardLocations).not.toHaveBeenCalled();
    expect(runnerHarness.closePool).not.toHaveBeenCalled();
  });

  it('runs the existing location sync with configured credentials and database', async () => {
    const logs: string[] = [];
    const runner = new MoonBoardSyncRunner({
      username: 'sync@example.com',
      password: 'secret',
      onLog: (message) => logs.push(message),
    });

    await expect(runner.syncLocations()).resolves.toEqual(EMPTY_SUMMARY);

    expect(runnerHarness.syncMoonBoardLocations).toHaveBeenCalledWith({
      db: runnerHarness.database,
      username: 'sync@example.com',
      password: 'secret',
      log: expect.any(Function),
    });
    const syncOptions = runnerHarness.syncMoonBoardLocations.mock.calls[0]?.[0] as
      | { log: (message: string) => void }
      | undefined;
    expect(syncOptions).toBeDefined();
    syncOptions?.log('location detail');
    expect(logs).toContain('location detail');

    await runner.stop();
    expect(runnerHarness.closePool).toHaveBeenCalledOnce();
  });

  it('keeps detailed location logging behind the CLI verbose callback', async () => {
    const runner = new MoonBoardSyncRunner({
      username: 'sync@example.com',
      password: 'secret',
    });

    await runner.syncLocations();

    expect(runnerHarness.syncMoonBoardLocations).toHaveBeenCalledWith(expect.objectContaining({ log: undefined }));
    await runner.stop();
  });

  it('closes Postgres when lease cleanup rejects', async () => {
    const leaseError = new Error('lease cleanup failed');
    const leaseStop = vi.fn().mockRejectedValue(leaseError);
    const runner = new MoonBoardSyncRunner({
      username: 'sync@example.com',
      password: 'secret',
    });
    const runnerInternals = runner as unknown as {
      lease: { stop: () => Promise<void> } | null;
    };

    await runner.syncLocations();
    runnerInternals.lease = { stop: leaseStop };

    await expect(runner.stop()).rejects.toBe(leaseError);
    expect(leaseStop).toHaveBeenCalledOnce();
    expect(runnerHarness.closePool).toHaveBeenCalledOnce();
  });

  it('takes the MoonBoard daemon lease, runs immediately, and waits six to eight hours', async () => {
    const logs: string[] = [];
    const runner = new MoonBoardSyncRunner({
      username: 'sync@example.com',
      password: 'secret',
      onLog: (message) => logs.push(message),
    });
    const sleep = vi.fn(async (_milliseconds: number, signal?: AbortSignal) => {
      runner.requestStop();
      expect(signal?.aborted).toBe(true);
      throw abortError();
    });

    await runner.runDaemon(
      {},
      {
        now: () => new Date('2026-06-01T09:00:00.000Z'),
        random: () => 0,
        sleep,
      },
    );

    expect(runnerHarness.acquireOrRenewDaemonLease).toHaveBeenCalledWith(
      runnerHarness.database,
      expect.objectContaining({ daemonName: 'moonboard-sync', holderId: expect.any(String) }),
    );
    expect(runnerHarness.syncMoonBoardLocations).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(6 * 60 * 60_000, expect.any(AbortSignal));
    expect(runnerHarness.releaseDaemonLease).toHaveBeenCalledOnce();
    expect(logs).toContain('[SyncRunner] Waiting 360 minute(s) before the next daemon sync cycle');
    await runner.stop();
  });

  it('logs a failed cycle and stays alive for a later retry', async () => {
    const cycleError = new Error('MoonBoard is temporarily unavailable');
    const errors: Error[] = [];
    const logs: string[] = [];
    runnerHarness.syncMoonBoardLocations.mockRejectedValueOnce(cycleError);
    const runner = new MoonBoardSyncRunner({
      username: 'sync@example.com',
      password: 'secret',
      onError: (error) => errors.push(error),
      onLog: (message) => logs.push(message),
    });
    const sleep = vi.fn(async () => {
      runner.requestStop();
      throw abortError();
    });

    await runner.runDaemon(
      {},
      {
        now: () => new Date('2026-06-01T09:00:00.000Z'),
        random: () => 0,
        sleep,
      },
    );

    expect(errors).toEqual([cycleError]);
    expect(logs).toContain('[MoonBoardSyncRunner] Daemon cycle error: MoonBoard is temporarily unavailable');
    expect(sleep).toHaveBeenCalledOnce();
    await runner.stop();
  });

  it('waits for an active location write before releasing the lease and closing Postgres', async () => {
    const lifecycleEvents: string[] = [];
    const activeSync = createDeferred<typeof EMPTY_SUMMARY>();
    runnerHarness.syncMoonBoardLocations.mockImplementationOnce(async () => {
      lifecycleEvents.push('sync-started');
      const summary = await activeSync.promise;
      lifecycleEvents.push('sync-finished');
      return summary;
    });
    runnerHarness.releaseDaemonLease.mockImplementationOnce(async () => {
      lifecycleEvents.push('lease-released');
    });
    runnerHarness.closePool.mockImplementationOnce(async () => {
      lifecycleEvents.push('pool-closed');
    });
    const runner = new MoonBoardSyncRunner({
      username: 'sync@example.com',
      password: 'secret',
    });

    const daemonCompletion = runner.runDaemon({}, { now: () => new Date('2026-06-01T09:00:00.000Z') });
    await vi.waitFor(() => expect(runnerHarness.syncMoonBoardLocations).toHaveBeenCalledOnce());

    const stopCompletion = runner.stop();
    await Promise.resolve();

    expect(lifecycleEvents).toEqual(['sync-started']);
    expect(runnerHarness.releaseDaemonLease).not.toHaveBeenCalled();
    expect(runnerHarness.closePool).not.toHaveBeenCalled();

    activeSync.resolve(EMPTY_SUMMARY);

    await expect(stopCompletion).resolves.toBeUndefined();
    await expect(daemonCompletion).resolves.toBeUndefined();
    expect(lifecycleEvents).toEqual(['sync-started', 'sync-finished', 'lease-released', 'pool-closed']);
    expect(runnerHarness.releaseDaemonLease).toHaveBeenCalledOnce();
    expect(runnerHarness.closePool).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight heartbeat cleanup before closing Postgres', async () => {
    vi.useFakeTimers();
    const lifecycleEvents: string[] = [];
    const activeSync = createDeferred<typeof EMPTY_SUMMARY>();
    const syncStarted = createDeferred<void>();
    const heartbeatRenewal = createDeferred<boolean>();
    const heartbeatStarted = createDeferred<void>();
    const firstReleaseStarted = createDeferred<void>();
    runnerHarness.syncMoonBoardLocations.mockImplementationOnce(async () => {
      lifecycleEvents.push('sync-started');
      syncStarted.resolve();
      const summary = await activeSync.promise;
      lifecycleEvents.push('sync-finished');
      return summary;
    });
    runnerHarness.acquireOrRenewDaemonLease.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
      lifecycleEvents.push('heartbeat-started');
      heartbeatStarted.resolve();
      const stillHeld = await heartbeatRenewal.promise;
      lifecycleEvents.push('heartbeat-finished');
      return stillHeld;
    });
    runnerHarness.releaseDaemonLease.mockImplementation(async () => {
      lifecycleEvents.push(`lease-release-${runnerHarness.releaseDaemonLease.mock.calls.length}`);
      if (runnerHarness.releaseDaemonLease.mock.calls.length === 1) {
        firstReleaseStarted.resolve();
      }
    });
    runnerHarness.closePool.mockImplementationOnce(async () => {
      lifecycleEvents.push('pool-closed');
    });
    const runner = new MoonBoardSyncRunner({
      username: 'sync@example.com',
      password: 'secret',
    });
    let daemonCompletion: Promise<void> | undefined;
    let stopCompletion: Promise<void> | undefined;

    try {
      daemonCompletion = runner.runDaemon({}, { now: () => new Date('2026-06-01T09:00:00.000Z') });
      await syncStarted.promise;
      await vi.advanceTimersByTimeAsync(30_000);
      await heartbeatStarted.promise;

      stopCompletion = runner.stop();
      activeSync.resolve(EMPTY_SUMMARY);
      await firstReleaseStarted.promise;
      await Promise.resolve();

      expect(runnerHarness.closePool).not.toHaveBeenCalled();
      expect(lifecycleEvents).toEqual(['sync-started', 'heartbeat-started', 'sync-finished', 'lease-release-1']);

      heartbeatRenewal.resolve(true);
      await expect(stopCompletion).resolves.toBeUndefined();
      await expect(daemonCompletion).resolves.toBeUndefined();
      expect(lifecycleEvents).toEqual([
        'sync-started',
        'heartbeat-started',
        'sync-finished',
        'lease-release-1',
        'heartbeat-finished',
        'lease-release-2',
        'pool-closed',
      ]);
    } finally {
      activeSync.resolve(EMPTY_SUMMARY);
      heartbeatRenewal.resolve(true);
      await stopCompletion?.catch(() => {});
      await daemonCompletion?.catch(() => {});
      vi.useRealTimers();
    }
  });

  it('does not start a location write when shutdown arrives during lease acquisition', async () => {
    const leaseAcquisition = createDeferred<boolean>();
    runnerHarness.acquireOrRenewDaemonLease.mockReturnValueOnce(leaseAcquisition.promise);
    const runner = new MoonBoardSyncRunner({
      username: 'sync@example.com',
      password: 'secret',
    });

    const daemonCompletion = runner.runDaemon({}, { now: () => new Date('2026-06-01T09:00:00.000Z') });
    await vi.waitFor(() => expect(runnerHarness.acquireOrRenewDaemonLease).toHaveBeenCalledOnce());

    runner.requestStop();
    leaseAcquisition.resolve(true);

    await expect(daemonCompletion).resolves.toBeUndefined();
    expect(runnerHarness.syncMoonBoardLocations).not.toHaveBeenCalled();
    expect(runnerHarness.releaseDaemonLease).toHaveBeenCalledOnce();
    await runner.stop();
  });

  it('rejects a concurrent daemon run without replacing the active controller', async () => {
    const activeSync = createDeferred<typeof EMPTY_SUMMARY>();
    runnerHarness.syncMoonBoardLocations.mockReturnValueOnce(activeSync.promise);
    const runner = new MoonBoardSyncRunner({
      username: 'sync@example.com',
      password: 'secret',
    });

    const firstDaemonCompletion = runner.runDaemon({}, { now: () => new Date('2026-06-01T09:00:00.000Z') });
    await vi.waitFor(() => expect(runnerHarness.syncMoonBoardLocations).toHaveBeenCalledOnce());

    await expect(runner.runDaemon()).rejects.toThrow('MoonBoard daemon mode is already running');
    expect(runnerHarness.acquireOrRenewDaemonLease).toHaveBeenCalledOnce();

    runner.requestStop();
    activeSync.resolve(EMPTY_SUMMARY);

    await expect(firstDaemonCompletion).resolves.toBeUndefined();
    expect(runnerHarness.releaseDaemonLease).toHaveBeenCalledOnce();
    await runner.stop();
  });

  it('uses a jittered six-to-eight-hour recurring cadence by default', () => {
    expect(DEFAULT_MOONBOARD_DAEMON_OPTIONS).toEqual({
      minDelayMinutes: 360,
      maxDelayMinutes: 480,
    });
  });
});
