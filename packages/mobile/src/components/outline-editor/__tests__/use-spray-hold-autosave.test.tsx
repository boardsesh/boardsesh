// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { HOLD_AUTOSAVE_DELAY_MS, useSprayHoldAutosave } from '../use-spray-hold-autosave';

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
function harness(
  props: {
    present?: SprayEditorPresent;
    dirty?: boolean;
    versionId?: string;
    paused?: boolean;
    baseline?: string;
  } = {},
) {
  return useSprayHoldAutosave({
    identity: { ...identity, versionId: props.versionId ?? identity.versionId },
    baseline: props.baseline ?? 'server-baseline',
    present: props.present ?? edited,
    dirty: props.dirty ?? true,
    paused: props.paused ?? false,
    onRestore: restore,
  });
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
