// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  ONBOARDING_TIP_SPRAY_LONG_PRESS_KEY,
  ONBOARDING_TIP_SPRAY_MAYBE_KEY,
  ONBOARDING_TIP_SPRAY_TOGGLE_KEY,
} from '@boardsesh/key-value-storage';

const seenKeys = vi.hoisted(() => new Set<string>());
const hasSeenTipMock = vi.hoisted(() => vi.fn());
const markTipSeenMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/onboarding/onboarding-storage', () => ({
  hasSeenTip: hasSeenTipMock,
  markTipSeen: markTipSeenMock,
}));

import {
  EDITS_BEFORE_LONG_PRESS_HINT,
  initialSprayHintsState,
  sprayHintsReducer,
  useSprayEditorHints,
  visibleSprayHint,
  type SprayHintsState,
} from '../use-spray-editor-hints';

beforeEach(() => {
  seenKeys.clear();
  hasSeenTipMock.mockReset();
  markTipSeenMock.mockReset();
  hasSeenTipMock.mockImplementation(async (key: string) => seenKeys.has(key));
  markTipSeenMock.mockImplementation(async (key: string) => {
    seenKeys.add(key);
  });
});

const loaded: SprayHintsState = sprayHintsReducer(initialSprayHintsState, {
  type: 'LOADED',
  seen: { toggle: false, maybe: false, longPress: false },
});

describe('visibleSprayHint', () => {
  it('shows nothing until storage has answered', () => {
    expect(visibleSprayHint(initialSprayHintsState, true)).toBeNull();
  });

  it('opens on the toggle hint, then the maybe hint once it is cleared', () => {
    expect(visibleSprayHint(loaded, true)).toBe('toggle');
    const afterToggle = sprayHintsReducer(loaded, { type: 'EVENT', event: 'toggle' });
    expect(visibleSprayHint(afterToggle, true)).toBe('maybe');
  });

  it('skips the maybe hint on a wall with no maybes', () => {
    const afterToggle = sprayHintsReducer(loaded, { type: 'DISMISS', id: 'toggle' });
    expect(visibleSprayHint(afterToggle, false)).toBeNull();
  });

  it('holds the long-press hint back until three edits', () => {
    let state = sprayHintsReducer(loaded, { type: 'EVENT', event: 'maybe' });
    expect(visibleSprayHint(state, true)).toBeNull();
    for (let edit = 1; edit < EDITS_BEFORE_LONG_PRESS_HINT; edit += 1) {
      state = sprayHintsReducer(state, { type: 'EVENT', event: 'edit' });
    }
    expect(visibleSprayHint(state, true)).toBe('longPress');
  });

  it('never shows a hint whose move the climber found on their own', () => {
    let state = sprayHintsReducer(initialSprayHintsState, { type: 'EVENT', event: 'longPress' });
    state = sprayHintsReducer(state, { type: 'LOADED', seen: { toggle: true, maybe: true, longPress: false } });
    for (let edit = 0; edit < 5; edit += 1) state = sprayHintsReducer(state, { type: 'EVENT', event: 'add' });
    expect(visibleSprayHint(state, true)).toBeNull();
  });

  it('a replay runs all three again, without the edit gate', () => {
    const allSeen = sprayHintsReducer(initialSprayHintsState, {
      type: 'LOADED',
      seen: { toggle: true, maybe: true, longPress: true },
    });
    expect(visibleSprayHint(allSeen, true)).toBeNull();
    let state = sprayHintsReducer(allSeen, { type: 'REPLAY' });
    expect(visibleSprayHint(state, true)).toBe('toggle');
    state = sprayHintsReducer(state, { type: 'DISMISS', id: 'toggle' });
    expect(visibleSprayHint(state, true)).toBe('maybe');
    state = sprayHintsReducer(state, { type: 'DISMISS', id: 'maybe' });
    expect(visibleSprayHint(state, true)).toBe('longPress');
  });
});

describe('useSprayEditorHints', () => {
  it('shows the first hint once, and marks it seen when the climber taps a ring', async () => {
    const { result } = renderHook(() => useSprayEditorHints({ enabled: true, hasMaybes: false }));
    await waitFor(() => expect(result.current.hint).toBe('toggle'));

    act(() => result.current.record('toggle'));
    expect(result.current.hint).toBeNull();
    expect(markTipSeenMock).toHaveBeenCalledWith(ONBOARDING_TIP_SPRAY_TOGGLE_KEY);

    // A second visit: storage now says seen, so it never comes back.
    const second = renderHook(() => useSprayEditorHints({ enabled: true, hasMaybes: false }));
    await waitFor(() => expect(hasSeenTipMock).toHaveBeenCalledTimes(6));
    expect(second.result.current.hint).toBeNull();
  });

  it('does not mark a hint seen just because it showed', async () => {
    const { result } = renderHook(() => useSprayEditorHints({ enabled: true, hasMaybes: true }));
    await waitFor(() => expect(result.current.hint).toBe('toggle'));
    expect(markTipSeenMock).not.toHaveBeenCalled();
  });

  it('keeping a maybe clears both the toggle and the maybe hint', async () => {
    const { result } = renderHook(() => useSprayEditorHints({ enabled: true, hasMaybes: true }));
    await waitFor(() => expect(result.current.hint).toBe('toggle'));
    act(() => result.current.record('maybe'));
    expect(markTipSeenMock).toHaveBeenCalledWith(ONBOARDING_TIP_SPRAY_TOGGLE_KEY);
    expect(markTipSeenMock).toHaveBeenCalledWith(ONBOARDING_TIP_SPRAY_MAYBE_KEY);
    expect(result.current.hint).toBeNull();
  });

  it('marks the long-press hint seen on the first long press', async () => {
    const { result } = renderHook(() => useSprayEditorHints({ enabled: true, hasMaybes: false }));
    await waitFor(() => expect(result.current.hint).toBe('toggle'));
    act(() => result.current.record('longPress'));
    expect(markTipSeenMock).toHaveBeenCalledWith(ONBOARDING_TIP_SPRAY_LONG_PRESS_KEY);
  });

  it('stays silent when disabled (screenshot mode, read-only)', async () => {
    const { result } = renderHook(() => useSprayEditorHints({ enabled: false, hasMaybes: true }));
    act(() => {
      result.current.replay();
      result.current.record('toggle');
    });
    await Promise.resolve();
    expect(result.current.hint).toBeNull();
    expect(hasSeenTipMock).not.toHaveBeenCalled();
    expect(markTipSeenMock).not.toHaveBeenCalled();
  });

  it('stays silent in screenshot mode, where storage reports every tip seen', async () => {
    hasSeenTipMock.mockImplementation(async () => true);
    const { result } = renderHook(() => useSprayEditorHints({ enabled: true, hasMaybes: true }));
    await waitFor(() => expect(hasSeenTipMock).toHaveBeenCalledTimes(3));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.hint).toBeNull();
  });

  it('keeps record stable across renders', async () => {
    const { result, rerender } = renderHook(
      ({ hasMaybes }: { hasMaybes: boolean }) => useSprayEditorHints({ enabled: true, hasMaybes }),
      { initialProps: { hasMaybes: false } },
    );
    const firstRecord = result.current.record;
    rerender({ hasMaybes: true });
    expect(result.current.record).toBe(firstRecord);
  });
});
