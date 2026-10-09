import { describe, it, expect, vi } from 'vitest';
import { createOtaOperationOwner } from '../ota-operation-owner';
import { performOtaRecovery, type OtaRecoveryDeps } from '../ota-recovery';

function makeDeps(overrides: Partial<OtaRecoveryDeps> = {}): OtaRecoveryDeps {
  return {
    runOperation: createOtaOperationOwner().run,
    captureReloadReceipt: vi.fn().mockReturnValue('downloaded-update'),
    isReloadReceiptCurrent: vi.fn().mockReturnValue(true),
    checkForUpdate: vi.fn().mockResolvedValue({ isAvailable: true, isRollBackToEmbedded: false }),
    fetchUpdate: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('performOtaRecovery', () => {
  it('update available: fetches, reloads, tracks the outcome BEFORE reload → reloaded-update', async () => {
    const deps = makeDeps();
    const onBeforeReload = vi.fn();
    const { result } = await performOtaRecovery(deps, { onBeforeReload });

    expect(result).toBe('reloaded-update');
    expect(deps.fetchUpdate).toHaveBeenCalledOnce();
    expect(deps.reload).toHaveBeenCalledOnce();
    expect(onBeforeReload).toHaveBeenCalledWith('reloaded-update');
    // The outcome must be emitted before the reload is initiated, or the restart
    // can tear the app down before the event is delivered.
    const reloadMock = deps.reload as ReturnType<typeof vi.fn>;
    expect(onBeforeReload.mock.invocationCallOrder[0]).toBeLessThan(reloadMock.mock.invocationCallOrder[0]);
  });

  it('reports phases in order: checking then downloading', async () => {
    const deps = makeDeps();
    const onPhase = vi.fn();
    await performOtaRecovery(deps, { onPhase });

    expect(onPhase.mock.calls.map((call) => call[0])).toEqual(['checking', 'downloading']);
  });

  it('rollback directive (no newer update): fetches, reloads → reloaded-rollback', async () => {
    const deps = makeDeps({
      checkForUpdate: vi.fn().mockResolvedValue({ isAvailable: false, isRollBackToEmbedded: true }),
    });
    const onBeforeReload = vi.fn();
    const { result } = await performOtaRecovery(deps, { onBeforeReload });

    expect(result).toBe('reloaded-rollback');
    expect(deps.fetchUpdate).toHaveBeenCalledOnce();
    expect(deps.reload).toHaveBeenCalledOnce();
    expect(onBeforeReload).toHaveBeenCalledWith('reloaded-rollback');
  });

  it('both a newer update and a rollback directive: the newer bundle wins → reloaded-update', async () => {
    const deps = makeDeps({
      checkForUpdate: vi.fn().mockResolvedValue({ isAvailable: true, isRollBackToEmbedded: true }),
    });
    const onBeforeReload = vi.fn();
    const { result } = await performOtaRecovery(deps, { onBeforeReload });

    expect(result).toBe('reloaded-update');
    expect(deps.fetchUpdate).toHaveBeenCalledOnce();
    expect(deps.reload).toHaveBeenCalledOnce();
    expect(onBeforeReload).toHaveBeenCalledWith('reloaded-update');
  });

  it('nothing on the server but an update is pending: reloads WITHOUT fetching → reloaded-pending', async () => {
    const deps = makeDeps({
      checkForUpdate: vi.fn().mockResolvedValue({ isAvailable: false, isRollBackToEmbedded: false }),
      captureReloadReceipt: vi.fn().mockReturnValue('pending-update'),
    });
    const onBeforeReload = vi.fn();
    const { result } = await performOtaRecovery(deps, { onBeforeReload });

    expect(result).toBe('reloaded-pending');
    expect(deps.fetchUpdate).not.toHaveBeenCalled();
    expect(deps.reload).toHaveBeenCalledOnce();
    expect(onBeforeReload).toHaveBeenCalledWith('reloaded-pending');
  });

  it('nothing new and nothing pending: does NOT reload → no-fix-available', async () => {
    const deps = makeDeps({
      captureReloadReceipt: vi.fn().mockReturnValue(null),
      checkForUpdate: vi.fn().mockResolvedValue({ isAvailable: false, isRollBackToEmbedded: false }),
    });
    const { result } = await performOtaRecovery(deps);

    expect(result).toBe('no-fix-available');
    expect(deps.fetchUpdate).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('checkForUpdate rejects: captures the error, never reloads → failed', async () => {
    const checkError = new Error('offline');
    const deps = makeDeps({ checkForUpdate: vi.fn().mockRejectedValue(checkError) });
    const { result, error } = await performOtaRecovery(deps);

    expect(result).toBe('failed');
    expect(error).toBe(checkError);
    expect(deps.fetchUpdate).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('fetch rejects after the check found an update: captures the error, never reloads → failed', async () => {
    const fetchError = new Error('download interrupted');
    const deps = makeDeps({ fetchUpdate: vi.fn().mockRejectedValue(fetchError) });
    const onBeforeReload = vi.fn();
    const { result, error } = await performOtaRecovery(deps, { onBeforeReload });

    expect(result).toBe('failed');
    expect(error).toBe(fetchError);
    expect(deps.fetchUpdate).toHaveBeenCalledOnce();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(onBeforeReload).not.toHaveBeenCalled();
  });

  it('reload rejects: the machine catches it rather than leaking → failed', async () => {
    const reloadError = new Error('reload blew up');
    const deps = makeDeps({ reload: vi.fn().mockRejectedValue(reloadError) });
    const { result, error } = await performOtaRecovery(deps);

    expect(result).toBe('failed');
    expect(error).toBe(reloadError);
    expect(deps.reload).toHaveBeenCalledOnce();
  });

  it('fetch hangs past the timeout: resolves failed, never reloads', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({
        // Never resolves — stands in for a stalled download.
        fetchUpdate: vi.fn().mockReturnValue(new Promise(() => {})),
      });
      const recovery = performOtaRecovery(deps, { timeoutMs: 10 });
      // Advance past the timeout; advanceTimersByTimeAsync settles the pending
      // microtask chain so the race rejection is caught before we assert.
      await vi.advanceTimersByTimeAsync(20);
      const { result } = await recovery;

      expect(result).toBe('failed');
      expect(deps.reload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an unknown or mismatched pending download', async () => {
    const deps = makeDeps({
      checkForUpdate: vi.fn().mockResolvedValue({ isAvailable: false, isRollBackToEmbedded: false }),
      isReloadReceiptCurrent: vi.fn().mockReturnValue(false),
    });
    const onBeforeReload = vi.fn();
    await expect(performOtaRecovery(deps, { onBeforeReload })).resolves.toEqual({ result: 'no-fix-available' });
    expect(deps.reload).not.toHaveBeenCalled();
    expect(onBeforeReload).not.toHaveBeenCalled();
  });

  it('waits for the native pending event after fetch resolves before reloading', async () => {
    let publish!: (receipt: string) => void;
    const pendingEvent = new Promise<string>((resolve) => {
      publish = resolve;
    });
    const deps = makeDeps({
      captureReloadReceipt: vi.fn().mockReturnValue(null),
      waitForReloadReceipt: (lease) => lease.waitFor(pendingEvent),
    });
    const recovery = performOtaRecovery(deps);
    await vi.waitFor(() => expect(deps.fetchUpdate).toHaveBeenCalledOnce());
    expect(deps.reload).not.toHaveBeenCalled();
    publish('downloaded-update');
    await expect(recovery).resolves.toEqual({ result: 'reloaded-update' });
  });

  it.each(['check', 'fetch'])('a late native %s cannot advance phases, telemetry, or reload', async (phase) => {
    vi.useFakeTimers();
    try {
      let complete!: (result: { isAvailable: boolean; isRollBackToEmbedded: boolean }) => void;
      const held = new Promise<{ isAvailable: boolean; isRollBackToEmbedded: boolean }>((resolve) => {
        complete = resolve;
      });
      const deps = makeDeps();
      if (phase === 'check') deps.checkForUpdate = vi.fn(() => held);
      else deps.fetchUpdate = vi.fn(() => held);
      const onPhase = vi.fn();
      const onBeforeReload = vi.fn();
      const work = performOtaRecovery(deps, { timeoutMs: 10, onPhase, onBeforeReload });
      await vi.advanceTimersByTimeAsync(11);
      expect((await work).result).toBe('failed');
      const phasesAtExpiry = [...onPhase.mock.calls];
      const next = vi.fn(async () => undefined);
      const nextOperation = deps.runOperation(next);
      await vi.advanceTimersByTimeAsync(1);
      expect(next).not.toHaveBeenCalled();
      complete({ isAvailable: true, isRollBackToEmbedded: false });
      await nextOperation;
      expect(onPhase.mock.calls).toEqual(phasesAtExpiry);
      expect(onBeforeReload).not.toHaveBeenCalled();
      expect(deps.reload).not.toHaveBeenCalled();
      if (phase === 'check') expect(deps.fetchUpdate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a queued attempt expires before emitting a phase or starting a check', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const nativeWork = new Promise<void>((resolve) => {
        release = resolve;
      });
      const deps = makeDeps();
      const first = deps.runOperation((lease) => lease.native(() => nativeWork));
      const onPhase = vi.fn();
      const work = performOtaRecovery(deps, { timeoutMs: 10, onPhase });
      await vi.advanceTimersByTimeAsync(11);
      expect((await work).result).toBe('failed');
      release();
      await first;
      await vi.advanceTimersByTimeAsync(1);
      expect(onPhase).not.toHaveBeenCalled();
      expect(deps.checkForUpdate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
