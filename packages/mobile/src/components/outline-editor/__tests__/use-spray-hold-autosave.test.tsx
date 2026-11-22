// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSprayEditorStore } from '../spray-editor-store';
import { editorIsDirty } from '../spray-hold-editor-reducer';
import type { SprayEditorPresent } from '../spray-hold-editor-reducer';
import type { SprayHoldEditorDraft } from '../../../lib/spray/spray-hold-draft-store';

const storage = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), clear: vi.fn() }));
const lifecycle = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }));
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  AppState: {
    addEventListener: (_name: string, listener: (state: string) => void) => {
      lifecycle.listeners.add(listener);
      return { remove: () => lifecycle.listeners.delete(listener) };
    },
  },
}));
vi.mock('../../../lib/spray/spray-hold-draft-store', () => ({
  baselineAfterSprayHoldRemovals: (baseline: string, removedIds: number[]) => {
    const parsed = JSON.parse(baseline) as { holds: Array<{ id: number }> };
    return JSON.stringify({ ...parsed, holds: parsed.holds.filter((hold) => !removedIds.includes(hold.id)) });
  },
  loadSprayHoldDraft: storage.load,
  saveSprayHoldDraft: storage.save,
  clearSprayHoldDraft: storage.clear,
  sprayHoldDraftKey: ({ userId, wallUuid, versionId }: { userId: string; wallUuid: string; versionId: string }) =>
    `${userId}:${wallUuid}:${versionId}`,
}));
import { HOLD_AUTOSAVE_DELAY_MS, HOLD_AUTOSAVE_MAX_WAIT_MS, useSprayHoldAutosave } from '../use-spray-hold-autosave';

const identity = { userId: 'setter', wallUuid: 'garage', versionId: 'draft-17' };
const empty: SprayEditorPresent = { holds: {}, removedIds: [], selectedId: null, nextLocalId: -1 };
const edited: SprayEditorPresent = {
  holds: {
    [-1]: {
      id: -1,
      cx: 45,
      cy: 67,
      r: 12,
      outline: null,
      source: 'MANUAL',
      confidence: null,
      review: 'accepted',
      dirty: true,
    },
  },
  removedIds: [101],
  selectedId: -1,
  nextLocalId: -2,
};
const recovery: SprayHoldEditorDraft = { ...identity, schemaVersion: 1, baseline: 'server-baseline', present: edited };
const restore = vi.fn();
type HarnessProps = {
  present?: SprayEditorPresent;
  dirty?: boolean;
  userId?: string | null;
  versionId?: string;
  paused?: boolean;
  baseline?: string;
  readLatestPresent?: () => { present: SprayEditorPresent; dirty: boolean };
};
function harness(props: HarnessProps = {}) {
  return useSprayHoldAutosave({
    identity:
      props.userId === null
        ? null
        : { ...identity, userId: props.userId ?? identity.userId, versionId: props.versionId ?? identity.versionId },
    baseline: props.baseline ?? 'server-baseline',
    present: props.present ?? edited,
    dirty: props.dirty ?? true,
    paused: props.paused ?? false,
    onRestore: restore,
    readLatestPresent: props.readLatestPresent,
  });
}
/** Completed strokes arrive faster than the idle save during a tracing pass. */
function editedAt(centreX: number): SprayEditorPresent {
  return { ...edited, holds: { ...edited.holds, [-1]: { ...edited.holds[-1], cx: centreX } } };
}
async function drawContinuously(rerender: (props: { present: SprayEditorPresent }) => void, count: number) {
  for (let stroke = 1; stroke <= count; stroke += 1) {
    await act(async () => vi.advanceTimersByTimeAsync(100));
    rerender({ present: editedAt(stroke) });
  }
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  storage.load.mockReset().mockResolvedValue(null);
  storage.save.mockReset().mockResolvedValue(undefined);
  storage.clear.mockReset().mockResolvedValue(undefined);
  restore.mockReset();
  lifecycle.listeners.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('hold-editor recovery', () => {
  it('keeps editing locked after network success until its deferred recovery acknowledgement completes', async () => {
    let finishClear: (() => void) | undefined;
    storage.clear.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClear = resolve;
        }),
    );
    const { result } = renderHook(() => harness());
    await settle();
    await act(async () => result.current.flush());
    let commit: Promise<void> | undefined;
    act(() => {
      commit = result.current.runCommit(async () => {
        // The network write has already returned; retiring recovery is still pending.
        await result.current.acknowledge();
      });
    });
    await settle();
    expect(storage.clear).toHaveBeenCalledTimes(1);
    expect(result.current.committing).toBe(true);
    await act(async () => {
      finishClear?.();
      await commit;
    });
    expect(result.current.committing).toBe(false);
  });

  it('does not rewrite an unchanged restored reducer wrapper when writes are unavailable', async () => {
    storage.load.mockResolvedValue(recovery);
    storage.save.mockRejectedValue(new Error('disk full'));
    const { result, rerender } = renderHook(harness, { initialProps: { present: empty } });
    await settle();
    rerender({ present: { ...edited } });
    await act(async () => vi.advanceTimersByTimeAsync(HOLD_AUTOSAVE_DELAY_MS));
    await act(async () => result.current.flush());
    expect(result.current.status).toBe('saved');
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('retains a late acknowledged removal checkpoint while retiring an in-flight commit', async () => {
    const before = JSON.stringify({ holds: [{ id: 101 }, { id: 102 }] });
    const after = JSON.stringify({ holds: [{ id: 102 }] });
    let acknowledgeRemoval: (() => void) | undefined;
    const removed = new Promise<void>((resolve) => {
      acknowledgeRemoval = resolve;
    });
    const { result, unmount } = renderHook(() => harness({ baseline: before, paused: false }));
    await settle();
    await act(async () => result.current.flush());
    let commit: Promise<void> | undefined;
    let retirement: Promise<void> | undefined;
    let retired = false;
    act(() => {
      commit = result.current.runCommit(async () => {
        await removed;
        await result.current.checkpointRemoved([101]);
        throw new Error('screen unmounted before upsert');
      });
      void commit.catch(() => undefined);
      retirement = result.current.retire();
      unmount();
      void retirement.then(() => {
        retired = true;
      });
    });
    await settle();
    expect(retired).toBe(false);
    await act(async () => {
      acknowledgeRemoval?.();
      await retirement;
    });
    expect(retired).toBe(true);
    expect(storage.save).toHaveBeenCalledTimes(2);
    expect(storage.save).toHaveBeenLastCalledWith({
      ...recovery,
      baseline: after,
      present: { ...edited, removedIds: [] },
    });
  });

  it('retains the reducer seed baseline when a clean editor observes newer server holds', async () => {
    const { result, rerender } = renderHook(harness, {
      initialProps: { present: empty, dirty: false, baseline: 'seed-A' },
    });
    await settle();
    rerender({ present: empty, dirty: false, baseline: 'remote-A-and-B' });
    rerender({ present: edited, dirty: true, baseline: 'remote-A-and-B' });
    await act(async () => result.current.flush());
    expect(storage.save).toHaveBeenLastCalledWith({ ...recovery, baseline: 'seed-A' });
  });

  it('settles saved status after a failed network save unpauses an already durable edit', async () => {
    const { result, rerender } = renderHook(harness, { initialProps: { present: edited, dirty: true, paused: false } });
    await settle();
    await act(async () => result.current.flush());
    rerender({ present: edited, dirty: true, paused: true });
    rerender({ present: edited, dirty: true, paused: false });
    await act(async () => vi.advanceTimersByTimeAsync(HOLD_AUTOSAVE_DELAY_MS));
    expect(result.current.status).toBe('saved');
    expect(storage.save).toHaveBeenCalledTimes(1);
  });

  it('drains a pending clear before retirement and refuses late acknowledgements', async () => {
    let finishClear: (() => void) | undefined;
    storage.clear.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClear = resolve;
        }),
    );
    const { result } = renderHook(() => harness());
    await settle();
    let discard: Promise<void> | undefined;
    let retirement: Promise<void> | undefined;
    act(() => {
      discard = result.current.discardRecovery();
    });
    await settle();
    act(() => {
      retirement = result.current.retire();
    });
    let retired = false;
    void retirement?.then(() => {
      retired = true;
    });
    await settle();
    expect(retired).toBe(false);
    await act(async () => {
      finishClear?.();
      await discard;
      await retirement;
    });
    expect(retired).toBe(true);
    await act(async () => result.current.acknowledge());
    expect(storage.clear).toHaveBeenCalledTimes(1);
    await act(async () => expect(result.current.checkpointRemoved([101])).rejects.toThrow('closing'));
  });

  it('restores exact local ids, removals and geometry before allowing edits', async () => {
    storage.load.mockResolvedValue(recovery);
    const { result } = renderHook(() => harness());
    expect(result.current.ready).toBe(false);
    await settle();
    expect(restore).toHaveBeenCalledExactlyOnceWith(edited);
    expect(result.current.ready).toBe(true);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('never overwrites recovery while its read is pending or failed', async () => {
    storage.load.mockRejectedValueOnce(new Error('locked storage'));
    const { result } = renderHook(() => harness());
    await settle();
    expect(result.current.ready).toBe(false);
    expect(result.current.status).toBe('failed');
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(storage.save).not.toHaveBeenCalled();
    await act(async () => result.current.retry());
    await settle();
    expect(result.current.ready).toBe(true);
  });

  it('debounces completed edits and reports saved only after persistence', async () => {
    let finishWrite: (() => void) | undefined;
    storage.save.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const { result } = renderHook(() => harness());
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(HOLD_AUTOSAVE_DELAY_MS - 1));
    expect(storage.save).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(result.current.status).toBe('saving');
    expect(storage.save).toHaveBeenCalledExactlyOnceWith(recovery);
    await act(async () => finishWrite?.());
    expect(result.current.status).toBe('saved');
  });

  it('checkpoints during continuous drawing and restores it before the idle save', async () => {
    let persisted: SprayHoldEditorDraft | null = null;
    storage.load.mockImplementation(async () => persisted);
    storage.save.mockImplementation(async (snapshot: SprayHoldEditorDraft) => {
      persisted = snapshot;
    });
    const { rerender } = renderHook(harness, { initialProps: { present: editedAt(0) } });
    await settle();
    await drawContinuously(rerender, HOLD_AUTOSAVE_MAX_WAIT_MS / 100 - 1);
    expect(storage.save).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(storage.save).toHaveBeenCalledExactlyOnceWith({ ...recovery, present: editedAt(19) });
    rerender({ present: editedAt(20) });
    await drawContinuously(rerender, 3);
    // The first editor is still drawing: no unmount, lock or 500 ms idle gap
    // gets to flush the work before the fresh recovery read observes it.
    restore.mockClear();
    const reopened = renderHook(() => harness({ present: empty, dirty: false }));
    await settle();
    expect(reopened.result.current.ready).toBe(true);
    expect(restore).toHaveBeenCalledExactlyOnceWith(editedAt(19));
    expect(storage.save).toHaveBeenCalledTimes(1);
  });

  it('coalesces continuous edits behind slow storage instead of queuing checkpoints', async () => {
    let finishWrite: (() => void) | undefined;
    storage.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const { result, rerender } = renderHook(harness, { initialProps: { present: editedAt(0) } });
    await settle();
    await drawContinuously(rerender, HOLD_AUTOSAVE_MAX_WAIT_MS / 100);
    expect(storage.save).toHaveBeenCalledTimes(1);
    await drawContinuously(rerender, 70);
    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('saving');
    await act(async () => finishWrite?.());
    expect(storage.save).toHaveBeenCalledTimes(2);
    expect(storage.save).toHaveBeenLastCalledWith({ ...recovery, present: editedAt(70) });
    expect(result.current.status).toBe('saved');
    await act(async () => vi.advanceTimersByTimeAsync(HOLD_AUTOSAVE_MAX_WAIT_MS * 2));
    expect(storage.save).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: 'sign-out', next: { userId: null, present: empty, dirty: false } },
    { name: 'account change', next: { userId: 'another-setter', present: empty, dirty: false } },
    { name: 'draft change', next: { versionId: 'draft-18', present: empty, dirty: false } },
    { name: 'publish pause', next: { paused: true } },
    { name: 'clean undo', next: { present: empty, dirty: false } },
  ] satisfies Array<{ name: string; next: HarnessProps }>)(
    'cancels the pending deadline on $name',
    async ({ next }) => {
      const { rerender } = renderHook(harness, { initialProps: { present: editedAt(0) } as HarnessProps });
      await settle();
      await drawContinuously(rerender, 15);
      rerender(next);
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(HOLD_AUTOSAVE_MAX_WAIT_MS * 2));
      expect(storage.save).not.toHaveBeenCalled();
    },
  );

  it('cancels a pending deadline synchronously when publishing starts and is acknowledged', async () => {
    let finishNetwork: (() => void) | undefined;
    let finishClear: (() => void) | undefined;
    storage.clear.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClear = resolve;
        }),
    );
    const network = new Promise<void>((resolve) => {
      finishNetwork = resolve;
    });
    const { result, rerender } = renderHook(harness, { initialProps: { present: editedAt(0) } });
    await settle();
    await drawContinuously(rerender, 15);
    let commit: Promise<void> | undefined;
    act(() => {
      commit = result.current.runCommit(async () => {
        await network;
        await result.current.acknowledge();
      });
    });
    await act(async () => vi.advanceTimersByTimeAsync(HOLD_AUTOSAVE_MAX_WAIT_MS * 2));
    expect(storage.save).not.toHaveBeenCalled();
    expect(result.current.committing).toBe(true);
    act(() => finishNetwork?.());
    await settle();
    expect(storage.clear).toHaveBeenCalledExactlyOnceWith(identity);
    await act(async () => vi.advanceTimersByTimeAsync(HOLD_AUTOSAVE_MAX_WAIT_MS * 2));
    expect(storage.save).not.toHaveBeenCalled();
    expect(result.current.committing).toBe(true);
    await act(async () => {
      finishClear?.();
      await commit;
    });
    await act(async () => vi.advanceTimersByTimeAsync(HOLD_AUTOSAVE_MAX_WAIT_MS * 2));
    expect(storage.save).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('keeps a failed deadline checkpoint retryable without reporting saved or spinning', async () => {
    storage.save.mockRejectedValueOnce(new Error('disk full'));
    const { result, rerender } = renderHook(harness, { initialProps: { present: editedAt(0) } });
    await settle();
    await drawContinuously(rerender, HOLD_AUTOSAVE_MAX_WAIT_MS / 100 - 1);
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('failed');
    await act(async () => vi.advanceTimersByTimeAsync(HOLD_AUTOSAVE_MAX_WAIT_MS * 2));
    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('failed');
    await act(async () => result.current.retry());
    await settle();
    expect(storage.save).toHaveBeenCalledTimes(2);
    expect(storage.save).toHaveBeenLastCalledWith({ ...recovery, present: editedAt(19) });
    expect(result.current.status).toBe('saved');
  });

  it.each(['inactive', 'background'])('flushes the latest edit immediately on %s', async (state) => {
    renderHook(() => harness());
    await settle();
    await act(async () => lifecycle.listeners.forEach((listener) => listener(state)));
    expect(storage.save).toHaveBeenCalledExactlyOnceWith(recovery);
  });

  it('flushes on browser hide and unmount without waiting for the timer', async () => {
    const { unmount } = renderHook(() => harness());
    await settle();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(storage.save).toHaveBeenCalledTimes(1);
    unmount();
    await settle();
    expect(storage.save).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed write retryable and refuses awaited navigation flush', async () => {
    storage.save.mockRejectedValueOnce(new Error('disk full'));
    const { result } = renderHook(() => harness());
    await settle();
    await act(async () => {
      await expect(result.current.flush()).rejects.toThrow('disk full');
    });
    expect(result.current.status).toBe('failed');
    await act(async () => result.current.retry());
    await settle();
    expect(result.current.status).toBe('saved');
  });

  it('does not replay a recovery against server holds that changed', async () => {
    storage.load.mockResolvedValue({ ...recovery, baseline: 'earlier-holds' });
    const { result } = renderHook(() => harness());
    await settle();
    expect(result.current.ready).toBe(false);
    expect(result.current.status).toBe('changed');
    expect(restore).not.toHaveBeenCalled();
    expect(storage.clear).not.toHaveBeenCalled();
    await act(async () => {
      await expect(result.current.flush()).rejects.toThrow();
    });
  });

  it('retains unreadable recovery until an explicit discard allows reopening', async () => {
    storage.load.mockRejectedValueOnce(
      Object.assign(new Error('invalid local record'), { code: 'INVALID_SPRAY_HOLD_RECOVERY' }),
    );
    const { result } = renderHook(() => harness());
    await settle();
    expect(result.current.status).toBe('changed');
    expect(result.current.ready).toBe(false);
    expect(storage.clear).not.toHaveBeenCalled();
    await act(async () => result.current.discardRecovery());
    await settle();
    expect(storage.clear).toHaveBeenCalledExactlyOnceWith(identity);
    expect(result.current.ready).toBe(true);
  });

  it('clears undone edits after older writes before leaving', async () => {
    let finishWrite: (() => void) | undefined;
    storage.save.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const { result, rerender } = renderHook(harness, { initialProps: { present: edited, dirty: true } });
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(HOLD_AUTOSAVE_DELAY_MS));
    rerender({ present: empty, dirty: false });
    let flushing: Promise<void> | undefined;
    act(() => {
      flushing = result.current.flush();
    });
    expect(storage.clear).not.toHaveBeenCalled();
    await act(async () => {
      finishWrite?.();
      await flushing;
    });
    expect(storage.clear).toHaveBeenCalledExactlyOnceWith(identity);
    expect(result.current.status).toBe('idle');
  });

  it('awaits edits made while a navigation checkpoint is writing', async () => {
    let finishWrite: (() => void) | undefined;
    storage.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const { result, rerender } = renderHook(harness, { initialProps: { present: edited, dirty: true } });
    await settle();
    let flushing: Promise<void> | undefined;
    act(() => {
      flushing = result.current.flush();
    });
    await settle();
    const latest = { ...edited, selectedId: null, nextLocalId: -3 };
    rerender({ present: latest, dirty: true });
    await act(async () => {
      finishWrite?.();
      await flushing;
    });
    expect(storage.save).toHaveBeenCalledTimes(2);
    expect(storage.save).toHaveBeenLastCalledWith({ ...recovery, present: latest });
    expect(result.current.status).toBe('saved');
  });

  it('retiring acknowledged edits prevents an unmount from resurrecting them', async () => {
    const { result, unmount } = renderHook(() => harness());
    await settle();
    await act(async () => result.current.flush());
    await act(async () => result.current.acknowledge());
    unmount();
    await settle();
    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(storage.clear).toHaveBeenCalledTimes(1);
  });

  it('recovers pending additions after acknowledged removals and a failed upsert', async () => {
    const before = JSON.stringify({ holds: [{ id: 101 }, { id: 102 }] });
    const after = JSON.stringify({ holds: [{ id: 102 }] });
    let persisted: SprayHoldEditorDraft | null = null;
    storage.save.mockImplementation(async (snapshot: SprayHoldEditorDraft) => {
      persisted = snapshot;
    });
    const { result, rerender, unmount } = renderHook(harness, {
      initialProps: { present: edited, dirty: true, baseline: before },
    });
    await settle();
    await act(async () => result.current.flush());
    let removedCheckpoint: Promise<void> | undefined;
    act(() => {
      removedCheckpoint = result.current.checkpointRemoved([101]);
      rerender({ present: { ...edited, removedIds: [] }, dirty: true, baseline: before });
    });
    await act(async () => removedCheckpoint);
    // The network upsert can fail now: the acknowledged removals already have
    // a matching baseline and the pending local additions stay recoverable.
    unmount();
    await settle();
    storage.load.mockResolvedValue(persisted);
    restore.mockClear();
    const reopened = renderHook(() => harness({ present: empty, dirty: true, baseline: after }));
    await settle();
    expect(reopened.result.current.ready).toBe(true);
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ holds: edited.holds, removedIds: [] }));
  });

  it('reads each immutable draft version independently', async () => {
    const { result, rerender } = renderHook(harness, { initialProps: { versionId: 'draft-17' } });
    await settle();
    rerender({ versionId: 'draft-18' });
    expect(result.current.ready).toBe(false);
    await settle();
    expect(storage.load).toHaveBeenLastCalledWith({ ...identity, versionId: 'draft-18' });
  });
});

describe('same-tick completed editor transactions', () => {
  it.each(['flush', 'retire'] as const)(
    'includes a completed addition before React renders on %s',
    async (operation) => {
      const store = createSprayEditorStore();
      const readLatestPresent = () => ({ present: store.current, dirty: editorIsDirty(store.current, store.counts) });
      const { result } = renderHook(() => harness({ present: empty, dirty: false, readLatestPresent }));
      await settle();
      await act(async () => {
        store.dispatch({ type: 'ADD_HOLD', geometry: { cx: 12, cy: 34, r: 5, outline: null } });
        await result.current[operation]();
      });
      expect(storage.save).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          present: expect.objectContaining({
            nextLocalId: -2,
            holds: expect.objectContaining({ [-1]: expect.objectContaining({ cx: 12, cy: 34 }) }),
          }),
        }),
      );
    },
  );

  it('drains a newer completed addition while an earlier disk write is pending', async () => {
    const store = createSprayEditorStore();
    let finishWrite: (() => void) | undefined;
    storage.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const readLatestPresent = () => ({ present: store.current, dirty: editorIsDirty(store.current, store.counts) });
    const { result } = renderHook(() => harness({ present: empty, dirty: false, readLatestPresent }));
    await settle();
    let flushing: Promise<void> | undefined;
    await act(async () => {
      store.dispatch({ type: 'ADD_HOLD', geometry: { cx: 12, cy: 34, r: 5, outline: null } });
      flushing = result.current.flush();
      await Promise.resolve();
    });
    await act(async () => {
      store.dispatch({ type: 'ADD_HOLD', geometry: { cx: 56, cy: 78, r: 5, outline: null } });
      finishWrite?.();
      await flushing;
    });
    expect(storage.save).toHaveBeenCalledTimes(2);
    expect(storage.save.mock.calls[1][0].present.holds).toMatchObject({ [-1]: { cx: 12 }, [-2]: { cx: 56 } });
  });
});
