// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogAscentInput } from '../../../providers/drawer-host-provider';

const lighting = vi.hoisted(() => ({ enabled: true }));
vi.mock('../use-climb-change-lights', () => ({ readClimbChangeLights: () => lighting.enabled }));

vi.mock('../../../providers/queue-provider', () => ({
  useIsSharedSession: () => false,
  useQueueActions: () => ({ getQueueSnapshot: () => ({ currentClimbQueueItem: null, queue: [] }) }),
}));

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

beforeEach(() => {
  lighting.enabled = true;
});

describe('useQueueSheetHandlers', () => {
  it('uses the queue-local presenter override without opening the root sheet or closing Queue', () => {
    const rootOpen = vi.fn();
    const localOpen = vi.fn();
    const requestCloseQueueSheet = vi.fn();
    const dismissQueueSheetAndWait = vi.fn(async () => ({ status: 'dismissed' as const }));
    const { result } = renderHook(() =>
      useQueueSheetHandlers({
        setCurrentClimb: vi.fn(),
        openPlayDrawer: vi.fn(),
        openClimbActions: vi.fn(),
        openLogAscent: rootOpen,
        storedBoardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 },
        sessionId: 'session-local',
        requestCloseQueueSheet,
        dismissQueueSheetAndWait,
      }),
    );
    const item = queueItemWithCount(null);
    act(() => result.current.handleTickHistory(item, localOpen));
    expect(localOpen).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        climbUuid: item.climb.uuid,
        boardName: 'kilter',
        angle: item.climb.angle,
        sessionId: 'session-local',
        baseAscensionistCount: 0,
      }),
    );
    expect(rootOpen).not.toHaveBeenCalled();
    expect(requestCloseQueueSheet).not.toHaveBeenCalled();
    expect(dismissQueueSheetAndWait).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'null', ascensionistCount: null },
    { label: 'undefined', ascensionistCount: undefined },
  ])('normalizes a runtime $label ascensionist count before opening LogAscent', ({ ascensionistCount }) => {
    const openLogAscent = vi.fn();
    const { result } = renderHook(() =>
      useQueueSheetHandlers({
        setCurrentClimb: vi.fn(),
        openPlayDrawer: vi.fn(),
        getClimbActions: vi.fn(),
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

  it('opens actions for the exact duplicate slot without playing or dismissing it', () => {
    const setCurrentClimb = vi.fn();
    const openPlayDrawer = vi.fn();
    const getClimbActions = vi.fn();
    const requestCloseQueueSheet = vi.fn();
    const dismissQueueSheetAndWait = vi.fn(async () => ({ status: 'dismissed' as const }));
    const { result } = renderHook(() =>
      useQueueSheetHandlers({
        setCurrentClimb,
        openPlayDrawer,
        getClimbActions,
        openLogAscent: vi.fn(),
        storedBoardConfig: null,
        sessionId: 'session-1',
        requestCloseQueueSheet,
        dismissQueueSheetAndWait,
      }),
    );
    const duplicateSlot = { ...queueItemWithCount(null), uuid: 'second-slot-for-climb-1' };
    act(() => result.current.handleOpenActions(duplicateSlot));
    expect(getClimbActions).toHaveBeenCalledExactlyOnceWith(duplicateSlot.climb, undefined, {
      queueItemUuid: 'second-slot-for-climb-1',
      dismissSourceSheet: dismissQueueSheetAndWait,
    });
    expect(setCurrentClimb).not.toHaveBeenCalled();
    expect(openPlayDrawer).not.toHaveBeenCalled();
    expect(requestCloseQueueSheet).not.toHaveBeenCalled();
    expect(dismissQueueSheetAndWait).not.toHaveBeenCalled();
  });

  it('an opted-in handleClimbPress drops the list source so the queue sheet resumes queue-order swipes', () => {
    const setCurrentClimb = vi.fn();
    const openPlayDrawer = vi.fn();
    const requestCloseQueueSheet = vi.fn();
    const { result } = renderHook(() =>
      useQueueSheetHandlers({
        setCurrentClimb,
        openPlayDrawer,
        getClimbActions: vi.fn(),
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

describe('preview-first queue selections', () => {
  it('previews the selected duplicate slot and defers clearing the old list source', () => {
    lighting.enabled = false;
    const setCurrentClimb = vi.fn();
    const openPlayDrawer = vi.fn();
    const requestCloseQueueSheet = vi.fn();
    const { result } = renderHook(() =>
      useQueueSheetHandlers({
        setCurrentClimb,
        openPlayDrawer,
        getClimbActions: vi.fn(),
        openLogAscent: vi.fn(),
        storedBoardConfig: null,
        sessionId: 'session-1',
        requestCloseQueueSheet,
        dismissQueueSheetAndWait: vi.fn(async () => ({ status: 'dismissed' as const })),
      }),
    );
    const duplicateSlot = { ...queueItemWithCount(null), uuid: 'second-slot' };
    act(() => result.current.handleClimbPress(duplicateSlot));
    expect(setCurrentClimb).not.toHaveBeenCalled();
    expect(openPlayDrawer).toHaveBeenCalledExactlyOnceWith(duplicateSlot.climb, {
      previewQueueItem: duplicateSlot,
      previewCommitOptions: { playlistSuggestionSource: null },
    });
    expect(requestCloseQueueSheet).toHaveBeenCalledOnce();
  });
});
