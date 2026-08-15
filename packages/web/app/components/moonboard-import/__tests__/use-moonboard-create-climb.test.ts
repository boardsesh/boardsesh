import { describe, it, expect, vi } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import { useMoonBoardCreateClimb } from '../use-moonboard-create-climb';

vi.mock('@/app/lib/moonboard-config', () => ({
  MOONBOARD_HOLD_STATES: {
    start: { color: '#00FF00', displayColor: '#00FF00' },
    hand: { color: '#00FFFF', displayColor: '#00FFFF' },
    finish: { color: '#FF00FF', displayColor: '#FF00FF' },
  },
}));

describe('useMoonBoardCreateClimb', () => {
  describe('initial state', () => {
    it('has empty holdsMap and zero counts', () => {
      const { result } = renderHook(() => useMoonBoardCreateClimb());

      expect(result.current.litUpHoldsMap).toEqual({});
      expect(result.current.totalHolds).toBe(0);
      expect(result.current.startingCount).toBe(0);
      expect(result.current.finishCount).toBe(0);
      expect(result.current.handCount).toBe(0);
      expect(result.current.isValid).toBe(false);
    });
  });

  describe('setHoldState', () => {
    it('sets a hold to STARTING', () => {
      const { result } = renderHook(() => useMoonBoardCreateClimb());

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
      const { result } = renderHook(() => useMoonBoardCreateClimb());

      act(() => {
        result.current.setHoldState(100, 'HAND');
      });

      expect(result.current.litUpHoldsMap[100].state).toBe('HAND');
      expect(result.current.litUpHoldsMap[100].color).toBe('#00FFFF');
    });

    it('sets a hold to FINISH', () => {
      const { result } = renderHook(() => useMoonBoardCreateClimb());

      act(() => {
        result.current.setHoldState(100, 'FINISH');
      });

      expect(result.current.litUpHoldsMap[100].state).toBe('FINISH');
      expect(result.current.litUpHoldsMap[100].color).toBe('#FF00FF');
    });

    it('OFF removes the hold from the map', () => {
      const { result } = renderHook(() => useMoonBoardCreateClimb());

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

    it('refuses FOOT (MoonBoard has no foot holds)', () => {
      const { result } = renderHook(() => useMoonBoardCreateClimb());

      act(() => {
        result.current.setHoldState(100, 'FOOT');
      });

      expect(result.current.litUpHoldsMap[100]).toBeUndefined();
    });
  });

  describe('max state limits', () => {
    it('refuses to add a third STARTING hold when 2 already exist', () => {
      const { result } = renderHook(() => useMoonBoardCreateClimb());

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
    });

    it('refuses to add a third FINISH hold when 2 already exist', () => {
      const { result } = renderHook(() => useMoonBoardCreateClimb());

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
      const { result } = renderHook(() => useMoonBoardCreateClimb());

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });
      act(() => {
        result.current.setHoldState(200, 'STARTING');
      });
      // Re-set hold 100 to STARTING — should still apply because the hold is
      // already counted toward the cap (no new hold is being added).
      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });

      expect(result.current.litUpHoldsMap[100].state).toBe('STARTING');
      expect(result.current.startingCount).toBe(2);
    });
  });

  describe('isValid', () => {
    it('requires at least 1 start and 1 finish hold', () => {
      const { result } = renderHook(() => useMoonBoardCreateClimb());

      expect(result.current.isValid).toBe(false);

      act(() => {
        result.current.setHoldState(100, 'STARTING');
      });
      expect(result.current.isValid).toBe(false);

      act(() => {
        result.current.setHoldState(200, 'HAND');
      });
      expect(result.current.isValid).toBe(false);

      act(() => {
        result.current.setHoldState(300, 'FINISH');
      });
      expect(result.current.isValid).toBe(true);
    });
  });

  describe('resetHolds', () => {
    it('clears all holds', () => {
      const { result } = renderHook(() => useMoonBoardCreateClimb());

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
      expect(result.current.handCount).toBe(0);
      expect(result.current.isValid).toBe(false);
    });
  });

  describe('handCount', () => {
    it('tracks hand holds correctly', () => {
      const { result } = renderHook(() => useMoonBoardCreateClimb());

      act(() => {
        result.current.setHoldState(100, 'HAND');
      });
      expect(result.current.handCount).toBe(1);

      act(() => {
        result.current.setHoldState(200, 'HAND');
      });
      expect(result.current.handCount).toBe(2);
    });
  });

  describe('initial holds map', () => {
    it('accepts initial holds map', () => {
      const initialHoldsMap = {
        100: { state: 'STARTING' as const, color: '#00FF00', displayColor: '#00FF00' },
        200: { state: 'FINISH' as const, color: '#FF00FF', displayColor: '#FF00FF' },
      };

      const { result } = renderHook(() => useMoonBoardCreateClimb({ initialHoldsMap }));

      expect(result.current.litUpHoldsMap).toEqual(initialHoldsMap);
      expect(result.current.totalHolds).toBe(2);
      expect(result.current.startingCount).toBe(1);
      expect(result.current.finishCount).toBe(1);
      expect(result.current.isValid).toBe(true);
    });
  });
});
