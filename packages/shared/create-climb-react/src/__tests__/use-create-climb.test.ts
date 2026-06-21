import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCreateClimb, holdsReducer, HISTORY_LIMIT } from '../use-create-climb';
import type { HoldsHistory } from '../use-create-climb';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';

vi.mock('@boardsesh/board-constants/hold-states', () => ({
  HOLD_STATE_MAP: {
    kilter: {
      42: { name: 'STARTING', color: '#00FF00', displayColor: '#00FF00' },
      43: { name: 'HAND', color: '#00FFFF', displayColor: '#00FFFF' },
      44: { name: 'FINISH', color: '#FF00FF', displayColor: '#FF00FF' },
      45: { name: 'FOOT', color: '#FFA500', displayColor: '#FFA500' },
    },
    tension: {
      1: { name: 'STARTING', color: '#00FF00', displayColor: '#00FF00' },
      2: { name: 'HAND', color: '#00FFFF', displayColor: '#00FFFF' },
      3: { name: 'FINISH', color: '#FF00FF', displayColor: '#FF00FF' },
      4: { name: 'FOOT', color: '#FFA500', displayColor: '#FFA500' },
    },
    moonboard: {
      1: { name: 'STARTING', color: '#00FF00', displayColor: '#00FF00' },
      2: { name: 'HAND', color: '#00FFFF', displayColor: '#00FFFF' },
      3: { name: 'FINISH', color: '#FF00FF', displayColor: '#FF00FF' },
    },
  },
  STATE_TO_PRIMARY_CODE: {
    kilter: { STARTING: 42, HAND: 43, FINISH: 44, FOOT: 45 },
    tension: { STARTING: 1, HAND: 2, FINISH: 3, FOOT: 4 },
    moonboard: { STARTING: 42, HAND: 43, FINISH: 44 },
  },
}));

describe('useCreateClimb', () => {
  describe('initial state', () => {
    it('has empty holdsMap', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      expect(result.current.litUpHoldsMap).toEqual({});
      expect(result.current.totalHolds).toBe(0);
      expect(result.current.startingCount).toBe(0);
      expect(result.current.finishCount).toBe(0);
      expect(result.current.isValid).toBe(false);
    });
  });

  describe('setHoldState', () => {
    it('sets a hold to STARTING', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });

      expect(result.current.litUpHoldsMap[100]).toEqual({
        state: 'STARTING',
        color: '#00FF00',
        displayColor: '#00FF00',
      });
    });

    it('sets a hold to HAND', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'HAND');
      });

      expect(result.current.litUpHoldsMap[100].state).toBe('HAND');
      expect(result.current.litUpHoldsMap[100].color).toBe('#00FFFF');
    });

    it('sets a hold to FOOT', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'FOOT');
      });

      expect(result.current.litUpHoldsMap[100].state).toBe('FOOT');
      expect(result.current.litUpHoldsMap[100].color).toBe('#FFA500');
    });

    it('sets a hold to FINISH', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'FINISH');
      });

      expect(result.current.litUpHoldsMap[100].state).toBe('FINISH');
      expect(result.current.litUpHoldsMap[100].color).toBe('#FF00FF');
    });

    it('changes a hold from one state to another', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });
      act(() => {
        result.current.setHoldState(100, 'FOOT');
      });

      expect(result.current.litUpHoldsMap[100].state).toBe('FOOT');
    });

    it('OFF removes the hold from the map', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });
      expect(result.current.totalHolds).toBe(1);

      act(() => {
        result.current.setHoldState(100, 'OFF');
      });

      expect(result.current.litUpHoldsMap[100]).toBeUndefined();
      expect(result.current.totalHolds).toBe(0);
    });
  });

  describe('max state limits', () => {
    it('refuses to add a third STARTING hold when 2 already exist', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });
      act(() => {
        result.current.setHoldState(200, 'STARTING');
      });
      expect(result.current.startingCount).toBe(2);

      act(() => {
        result.current.setHoldState(300, 'STARTING');
      });

      expect(result.current.litUpHoldsMap[300]).toBeUndefined();
      expect(result.current.startingCount).toBe(2);
    });

    it('refuses to add a third FINISH hold when 2 already exist', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'FINISH');
      });
      act(() => {
        result.current.setHoldState(200, 'FINISH');
      });
      expect(result.current.finishCount).toBe(2);

      act(() => {
        result.current.setHoldState(300, 'FINISH');
      });

      expect(result.current.litUpHoldsMap[300]).toBeUndefined();
    });

    it('allows re-selecting the same state on a hold already at the limit', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });
      act(() => {
        result.current.setHoldState(200, 'STARTING');
      });
      // Re-set hold 100 to STARTING — should not no-op since it's already there.
      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });

      expect(result.current.litUpHoldsMap[100].state).toBe('STARTING');
      expect(result.current.startingCount).toBe(2);
    });
  });

  describe('generateFramesString', () => {
    it('produces correct format for kilter holds', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });

      const frames = result.current.generateFramesString();
      expect(frames).toBe('p100r42');
    });

    it('produces correct format for multiple holds', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });
      act(() => {
        result.current.setHoldState(200, 'HAND');
      });

      const frames = result.current.generateFramesString();
      expect(frames).toContain('p100r42');
      expect(frames).toContain('p200r43');
    });

    it('returns empty string when no holds', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      const frames = result.current.generateFramesString();
      expect(frames).toBe('');
    });
  });

  describe('resetHolds', () => {
    it('clears all holds', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });
      act(() => {
        result.current.setHoldState(200, 'HAND');
      });
      expect(result.current.totalHolds).toBe(2);

      act(() => {
        result.current.resetHolds();
      });

      expect(result.current.litUpHoldsMap).toEqual({});
      expect(result.current.totalHolds).toBe(0);
      expect(result.current.startingCount).toBe(0);
      expect(result.current.finishCount).toBe(0);
      expect(result.current.isValid).toBe(false);
    });
  });

  describe('derived counts', () => {
    it('totalHolds counts correctly', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });
      act(() => {
        result.current.setHoldState(200, 'HAND');
      });
      act(() => {
        result.current.setHoldState(300, 'FOOT');
      });

      expect(result.current.totalHolds).toBe(3);
    });

    it('startingCount is correct', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });
      act(() => {
        result.current.setHoldState(200, 'STARTING');
      });

      expect(result.current.startingCount).toBe(2);
    });

    it('finishCount is correct', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'FINISH');
      });

      expect(result.current.finishCount).toBe(1);
    });

    it('isValid is true when holds > 0', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      expect(result.current.isValid).toBe(false);

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });

      expect(result.current.isValid).toBe(true);
    });
  });

  describe('initial holds map', () => {
    it('works with initial holds map', () => {
      const initialHoldsMap = {
        100: { state: 'STARTING' as const, color: '#00FF00', displayColor: '#00FF00' },
        200: { state: 'HAND' as const, color: '#00FFFF', displayColor: '#00FFFF' },
      };

      const { result } = renderHook(() => useCreateClimb('kilter', { initialHoldsMap }));

      expect(result.current.litUpHoldsMap).toEqual(initialHoldsMap);
      expect(result.current.totalHolds).toBe(2);
      expect(result.current.startingCount).toBe(1);
      expect(result.current.isValid).toBe(true);
    });

    it('drops initial holds whose state cannot be saved for the board', () => {
      const initialHoldsMap = {
        100: { state: 'STARTING' as const, color: '#00FF00', displayColor: '#00FF00' },
        200: { state: 'FOOT' as const, color: '#FFA500', displayColor: '#FFA500' },
      };

      const { result } = renderHook(() => useCreateClimb('moonboard', { initialHoldsMap }));

      expect(result.current.litUpHoldsMap).toEqual({
        100: { state: 'STARTING', color: '#00FF00', displayColor: '#00FF00' },
      });
      expect(result.current.generateFramesString()).toBe('p100r42');
    });
  });

  describe('loadHolds', () => {
    it('replaces the entire holds map', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });

      const next = {
        200: { state: 'HAND' as const, color: '#00FFFF', displayColor: '#00FFFF' },
        300: { state: 'FINISH' as const, color: '#FF00FF', displayColor: '#FF00FF' },
      };
      act(() => {
        result.current.loadHolds(next);
      });

      expect(result.current.litUpHoldsMap).toEqual(next);
      expect(result.current.litUpHoldsMap[100]).toBeUndefined();
    });

    it('drops loaded holds whose state cannot be saved for the board', () => {
      const { result } = renderHook(() => useCreateClimb('moonboard'));

      act(() => {
        result.current.loadHolds({
          100: { state: 'HAND', color: '#00FFFF', displayColor: '#00FFFF' },
          200: { state: 'FOOT', color: '#FFA500', displayColor: '#FFA500' },
        });
      });

      expect(result.current.litUpHoldsMap).toEqual({
        100: { state: 'HAND', color: '#00FFFF', displayColor: '#00FFFF' },
      });
      expect(result.current.generateFramesString()).toBe('p100r43');
    });
  });

  describe('tension board', () => {
    it('uses tension state codes', () => {
      const { result } = renderHook(() => useCreateClimb('tension'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });

      const frames = result.current.generateFramesString();
      expect(frames).toBe('p100r1');
    });
  });

  describe('undo / redo', () => {
    it('starts with nothing to undo or redo', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      expect(result.current.canUndo).toBe(false);
      expect(result.current.canRedo).toBe(false);
    });

    it('paint -> undo -> redo round-trips', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });
      expect(result.current.canUndo).toBe(true);
      expect(result.current.canRedo).toBe(false);

      act(() => {
        result.current.undo();
      });
      expect(result.current.litUpHoldsMap[100]).toBeUndefined();
      expect(result.current.totalHolds).toBe(0);
      expect(result.current.canUndo).toBe(false);
      expect(result.current.canRedo).toBe(true);

      act(() => {
        result.current.redo();
      });
      expect(result.current.litUpHoldsMap[100].state).toBe('STARTING');
      expect(result.current.canUndo).toBe(true);
      expect(result.current.canRedo).toBe(false);
    });

    it('undo past the baseline is a no-op', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.undo();
      });
      expect(result.current.litUpHoldsMap).toEqual({});
      expect(result.current.canUndo).toBe(false);

      act(() => {
        result.current.redo();
      });
      expect(result.current.litUpHoldsMap).toEqual({});
      expect(result.current.canRedo).toBe(false);
    });

    it('loadHolds resets history to a fresh baseline', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });
      expect(result.current.canUndo).toBe(true);

      act(() => {
        result.current.loadHolds({ 200: { state: 'HAND', color: '#00FFFF', displayColor: '#00FFFF' } });
      });

      // Can't undo back to the 100-painted state or the empty canvas before it.
      expect(result.current.canUndo).toBe(false);
      expect(result.current.canRedo).toBe(false);
      expect(result.current.litUpHoldsMap[200].state).toBe('HAND');
    });

    it('clear (resetHolds) is undoable', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });
      act(() => {
        result.current.setHoldState(200, 'HAND');
      });

      act(() => {
        result.current.resetHolds();
      });
      expect(result.current.totalHolds).toBe(0);
      expect(result.current.canUndo).toBe(true);

      act(() => {
        result.current.undo();
      });
      expect(result.current.totalHolds).toBe(2);
      expect(result.current.litUpHoldsMap[100].state).toBe('STARTING');
      expect(result.current.litUpHoldsMap[200].state).toBe('HAND');
    });

    it('a new edit after undo clears the redo branch', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });
      act(() => {
        result.current.undo();
      });
      expect(result.current.canRedo).toBe(true);

      act(() => {
        result.current.setHoldState(200, 'HAND');
      });
      expect(result.current.canRedo).toBe(false);
      expect(result.current.litUpHoldsMap[200].state).toBe('HAND');
    });

    it('redundant and blocked edits do not grow history', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });
      // Re-paint the same hold to the same state — should not add an undo step.
      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });
      // Exactly one undo returns to the empty baseline.
      act(() => {
        result.current.undo();
      });
      expect(result.current.totalHolds).toBe(0);
      expect(result.current.canUndo).toBe(false);
    });

    it('a blocked third STARTING records no history step', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });
      act(() => {
        result.current.setHoldState(200, 'STARTING');
      });
      // Blocked by the max-2 cap.
      act(() => {
        result.current.setHoldState(300, 'STARTING');
      });

      // Two undos clear both real edits; a third does nothing.
      act(() => {
        result.current.undo();
      });
      act(() => {
        result.current.undo();
      });
      expect(result.current.totalHolds).toBe(0);
      expect(result.current.canUndo).toBe(false);
    });

    it('caps history at the depth limit, dropping the oldest steps', () => {
      const { result } = renderHook(() => useCreateClimb('kilter'));

      // 60 distinct FOOT holds (no max cap on FOOT) — more than HISTORY_LIMIT (50).
      for (let holdId = 1; holdId <= 60; holdId += 1) {
        act(() => {
          result.current.setHoldState(holdId, 'FOOT');
        });
      }
      expect(result.current.totalHolds).toBe(60);

      // Undo as far as possible — capped at 50 steps.
      let undoCount = 0;
      while (result.current.canUndo) {
        act(() => {
          result.current.undo();
        });
        undoCount += 1;
        if (undoCount > 100) break; // safety against an infinite loop on a bug
      }
      expect(undoCount).toBe(50);
      // The 10 oldest holds remain (history fell off the front, not the canvas).
      expect(result.current.totalHolds).toBe(10);
    });

    it('with an initial holds map, undo cannot cross below the seed', () => {
      const initialHoldsMap = {
        100: { state: 'STARTING' as const, color: '#00FF00', displayColor: '#00FF00' },
      };
      const { result } = renderHook(() => useCreateClimb('kilter', { initialHoldsMap }));

      expect(result.current.canUndo).toBe(false);

      act(() => {
        result.current.setHoldState(200, 'HAND');
      });
      act(() => {
        result.current.undo();
      });

      // Back to the seed, not an empty canvas.
      expect(result.current.litUpHoldsMap[100].state).toBe('STARTING');
      expect(result.current.litUpHoldsMap[200]).toBeUndefined();
      expect(result.current.canUndo).toBe(false);
    });

    it('redo caps past at HISTORY_LIMIT even when past is already full', () => {
      // Normal hook usage cannot place past.length === HISTORY_LIMIT while future
      // is non-empty (APPLY always clears future; UNDO always shrinks past before
      // REDO can run). However, a future action that seeds past (e.g. a
      // LOAD-with-history) could create exactly this state. This test calls the
      // reducer directly with that edge-case state to verify capPast is applied.
      // Without the capPast call in REDO the assertion fails: past grows to
      // HISTORY_LIMIT + 1.
      const foot = (id: number): LitUpHoldsMap => ({
        [id]: { state: 'FOOT', color: '#FFA500', displayColor: '#FFA500' },
      });

      const edgeState: HoldsHistory = {
        past: Array.from({ length: HISTORY_LIMIT }, (_, i) => foot(i + 1)),
        present: foot(HISTORY_LIMIT + 1),
        future: [foot(HISTORY_LIMIT + 2)],
      };

      const next = holdsReducer(edgeState, { type: 'REDO' });

      expect(next.past.length).toBeLessThanOrEqual(HISTORY_LIMIT);
      expect(next.present).toEqual(foot(HISTORY_LIMIT + 2));
      expect(next.future).toHaveLength(0);
    });
  });
});
