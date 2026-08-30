// @vitest-environment jsdom
import { useRef } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const draftStore = vi.hoisted(() => ({
  saveDraft: vi.fn(async (_key: string, _draft: Record<string, unknown>) => {}),
  clearDraft: vi.fn(async (_key: string) => {}),
}));

const appState = vi.hoisted(() => ({
  listeners: [] as Array<(state: string) => void>,
  addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
    appState.listeners.push(listener);
    return { remove: vi.fn() };
  }),
  emit(state: string) {
    appState.listeners.forEach((listener) => listener(state));
  },
}));

vi.mock('react-native', () => ({
  AppState: { addEventListener: appState.addEventListener },
}));

vi.mock('../../../lib/create-climb-draft-store', () => ({
  saveDraft: draftStore.saveDraft,
  clearDraft: draftStore.clearDraft,
}));

import { AUTOSAVE_DEBOUNCE_MS, useCreateClimbAutosave } from '../use-create-climb-autosave';

const BASE_DRAFT = {
  holdsJson: '{}',
  framesJson: '[{}]',
  name: '',
  description: '',
  isDraft: true,
};

function useAutosaveHarness({ hasContent, signature }: { hasContent: boolean; signature: string }) {
  const restoredRef = useRef(true);
  return useCreateClimbAutosave({
    slotKey: 'draft-key',
    draft: { ...BASE_DRAFT, name: signature },
    draftSignature: signature,
    hasContent,
    restoredRef,
    restoreEpoch: 0,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  draftStore.saveDraft.mockReset();
  draftStore.saveDraft.mockResolvedValue(undefined);
  draftStore.clearDraft.mockReset();
  draftStore.clearDraft.mockResolvedValue(undefined);
  appState.listeners = [];
  appState.addEventListener.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCreateClimbAutosave', () => {
  it('flushes a pending empty-form clear on unmount', () => {
    const { unmount } = renderHook(() => useAutosaveHarness({ hasContent: false, signature: 'empty' }));

    unmount();

    expect(draftStore.clearDraft).toHaveBeenCalledExactlyOnceWith('draft-key');
    expect(draftStore.saveDraft).not.toHaveBeenCalled();
  });

  it('flushes a pending empty-form clear when the app backgrounds', () => {
    renderHook(() => useAutosaveHarness({ hasContent: false, signature: 'empty' }));

    act(() => appState.emit('background'));

    expect(draftStore.clearDraft).toHaveBeenCalledExactlyOnceWith('draft-key');
    expect(draftStore.saveDraft).not.toHaveBeenCalled();
  });

  it('debounces a non-empty draft save', () => {
    renderHook(() => useAutosaveHarness({ hasContent: true, signature: 'work in progress' }));

    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 1);
    });
    expect(draftStore.saveDraft).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(draftStore.saveDraft).toHaveBeenCalledExactlyOnceWith(
      'draft-key',
      expect.objectContaining({ name: 'work in progress' }),
    );
  });

  it('discards immediately and prevents unmount from recreating the slot', async () => {
    const { result, unmount } = renderHook(() =>
      useAutosaveHarness({ hasContent: true, signature: 'deliberately discarded' }),
    );

    await act(async () => {
      await result.current.discard();
    });
    unmount();

    expect(draftStore.clearDraft).toHaveBeenCalledExactlyOnceWith('draft-key');
    expect(draftStore.saveDraft).not.toHaveBeenCalled();
  });

  it('orders an explicit linked write after an autosave already in flight', async () => {
    let finishAutosave: (() => void) | undefined;
    draftStore.saveDraft.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishAutosave = resolve;
        }),
    );
    const { result } = renderHook(() => useAutosaveHarness({ hasContent: true, signature: 'older autosave' }));

    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    });
    expect(draftStore.saveDraft).toHaveBeenCalledTimes(1);

    const linkedDraft = {
      ...BASE_DRAFT,
      name: 'linked save',
      savedClimbJson: '{"uuid":"row-1"}',
      savedPayloadSignature: 'baseline',
    };
    let pendingLinkedWrite: Promise<void> | undefined;
    act(() => {
      pendingLinkedWrite = result.current.persist(linkedDraft);
    });
    expect(draftStore.saveDraft).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishAutosave?.();
      await pendingLinkedWrite;
    });

    expect(draftStore.saveDraft).toHaveBeenCalledTimes(2);
    expect(draftStore.saveDraft).toHaveBeenLastCalledWith('draft-key', linkedDraft);
  });

  it('re-persists the latest draft when a deliberate clear fails', async () => {
    draftStore.clearDraft.mockRejectedValueOnce(new Error('storage unavailable'));
    const { result, unmount } = renderHook(() =>
      useAutosaveHarness({ hasContent: true, signature: 'latest working copy' }),
    );

    await act(async () => {
      await expect(result.current.discard()).rejects.toThrow('storage unavailable');
    });
    unmount();

    expect(draftStore.saveDraft).toHaveBeenCalledWith(
      'draft-key',
      expect.objectContaining({ name: 'latest working copy' }),
    );
  });
});
