// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import type { ClimbQueueItem, Climb as QueueClimb, PlaylistSuggestionSource } from '@boardsesh/queue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClimbActionsTarget,
  LogAscentInput,
  OpenPlayDrawerOptions,
} from '../../../providers/drawer-host-provider';

const lighting = vi.hoisted(() => ({ enabled: true }));
vi.mock('../use-climb-change-lights', () => ({ isDrivingWall: () => lighting.enabled }));

// The climb up on the wall, as the provider's live snapshot reads it at the tap.
const queueState = vi.hoisted(() => ({ current: null as ClimbQueueItem | null, inSharedSession: false }));
vi.mock('../../../providers/queue-provider', () => ({
  useIsSharedSession: () => queueState.inSharedSession,
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
import { registerHeldQueueItemReader } from '../../../lib/held-climb-reader';
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
  queueState.inSharedSession = false;
});

function renderHandlers() {
  const setCurrentClimb = vi.fn();
  const openPlayDrawer = vi.fn<(climb: unknown, options?: OpenPlayDrawerOptions) => void>();
  const requestCloseQueueSheet = vi.fn();
  const { result } = renderHook(() =>
    useQueueSheetHandlers({
      setCurrentClimb,
      openPlayDrawer,
      getClimbActions: vi.fn(),
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
        getClimbActions: vi.fn(),
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

  it('resolves the menu for the exact duplicate slot without playing or dismissing it', () => {
    const setCurrentClimb = vi.fn();
    const openPlayDrawer = vi.fn();
    const menuTarget = {
      climb: queueItemWithCount(null).climb,
      boardConfig: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 },
    } as unknown as ClimbActionsTarget;
    const getClimbActions = vi.fn((): ClimbActionsTarget | null => menuTarget);
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
    // Resolving the target opens nothing: the native menu presents on its own.
    expect(result.current.handleOpenActions(duplicateSlot)).toBe(menuTarget);
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

// Nothing drives the wall (Always drive the wall off is the default). A pick that previews carries its
// selection to Put on board. A pick of the climb already up can't: its
// preview would have no Put on board, so it commits when the wall keeps its
// climb, and otherwise reopens the climb up as it is.
describe('every queue pick reaches a commit', () => {
  let unregisterHeld: (() => void) | null = null;

  beforeEach(() => {
    lighting.enabled = false;
    queueState.current = { ...queueItemWithCount(null), uuid: 'now-slot' };
  });

  afterEach(() => {
    unregisterHeld?.();
    unregisterHeld = null;
  });

  /** The #4979 hold keeping the Now slot dark, as the Bluetooth provider reports it. */
  function holdNowSlot() {
    unregisterHeld = registerHeldQueueItemReader(() => 'now-slot');
  }

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

  it('commits a History copy of the climb up now at once, since its preview would offer nothing to commit', () => {
    const { result, setCurrentClimb, openPlayDrawer, requestCloseQueueSheet } = renderHandlers();
    const sameClimb = { ...queueItemWithCount(null), uuid: 'history-copy' };
    // The preview the old path opened: the real bar shows no Put on board.
    expect(commitControlFor({ previewQueueItem: sameClimb }, queueState.current)).toBeNull();

    act(() => result.current.handleClimbPress(sameClimb));

    expect(setCurrentClimb).toHaveBeenCalledExactlyOnceWith(sameClimb, { playlistSuggestionSource: null });
    expect(openPlayDrawer).toHaveBeenCalledExactlyOnceWith(sameClimb.climb, { committedExternally: true });
    expect(requestCloseQueueSheet).toHaveBeenCalledOnce();
  });

  // Each of these would light the wall, or write the crew's queue, if it
  // committed: the Now slot's own commit restarts its clock and releases a
  // hold, a History copy is a new current, and a crew shares the queue.
  it.each([
    ['the Now slot itself', 'now-slot', () => {}],
    ['a History copy while the #4979 hold keeps the wall dark', 'history-copy', holdNowSlot],
    ['the Now slot while the hold keeps the wall dark', 'now-slot', holdNowSlot],
    [
      'a History copy in a crew',
      'history-copy',
      () => {
        queueState.inSharedSession = true;
      },
    ],
  ])('reopens the climb up for %s, writing nothing', (_label, slotUuid, arrange) => {
    arrange();
    const { result, setCurrentClimb, openPlayDrawer, requestCloseQueueSheet } = renderHandlers();
    const sameClimb = { ...queueItemWithCount(null), uuid: slotUuid };

    act(() => result.current.handleClimbPress(sameClimb));

    expect(setCurrentClimb).not.toHaveBeenCalled();
    expect(openPlayDrawer).toHaveBeenCalledExactlyOnceWith(sameClimb.climb, { reopensCurrent: true });
    expect(requestCloseQueueSheet).toHaveBeenCalledOnce();
  });

  // Its preview would show no Put on board (the bar compares climbs), and the
  // board control would light or let go of the climb up in its own orientation.
  it('commits a History copy in the other orientation solo, so it can go up mirrored', () => {
    const { result, setCurrentClimb, openPlayDrawer } = renderHandlers();
    const mirroredCopy = { ...queueItemWithCount(null), uuid: 'history-copy' };
    mirroredCopy.climb = { ...mirroredCopy.climb, mirrored: true };

    act(() => result.current.handleClimbPress(mirroredCopy));

    expect(setCurrentClimb).toHaveBeenCalledExactlyOnceWith(mirroredCopy, { playlistSuggestionSource: null });
    expect(openPlayDrawer).toHaveBeenCalledExactlyOnceWith(mirroredCopy.climb, { committedExternally: true });
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

  it('reopens the climb up for its suggestion while the hold keeps the wall dark', () => {
    holdNowSlot();
    const { result, setCurrentClimb, openPlayDrawer } = renderHandlers();
    const suggestion = queueItemWithCount(null).climb as unknown as QueueClimb;
    act(() => result.current.handleSuggestionPress(suggestion, SOURCE));
    expect(setCurrentClimb).not.toHaveBeenCalled();
    expect(openPlayDrawer).toHaveBeenCalledExactlyOnceWith(suggestion, { reopensCurrent: true });
  });
});

describe('opted-in suggestion taps', () => {
  // This phone driving the wall (Always drive the wall's drive included) reaches the handler as
  // `isDrivingWall() === true`.
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
