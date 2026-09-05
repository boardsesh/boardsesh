// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { describe, expect, it, vi } from 'vitest';
import type { LogAscentInput } from '../../../providers/drawer-host-provider';

vi.mock('../../../lib/climb-to-queue-item', () => ({ climbToQueueItem: vi.fn() }));

import { useQueueSheetHandlers } from '../use-queue-sheet-handlers';

function queueItemWithCount(ascensionistCount: null | undefined): ClimbQueueItem {
  return {
    uuid: 'queue-item-1',
    climb: {
      uuid: 'climb-1',
      angle: 40,
      mirrored: false,
      benchmark_difficulty: null,
      ascensionist_count: ascensionistCount,
      difficulty: 'V3',
    },
    suggested: false,
  } as unknown as ClimbQueueItem;
}

describe('useQueueSheetHandlers', () => {
  it.each([
    { label: 'null', ascensionistCount: null },
    { label: 'undefined', ascensionistCount: undefined },
  ])('normalizes a runtime $label ascensionist count before opening LogAscent', ({ ascensionistCount }) => {
    const openLogAscent = vi.fn();
    const { result } = renderHook(() =>
      useQueueSheetHandlers({
        setCurrentClimb: vi.fn(),
        openPlayDrawer: vi.fn(),
        openClimbActions: vi.fn(),
        openLogAscent,
        storedBoardConfig: {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,2',
          angle: 40,
        },
        sessionId: 'session-1',
        requestCloseQueueSheet: vi.fn(),
        dismissQueueSheetAndWait: vi.fn(async () => ({ status: 'dismissed' as const })),
      }),
    );

    act(() => result.current.handleTickHistory(queueItemWithCount(ascensionistCount)));

    const payload = openLogAscent.mock.calls[0]?.[0] as LogAscentInput;
    expect(payload.baseAscensionistCount).toBe(0);
    expect(Number.isFinite(payload.baseAscensionistCount)).toBe(true);
  });

  it('handleClimbPress drops the list source so the queue sheet resumes queue-order swipes', () => {
    const setCurrentClimb = vi.fn();
    const openPlayDrawer = vi.fn();
    const requestCloseQueueSheet = vi.fn();
    const { result } = renderHook(() =>
      useQueueSheetHandlers({
        setCurrentClimb,
        openPlayDrawer,
        openClimbActions: vi.fn(),
        openLogAscent: vi.fn(),
        storedBoardConfig: {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1,2',
          angle: 40,
        },
        sessionId: 'session-1',
        requestCloseQueueSheet,
        dismissQueueSheetAndWait: vi.fn(async () => ({ status: 'dismissed' as const })),
      }),
    );

    const item = queueItemWithCount(null);
    act(() => result.current.handleClimbPress(item));

    expect(setCurrentClimb).toHaveBeenCalledWith(item, { playlistSuggestionSource: null });
    expect(openPlayDrawer).toHaveBeenCalledWith(item.climb, { committedExternally: true });
    expect(requestCloseQueueSheet).toHaveBeenCalled();
  });
});
