import { describe, expect, it, vi } from 'vitest';
import { performChangelogUpdate } from '../changelog-update';
import { createOtaOperationOwner } from '../ota-operation-owner';

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createDeps() {
  return {
    runOperation: createOtaOperationOwner().run,
    checkForUpdate: vi.fn(async () => ({ isAvailable: true, isRollBackToEmbedded: false })),
    fetchUpdate: vi.fn(async () => undefined),
    captureReloadReceipt: vi.fn(() => 'pending-uuid-at-header-revision-1'),
    isReloadReceiptCurrent: vi.fn(() => true),
    reload: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
  };
}

describe('changelog update ownership', () => {
  it('waits for the pending event before showing restart confirmation', async () => {
    const pendingEvent = deferred<string>();
    const deps = createDeps();
    const work = performChangelogUpdate({
      ...deps,
      waitForReloadReceipt: (lease) => lease.waitFor(pendingEvent.promise),
    });
    await vi.waitFor(() => expect(deps.fetchUpdate).toHaveBeenCalledOnce());
    expect(deps.confirm).not.toHaveBeenCalled();
    pendingEvent.resolve('pending-uuid-at-header-revision-1');
    await expect(work).resolves.toEqual({ result: 'reloaded' });
  });

  it('lets confirmation remain open past the network deadline while another owner runs', async () => {
    vi.useFakeTimers();
    try {
      const confirmation = deferred<boolean>();
      const deps = createDeps();
      deps.confirm.mockImplementation(() => confirmation.promise);
      const work = performChangelogUpdate(deps, { timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(1);
      expect(deps.confirm).toHaveBeenCalledOnce();
      const otherOperation = vi.fn(async () => undefined);
      await deps.runOperation(otherOperation);
      expect(otherOperation).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      confirmation.resolve(true);
      await expect(work).resolves.toEqual({ result: 'reloaded' });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['changed pin revision', 'replacement pending UUID'])('rejects confirmation after a %s', async () => {
    const confirmation = deferred<boolean>();
    const deps = createDeps();
    deps.confirm.mockImplementation(() => confirmation.promise);
    const work = performChangelogUpdate(deps);
    await vi.waitFor(() => expect(deps.confirm).toHaveBeenCalledOnce());
    deps.isReloadReceiptCurrent.mockReturnValue(false);
    confirmation.resolve(true);
    await expect(work).resolves.toEqual({ result: 'stale' });
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('does not show confirmation or download after a late native check', async () => {
    vi.useFakeTimers();
    try {
      const check = deferred<{ isAvailable: boolean; isRollBackToEmbedded: boolean }>();
      const deps = createDeps();
      deps.checkForUpdate.mockImplementation(() => check.promise);
      const onPhase = vi.fn();
      const work = performChangelogUpdate(deps, { timeoutMs: 10, onPhase });
      await vi.advanceTimersByTimeAsync(11);
      expect((await work).result).toBe('failed');
      check.resolve({ isAvailable: true, isRollBackToEmbedded: false });
      await vi.advanceTimersByTimeAsync(1);
      expect(deps.fetchUpdate).not.toHaveBeenCalled();
      expect(deps.confirm).not.toHaveBeenCalled();
      expect(onPhase.mock.calls.map(([phase]) => phase)).toEqual(['checking', 'idle']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires in the queue without phases, downloads, or confirmation', async () => {
    vi.useFakeTimers();
    try {
      const held = deferred<void>();
      const deps = createDeps();
      const first = deps.runOperation((lease) => lease.native(() => held.promise));
      const onPhase = vi.fn();
      const work = performChangelogUpdate(deps, { timeoutMs: 10, onPhase });
      await vi.advanceTimersByTimeAsync(11);
      expect((await work).result).toBe('failed');
      held.resolve(undefined);
      await first;
      await vi.advanceTimersByTimeAsync(1);
      expect(onPhase.mock.calls.map(([phase]) => phase)).toEqual(['idle']);
      expect(deps.checkForUpdate).not.toHaveBeenCalled();
      expect(deps.confirm).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
