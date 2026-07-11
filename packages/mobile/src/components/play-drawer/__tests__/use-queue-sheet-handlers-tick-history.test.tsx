// @vitest-environment jsdom
// The tick-history round trip: sheets can't stack and a displaced sheet stays
// closed (see sheet-presentation-provider), so handleTickHistory must close the
// queue sheet itself and arrange the explicit return via onDidDismiss.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { useQueueSheetHandlers } from '../use-queue-sheet-handlers';
import type { LogAscentInput } from '../../../providers/drawer-host-provider';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));
// climb-to-queue-item (unused by these tests) imports expo-crypto, which drags
// in raw react-native Flow sources the test transform can't parse.
vi.mock('expo-crypto', () => ({ randomUUID: () => 'mock-uuid' }));

const storedBoardConfig = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 40,
};

function makeItem(uuid: string): ClimbQueueItem {
  return {
    uuid: `queue-${uuid}`,
    climb: { uuid, name: 'Test Climb', difficulty: 'V4', mirrored: false } as ClimbQueueItem['climb'],
  } as ClimbQueueItem;
}

describe('useQueueSheetHandlers handleTickHistory', () => {
  const deps = {
    setCurrentClimb: vi.fn(),
    openPlayDrawer: vi.fn(),
    openClimbActions: vi.fn(),
    openLogAscent: vi.fn(),
    storedBoardConfig,
    sessionId: 'session-1',
    requestCloseQueueSheet: vi.fn(),
    reopenQueueSheet: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes the queue sheet, tracks the open, and wires the explicit queue return', () => {
    const { result } = renderHook(() => useQueueSheetHandlers(deps));

    result.current.handleTickHistory(makeItem('climb-1'));

    expect(analytics.track).toHaveBeenCalledWith('Quick Tick Opened', {
      climbUuid: 'climb-1',
      layoutId: 1,
      source: 'queue_history',
    });
    // Parent-driven close (not a displacement) so no dismissal is misreported.
    expect(deps.requestCloseQueueSheet).toHaveBeenCalledTimes(1);

    const input = deps.openLogAscent.mock.calls[0][0] as LogAscentInput;
    expect(input.climbUuid).toBe('climb-1');
    expect(input.sessionId).toBe('session-1');
    // The queue comes back only when the tick sheet has fully dismissed.
    expect(deps.reopenQueueSheet).not.toHaveBeenCalled();
    input.onDidDismiss?.();
    expect(deps.reopenQueueSheet).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a stored board config', () => {
    const { result } = renderHook(() => useQueueSheetHandlers({ ...deps, storedBoardConfig: null }));

    result.current.handleTickHistory(makeItem('climb-1'));

    expect(deps.openLogAscent).not.toHaveBeenCalled();
    expect(deps.requestCloseQueueSheet).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalled();
  });
});
