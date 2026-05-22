/**
 * Unit tests for `useEffectiveAngle` — the resolution chain that backs
 * every log path (LogAscentForm, QuickTickBar, swipe-right-to-tick).
 * Pins the priority order and — critically — the 0°-as-valid handling
 * that the group-session feedback fix had to walk through three rounds
 * before landing right. Without these tests, anyone refactoring the
 * bridge context can silently re-introduce the truthiness bug.
 */
import { describe, it, expect } from 'vite-plus/test';
import React from 'react';
import { renderHook } from '@testing-library/react';
import {
  QueueBridgeBoardInfoContext,
  type QueueBridgeBoardInfo,
} from '@/app/components/queue-control/queue-bridge-board-info-context';
import type { Climb } from '@/app/lib/types';
import { useEffectiveAngle } from '../use-effective-angle';

function wrapper(bridge: Partial<QueueBridgeBoardInfo>) {
  const value: QueueBridgeBoardInfo = {
    boardDetails: null,
    angle: 0,
    hasResolvedAngle: false,
    hasActiveQueue: false,
    isHydrated: false,
    ...bridge,
  };
  return ({ children }: { children: React.ReactNode }) => (
    <QueueBridgeBoardInfoContext.Provider value={value}>{children}</QueueBridgeBoardInfoContext.Provider>
  );
}

function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return { uuid: 'climb-1', name: 'X', ...overrides } as Climb;
}

describe('useEffectiveAngle', () => {
  describe('bridge angle (priority 1)', () => {
    it('returns bridge.angle when hasResolvedAngle is true', () => {
      const { result } = renderHook(() => useEffectiveAngle(), {
        wrapper: wrapper({ angle: 35, hasResolvedAngle: true, hasActiveQueue: true }),
      });
      expect(result.current).toBe(35);
    });

    it('returns 0 when bridge angle is 0 and hasResolvedAngle is true (vertical board)', () => {
      // Regression: the original `if (bridge.hasActiveQueue && bridge.angle)`
      // truthy-test treated 0° as "no bridge angle" and fell through.
      // The `hasResolvedAngle` flag distinguishes real 0° (this case)
      // from the bridge's `?? 0` fallback (the test below).
      const { result } = renderHook(() => useEffectiveAngle(), {
        wrapper: wrapper({ angle: 0, hasResolvedAngle: true, hasActiveQueue: true }),
      });
      expect(result.current).toBe(0);
    });

    it('ignores bridge.angle when hasResolvedAngle is false (the bridge fell back to its ?? 0 placeholder)', () => {
      const { result } = renderHook(() => useEffectiveAngle(makeClimb({ angle: 45 })), {
        wrapper: wrapper({ angle: 0, hasResolvedAngle: false, hasActiveQueue: true }),
      });
      // Bridge couldn't resolve — falls through to climb.angle. This is
      // the degenerate solo state (no route, no current climb) the UX
      // review flagged.
      expect(result.current).toBe(45);
    });
  });

  describe('climb angle fallback (priority 2)', () => {
    it('returns climb.angle when no bridge angle is resolved', () => {
      const { result } = renderHook(() => useEffectiveAngle(makeClimb({ angle: 50 })), {
        wrapper: wrapper({ hasResolvedAngle: false }),
      });
      expect(result.current).toBe(50);
    });

    it('returns 0 from climb.angle when 0 is what the climb has (regression: > 0 was the prior gate)', () => {
      const { result } = renderHook(() => useEffectiveAngle(makeClimb({ angle: 0 })), {
        wrapper: wrapper({ hasResolvedAngle: false }),
      });
      expect(result.current).toBe(0);
    });
  });

  describe('null fallback (priority 3)', () => {
    it('returns null when nothing resolves — caller must surface a pick-an-angle affordance', () => {
      const { result } = renderHook(() => useEffectiveAngle(), {
        wrapper: wrapper({ hasResolvedAngle: false }),
      });
      expect(result.current).toBeNull();
    });

    it('returns null when the climb is null and the bridge is empty', () => {
      const { result } = renderHook(() => useEffectiveAngle(null), {
        wrapper: wrapper({ hasResolvedAngle: false }),
      });
      expect(result.current).toBeNull();
    });

    it('returns null when climb.angle is null/undefined and no bridge angle exists', () => {
      const { result } = renderHook(() => useEffectiveAngle(makeClimb({ angle: undefined as unknown as number })), {
        wrapper: wrapper({ hasResolvedAngle: false }),
      });
      expect(result.current).toBeNull();
    });
  });
});
