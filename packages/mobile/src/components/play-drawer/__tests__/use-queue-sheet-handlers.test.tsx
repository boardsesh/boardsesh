// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import type { ClimbQueueItem, Climb as QueueClimb, PlaylistSuggestionSource } from '@boardsesh/queue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogAscentInput, OpenPlayDrawerOptions } from '../../../providers/drawer-host-provider';

const lighting = vi.hoisted(() => ({ enabled: true }));
vi.mock('../use-climb-change-lights', () => ({ readClimbChangeLights: () => lighting.enabled }));

// The climb up on the wall, as the provider's live snapshot reads it at the tap.
const queueState = vi.hoisted(() => ({ current: null as ClimbQueueItem | null }));
vi.mock('../../../providers/queue-provider', () => ({
  useIsSharedSession: () => false,
  useQueueActions: () => ({ getQueueSnapshot: () => ({ currentClimbQueueItem: queueState.current, queue: [] }) }),
}));

vi.mock('../../../lib/climb-to-queue-item', () => ({
  climbToQueueItem: (climb: QueueClimb, options?: { suggested?: boolean }) => ({
    uuid: `suggested-${climb.uuid}`,
    climb,
    suggested: options?.suggested ?? false,
  }),
}));

import { useQueueSheetHandlers } from '../use-queue-sheet-handlers';
// The real commit bar: what a preview the handler opens will offer.
import { resolveCommitBarModel, resolveCommitButton } from '../wall-state';

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
  queueState.current = null;
});

function renderHandlers() {
  const setCurrentClimb = vi.fn();
  const openPlayDrawer = vi.fn<(climb: unknown, options?: OpenPlayDrawerOptions) => void>();
  const requestCloseQueueSheet = vi.fn();
  const { result } = renderHook(() =>
    useQueueSheetHandlers({
      setCurrentClimb,
      openPlayDrawer,
      openClimbActions: vi.fn(),
      openLogAscent: vi.fn(),
      storedBoardConfig: null,
      sessionId: null,
      requestCloseQueueSheet,
      dismissQueueSheetAndWait: vi.fn(async () => ({ status: 'dismissed' as const })),
    }),
  );
  return { result, setCurrentClimb, openPlayDrawer, requestCloseQueueSheet };
}

/**
 * What the player's commit bar offers for the preview `options` opened, with
 * `current` up on a lit, linked wall: the real `resolveCommitBarModel`.
 */
function commitControlFor(options: OpenPlayDrawerOptions | undefined, current: ClimbQueueItem | null) {
  const preview = options?.previewQueueItem ?? null;
  return resolveCommitButton(
    resolveCommitBarModel({
      previewPinned: preview !== null,
      isAnonymous: false,
      boardMismatch: false,
      displayedClimbUuid: preview?.climb.uuid ?? current?.climb.uuid ?? null,
      committedHeadUuid: current?.climb.uuid ?? null,
      wallClimbUuid: current?.climb.uuid ?? null,
      confirmArmed: false,
      wallDriven: true,
      tapConnects: false,
    }),
  );
}

const SOURCE = {
  playlistUuid: 'playlist-1',
  activatedClimbUuid: 'climb-1',
  boardKey: 'kilter:1:10:1,2',
  climbs: [],
} as unknown as PlaylistSuggestionSource;

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

  it('opens actions for the exact duplicate slot without playing or dismissing it', () => {
    const setCurrentClimb = vi.fn();
    const openPlayDrawer = vi.fn();
    const openClimbActions = vi.fn();
    const requestCloseQueueSheet = vi.fn();
    const dismissQueueSheetAndWait = vi.fn(async () => ({ status: 'dismissed' as const }));
    const { result } = renderHook(() =>
      useQueueSheetHandlers({
        setCurrentClimb,
        openPlayDrawer,
        openClimbActions,
        openLogAscent: vi.fn(),
        storedBoardConfig: null,
        sessionId: 'session-1',
        requestCloseQueueSheet,
        dismissQueueSheetAndWait,
      }),
    );
    const duplicateSlot = { ...queueItemWithCount(null), uuid: 'second-slot-for-climb-1' };
    act(() => result.current.handleOpenActions(duplicateSlot));
    expect(openClimbActions).toHaveBeenCalledExactlyOnceWith(duplicateSlot.climb, undefined, {
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
        openClimbActions: vi.fn(),
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

// Light on tap is off (the 2.7 default). A pick that previews carries its
// selection to Put on board; one whose preview would have no Put on board must
// commit at once, or the queue sheet closes on a pick that never lands.
describe('every queue pick reaches a commit', () => {
  beforeEach(() => {
    lighting.enabled = false;
    queueState.current = { ...queueItemWithCount(null), uuid: 'now-slot' };
  });

  it('previews another climb, and its preview offers Put on board', () => {
    const { result, setCurrentClimb, openPlayDrawer } = renderHandlers();
    const otherClimb = { ...queueItemWithCount(null), uuid: 'up-next-slot' };
    otherClimb.climb = { ...otherClimb.climb, uuid: 'climb-2' };
    act(() => result.current.handleClimbPress(otherClimb));
    expect(setCurrentClimb).not.toHaveBeenCalled();
    const options = openPlayDrawer.mock.calls[0]?.[1];
    expect(options).toMatchObject({
      previewQueueItem: otherClimb,
      previewCommitOptions: { playlistSuggestionSource: null },
    });
    expect(commitControlFor(options, queueState.current)).toBe('putOnWall');
  });

  it.each([
    ['a History copy of the climb up now', 'history-copy'],
    ['the Now slot itself', 'now-slot'],
  ])('commits %s at once, since its preview would offer nothing to commit', (_label, slotUuid) => {
    const { result, setCurrentClimb, openPlayDrawer, requestCloseQueueSheet } = renderHandlers();
    const sameClimb = { ...queueItemWithCount(null), uuid: slotUuid };
    // The preview the old path opened: the real bar shows no Put on board.
    expect(commitControlFor({ previewQueueItem: sameClimb }, queueState.current)).toBeNull();

    act(() => result.current.handleClimbPress(sameClimb));

    expect(setCurrentClimb).toHaveBeenCalledExactlyOnceWith(sameClimb, { playlistSuggestionSource: null });
    expect(openPlayDrawer).toHaveBeenCalledExactlyOnceWith(sameClimb.climb, { committedExternally: true });
    expect(requestCloseQueueSheet).toHaveBeenCalledOnce();
  });

  it('previews a suggestion of another climb with its list, and the preview offers Put on board', () => {
    const { result, setCurrentClimb, openPlayDrawer } = renderHandlers();
    const suggestion = { ...queueItemWithCount(null).climb, uuid: 'climb-3' } as unknown as QueueClimb;
    act(() => result.current.handleSuggestionPress(suggestion, SOURCE));
    expect(setCurrentClimb).not.toHaveBeenCalled();
    const options = openPlayDrawer.mock.calls[0]?.[1];
    expect(options).toMatchObject({
      previewQueueItem: { uuid: 'suggested-climb-3', suggested: true },
      playlistSuggestionSource: SOURCE,
    });
    expect(commitControlFor(options, queueState.current)).toBe('putOnWall');
  });

  it('commits a suggestion of the climb up now with its list', () => {
    const { result, setCurrentClimb, openPlayDrawer } = renderHandlers();
    const suggestion = queueItemWithCount(null).climb as unknown as QueueClimb;
    act(() => result.current.handleSuggestionPress(suggestion, SOURCE));
    expect(setCurrentClimb).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ uuid: 'suggested-climb-1', suggested: true }),
      { playlistSuggestionSource: SOURCE },
    );
    expect(openPlayDrawer).toHaveBeenCalledExactlyOnceWith(suggestion, { committedExternally: true });
  });
});

describe('opted-in suggestion taps', () => {
  // Light on tap on, or this phone driving: both reach the handler as
  // `readClimbChangeLights('tap') === true`.
  it('commit with the suggestion list and open the committed climb', () => {
    lighting.enabled = true;
    queueState.current = { ...queueItemWithCount(null), uuid: 'now-slot' };
    const { result, setCurrentClimb, openPlayDrawer, requestCloseQueueSheet } = renderHandlers();
    const suggestion = { ...queueItemWithCount(null).climb, uuid: 'climb-4' } as unknown as QueueClimb;

    act(() => result.current.handleSuggestionPress(suggestion, SOURCE));

    expect(setCurrentClimb).toHaveBeenCalledExactlyOnceWith(
      { uuid: 'suggested-climb-4', climb: suggestion, suggested: true },
      { playlistSuggestionSource: SOURCE },
    );
    expect(openPlayDrawer).toHaveBeenCalledExactlyOnceWith(suggestion, { committedExternally: true });
    expect(requestCloseQueueSheet).toHaveBeenCalledOnce();
  });
});
