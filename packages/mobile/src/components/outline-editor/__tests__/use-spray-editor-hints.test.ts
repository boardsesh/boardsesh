// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  ONBOARDING_TIP_SPRAY_ADD_HOLD_KEY,
  ONBOARDING_TIP_SPRAY_LONG_PRESS_KEY,
  ONBOARDING_TIP_SPRAY_MAYBE_KEY,
  ONBOARDING_TIP_SPRAY_PENCIL_KEY,
  ONBOARDING_TIP_SPRAY_TAP_SELECT_KEY,
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
  seen: { tap: false, maybe: false, longPress: false, addHold: false, pencil: false },
});

describe('visibleSprayHint', () => {
  it('shows nothing until storage has answered', () => {
    expect(visibleSprayHint(initialSprayHintsState, true)).toBeNull();
  });

  it('opens on the tap hint, then the maybe hint once it is cleared', () => {
    expect(visibleSprayHint(loaded, true)).toBe('tap');
    const afterToggle = sprayHintsReducer(loaded, { type: 'EVENT', event: 'toggle' });
    expect(visibleSprayHint(afterToggle, true)).toBe('maybe');
  });

  it('skips the maybe hint on a wall with no maybes', () => {
    const afterToggle = sprayHintsReducer(loaded, { type: 'DISMISS', id: 'tap' });
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
    state = sprayHintsReducer(state, {
      type: 'LOADED',
      seen: { tap: true, maybe: true, longPress: false, addHold: true, pencil: false },
    });
    for (let edit = 0; edit < 5; edit += 1) state = sprayHintsReducer(state, { type: 'EVENT', event: 'add' });
    expect(visibleSprayHint(state, true)).toBeNull();
  });

  it('picking a ring or tapping bare wall is not an edit for the long-press gate', () => {
    let state = sprayHintsReducer(loaded, { type: 'EVENT', event: 'maybe' });
    for (let tap = 0; tap < 5; tap += 1) {
      state = sprayHintsReducer(state, { type: 'EVENT', event: 'select' });
      state = sprayHintsReducer(state, { type: 'EVENT', event: 'bareWall' });
      state = sprayHintsReducer(state, { type: 'DISMISS', id: 'addHold' });
    }
    expect(state.edits).toBe(1);
    expect(visibleSprayHint(state, true)).toBeNull();
  });

  it('picking a ring does not clear the tap hint; switching it does', () => {
    const picked = sprayHintsReducer(loaded, { type: 'EVENT', event: 'select' });
    expect(visibleSprayHint(picked, false)).toBe('tap');
    const switched = sprayHintsReducer(picked, { type: 'EVENT', event: 'toggle' });
    expect(visibleSprayHint(switched, false)).toBeNull();
  });

  describe('the add-a-hold hint', () => {
    it('waits to be asked by a tap on bare wall, then jumps the queue', () => {
      expect(visibleSprayHint(loaded, true)).toBe('tap');
      const asked = sprayHintsReducer(loaded, { type: 'EVENT', event: 'bareWall' });
      expect(visibleSprayHint(asked, true)).toBe('addHold');
    });

    it('is used up by adding a hold, and a second bare-wall tap does not bring it back', () => {
      let state = sprayHintsReducer(loaded, { type: 'EVENT', event: 'bareWall' });
      state = sprayHintsReducer(state, { type: 'EVENT', event: 'add' });
      expect(visibleSprayHint(state, false)).toBe('tap');
      state = sprayHintsReducer(state, { type: 'EVENT', event: 'bareWall' });
      expect(visibleSprayHint(state, false)).toBe('tap');
    });

    it('stays away once seen on an earlier visit', () => {
      const seen = sprayHintsReducer(initialSprayHintsState, {
        type: 'LOADED',
        seen: { tap: true, maybe: true, longPress: true, addHold: true, pencil: false },
      });
      expect(visibleSprayHint(sprayHintsReducer(seen, { type: 'EVENT', event: 'bareWall' }), true)).toBeNull();
    });

    it('a repeated bare-wall tap leaves the state alone', () => {
      const asked = sprayHintsReducer(loaded, { type: 'EVENT', event: 'bareWall' });
      expect(sprayHintsReducer(asked, { type: 'EVENT', event: 'bareWall' })).toBe(asked);
    });
  });

  describe('the Pencil hint', () => {
    it('waits for the first Pencil, then goes ahead of everything', () => {
      let state = sprayHintsReducer(loaded, { type: 'EVENT', event: 'bareWall' });
      expect(visibleSprayHint(state, true)).toBe('addHold');
      state = sprayHintsReducer(state, { type: 'EVENT', event: 'pencil' });
      expect(visibleSprayHint(state, true)).toBe('pencil');
    });

    it('is used up by a finger picking a ring, not by the Pencil itself', () => {
      let state = sprayHintsReducer(loaded, { type: 'EVENT', event: 'pencil' });
      state = sprayHintsReducer(state, { type: 'EVENT', event: 'toggle' });
      state = sprayHintsReducer(state, { type: 'EVENT', event: 'add' });
      expect(visibleSprayHint(state, false)).toBe('pencil');
      state = sprayHintsReducer(state, { type: 'EVENT', event: 'fingerPick' });
      expect(visibleSprayHint(state, false)).toBeNull();
    });

    it('is not an edit for the long-press gate, and a repeat leaves the state alone', () => {
      const asked = sprayHintsReducer(loaded, { type: 'EVENT', event: 'pencil' });
      expect(asked.edits).toBe(0);
      expect(sprayHintsReducer(asked, { type: 'EVENT', event: 'pencil' })).toBe(asked);
    });

    it('replays only for a climber who has used a Pencil', () => {
      const allSeen = sprayHintsReducer(initialSprayHintsState, {
        type: 'LOADED',
        seen: { tap: true, maybe: true, longPress: true, addHold: true, pencil: true },
      });
      const state = sprayHintsReducer(allSeen, { type: 'REPLAY' });
      expect(visibleSprayHint(sprayHintsReducer(state, { type: 'DISMISS', id: 'tap' }), false)).toBe('addHold');
      const withPencil = sprayHintsReducer(sprayHintsReducer(allSeen, { type: 'EVENT', event: 'pencil' }), {
        type: 'REPLAY',
      });
      expect(visibleSprayHint(sprayHintsReducer(withPencil, { type: 'DISMISS', id: 'tap' }), false)).toBe('pencil');
    });
  });

  it('a replay runs every hint again, without the edit gate', () => {
    const allSeen = sprayHintsReducer(initialSprayHintsState, {
      type: 'LOADED',
      seen: { tap: true, maybe: true, longPress: true, addHold: true, pencil: false },
    });
    expect(visibleSprayHint(allSeen, true)).toBeNull();
    let state = sprayHintsReducer(allSeen, { type: 'REPLAY' });
    expect(visibleSprayHint(state, true)).toBe('tap');
    state = sprayHintsReducer(state, { type: 'DISMISS', id: 'tap' });
    expect(visibleSprayHint(state, true)).toBe('addHold');
    state = sprayHintsReducer(state, { type: 'DISMISS', id: 'addHold' });
    expect(visibleSprayHint(state, true)).toBe('maybe');
    state = sprayHintsReducer(state, { type: 'DISMISS', id: 'maybe' });
    expect(visibleSprayHint(state, true)).toBe('longPress');
  });
});

describe('useSprayEditorHints', () => {
  it('shows the first hint once, and marks it seen when the climber taps a ring', async () => {
    const { result } = renderHook(() => useSprayEditorHints({ enabled: true, hasMaybes: false }));
    await waitFor(() => expect(result.current.hint).toBe('tap'));

    act(() => result.current.record('toggle'));
    expect(result.current.hint).toBeNull();
    expect(markTipSeenMock).toHaveBeenCalledWith(ONBOARDING_TIP_SPRAY_TAP_SELECT_KEY);

    // A second visit: storage now says seen, so it never comes back.
    const second = renderHook(() => useSprayEditorHints({ enabled: true, hasMaybes: false }));
    await waitFor(() => expect(hasSeenTipMock).toHaveBeenCalledTimes(10));
    expect(second.result.current.hint).toBeNull();
  });

  it('does not mark a hint seen just because it showed', async () => {
    const { result } = renderHook(() => useSprayEditorHints({ enabled: true, hasMaybes: true }));
    await waitFor(() => expect(result.current.hint).toBe('tap'));
    expect(markTipSeenMock).not.toHaveBeenCalled();
  });

  it('keeping a maybe clears both the tap and the maybe hint', async () => {
    const { result } = renderHook(() => useSprayEditorHints({ enabled: true, hasMaybes: true }));
    await waitFor(() => expect(result.current.hint).toBe('tap'));
    act(() => result.current.record('maybe'));
    expect(markTipSeenMock).toHaveBeenCalledWith(ONBOARDING_TIP_SPRAY_TAP_SELECT_KEY);
    expect(markTipSeenMock).toHaveBeenCalledWith(ONBOARDING_TIP_SPRAY_MAYBE_KEY);
    expect(result.current.hint).toBeNull();
  });

  it('marks the add-a-hold hint seen when the climber adds a hold', async () => {
    const { result } = renderHook(() => useSprayEditorHints({ enabled: true, hasMaybes: false }));
    await waitFor(() => expect(result.current.hint).toBe('tap'));
    act(() => result.current.record('bareWall'));
    expect(result.current.hint).toBe('addHold');
    // Asking is not seeing: nothing is written until the hint is used or closed.
    expect(markTipSeenMock).not.toHaveBeenCalled();
    act(() => result.current.record('add'));
    expect(markTipSeenMock).toHaveBeenCalledWith(ONBOARDING_TIP_SPRAY_ADD_HOLD_KEY);
    expect(result.current.hint).toBe('tap');
  });

  it('marks the Pencil hint seen when a finger picks a ring, not when the Pencil asks for it', async () => {
    const { result } = renderHook(() => useSprayEditorHints({ enabled: true, hasMaybes: false }));
    await waitFor(() => expect(result.current.hint).toBe('tap'));
    act(() => result.current.record('pencil'));
    expect(result.current.hint).toBe('pencil');
    expect(markTipSeenMock).not.toHaveBeenCalled();
    act(() => result.current.record('fingerPick'));
    expect(markTipSeenMock).toHaveBeenCalledWith(ONBOARDING_TIP_SPRAY_PENCIL_KEY);
    expect(result.current.hint).toBe('tap');
  });

  it('marks the long-press hint seen on the first long press', async () => {
    const { result } = renderHook(() => useSprayEditorHints({ enabled: true, hasMaybes: false }));
    await waitFor(() => expect(result.current.hint).toBe('tap'));
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
    await waitFor(() => expect(hasSeenTipMock).toHaveBeenCalledTimes(5));
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
