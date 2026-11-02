// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import type { PlayDrawerOpenOptions } from '../play-drawer-types';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { usePlaySelectionController } from '../use-play-selection-controller';
import { enterDriveMode, getDriveMode, markDriveLive, resetDriveModeForTests } from '../drive-mode-store';

const authority = vi.hoisted(() => ({ uuid: 0, platform: 'ios', announce: vi.fn() }));
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: authority.announce },
  Platform: {
    get OS() {
      return authority.platform;
    },
  },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => `selection-${++authority.uuid}` }));

type SelectionInputs = Parameters<typeof usePlaySelectionController>[0];
function item(uuid: string): ClimbQueueItem {
  return {
    uuid: `queue-${uuid}`,
    climb: {
      uuid,
      name: `Climb ${uuid}`,
      frames: 'p1r12',
      setter_username: 'setter',
      angle: 40,
      ascensionist_count: 0,
      difficulty: 'V3',
      quality_average: '3',
      stars: 3,
      difficulty_error: '0.3',
      benchmark_difficulty: null,
    },
  };
}
function source(climbs: ClimbQueueItem[]): PlaylistSuggestionSource {
  return {
    playlistUuid: 'playlist',
    activatedClimbUuid: climbs[0].climb.uuid,
    boardKey: 'kilter:1',
    climbs: climbs.map(({ climb }) => climb),
  };
}
function inputs(): SelectionInputs {
  return {
    openTarget: null,
    viewer: 'member',
    showBoardMismatch: false,
    preview: {
      drawerPreviewItem: null,
      drawerPreviewSuggestionSource: null,
      setDrawerPreviewItem: vi.fn(),
      setDrawerPreviewSuggestionSource: vi.fn(),
      setDrawerPreviewIsWallClimb: vi.fn(),
      setSharedBrowseLatched: vi.fn(),
    },
    queue: {
      currentClimbQueueItem: item('current'),
      setCurrentClimb: vi.fn(),
      previousClimb: vi.fn(),
      nextClimb: vi.fn(),
    },
    similarTrack: { boardKey: 'kilter:1:10:1,2', committedBoardKey: 'kilter:1:10:1,2', label: 'Similar climbs' },
    navigation: {
      navigationState: { prevItem: item('previous'), nextItem: item('next') },
      // The walk off the climb on the wall has no list unless a case gives it one.
      nextPreviewSource: null,
      previousPreviewSource: null,
      browseByDefault: false,
      // Preview-first: nothing drives the wall until a test says so.
      driving: false,
      previewOnOtherBoard: false,
    },
    chrome: {
      clearMirror: vi.fn(),
      restoreMirror: vi.fn(),
      setIsTickBarActive: vi.fn(),
      setActiveSubDrawer: vi.fn(),
    },
    confirmation: {
      busyWallConfirmArmed: false,
      browseLatchActive: false,
      wallClimbUuid: 'wall',
      displayedClimbUuid: 'preview',
      wallUuidAtLatchStartRef: { current: 'wall' },
      setBusyWallConfirmArmed: vi.fn(),
      markLatchExit: vi.fn(),
    },
    hold: {
      heldQueueItemUuid: null,
      putHeldClimbOnWall: vi.fn(),
    },
    onNavigationStep: vi.fn(),
  };
}
function open(selected: ClimbQueueItem, options?: PlayDrawerOpenOptions) {
  return { climb: selected.climb as Climb, nonce: 1, options };
}

beforeEach(() => {
  authority.uuid = 0;
  authority.platform = 'ios';
  authority.announce.mockClear();
});

describe('the #4979 hold (section 6, decision A)', () => {
  function heldInputs(): SelectionInputs {
    const held = inputs();
    held.hold.heldQueueItemUuid = held.queue.currentClimbQueueItem!.uuid;
    // A list pick only lights while this phone drives the wall.
    held.navigation.driving = true;
    return held;
  }

  it('a pick of the held climb from a list row (search, playlist, logbook, feed) lights it', () => {
    const initialProps = heldInputs();
    initialProps.openTarget = open(initialProps.queue.currentClimbQueueItem!);
    renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.hold.putHeldClimbOnWall).toHaveBeenCalledOnce();
    // Lighting it is not a new pass: the queue is not written.
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
  });

  it("a queue-sheet or board-sheet tap leaves the lighting to the caller's setCurrentClimb", () => {
    // The caller's setCurrentClimb restarted the held climb's clock, which lights
    // it (`reopen`); a relight here would send the climb twice.
    const initialProps = heldInputs();
    initialProps.openTarget = open(initialProps.queue.currentClimbQueueItem!, { committedExternally: true });
    renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.hold.putHeldClimbOnWall).not.toHaveBeenCalled();
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
  });

  it('a pane that mounts after the tap replays the target without lighting the held climb', () => {
    // The iPad host keeps its pane target, and each tab mounts its own pane.
    const first = heldInputs();
    let applied = false;
    const target = {
      ...open(first.queue.currentClimbQueueItem!),
      claimFirstApply: () => {
        if (applied) return false;
        applied = true;
        return true;
      },
    };
    first.openTarget = target;
    renderHook(usePlaySelectionController, { initialProps: first });
    expect(first.hold.putHeldClimbOnWall).toHaveBeenCalledOnce();

    const later = heldInputs();
    later.openTarget = target;
    renderHook(usePlaySelectionController, { initialProps: later });
    expect(later.hold.putHeldClimbOnWall).not.toHaveBeenCalled();
  });

  it('the accessory bar or mini player reopening the held climb keeps it dark', () => {
    const initialProps = heldInputs();
    initialProps.openTarget = open(initialProps.queue.currentClimbQueueItem!, { reopensCurrent: true });
    renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.hold.putHeldClimbOnWall).not.toHaveBeenCalled();
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
  });

  it('a preview of the held climb never lights it', () => {
    const initialProps = heldInputs();
    const current = initialProps.queue.currentClimbQueueItem!;
    initialProps.openTarget = open(current, { previewQueueItem: item(current.climb.uuid) });
    renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.hold.putHeldClimbOnWall).not.toHaveBeenCalled();
  });

  it('leaves the board alone for an anonymous reader or a board mismatch', () => {
    for (const patch of [{ viewer: 'anonymous' as const }, { showBoardMismatch: true }]) {
      const initialProps = { ...heldInputs(), ...patch };
      initialProps.openTarget = open(initialProps.queue.currentClimbQueueItem!);
      renderHook(usePlaySelectionController, { initialProps });
      expect(initialProps.hold.putHeldClimbOnWall).not.toHaveBeenCalled();
    }
  });

  it('does nothing with no hold, or a hold on another queue item', () => {
    for (const heldQueueItemUuid of [null, 'queue-other']) {
      const initialProps = inputs();
      initialProps.hold.heldQueueItemUuid = heldQueueItemUuid;
      initialProps.openTarget = open(initialProps.queue.currentClimbQueueItem!);
      renderHook(usePlaySelectionController, { initialProps });
      expect(initialProps.hold.putHeldClimbOnWall).not.toHaveBeenCalled();
    }
  });

  it('a pick of another climb is a new current climb, not a relight', () => {
    const initialProps = heldInputs();
    initialProps.openTarget = open(item('new'));
    renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.hold.putHeldClimbOnWall).not.toHaveBeenCalled();
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledOnce();
  });
});

describe('host target application', () => {
  it('commits a genuinely new open while driving and resets its chrome', () => {
    const initialProps = { ...inputs(), openTarget: open(item('new')) };
    initialProps.navigation.driving = true;
    renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledWith(
      expect.objectContaining({ climb: expect.objectContaining({ uuid: 'new' }) }),
      { playlistSuggestionSource: null },
    );
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(null);
    expect(initialProps.preview.setSharedBrowseLatched).toHaveBeenCalledWith(false);
    expect(initialProps.chrome.setIsTickBarActive).toHaveBeenCalledWith(false);
    expect(initialProps.chrome.setActiveSubDrawer).toHaveBeenCalledWith('none');
    expect(initialProps.chrome.clearMirror).toHaveBeenCalledOnce();
  });

  it.each(['already-current', 'committed-externally'] as const)('does not append an %s open', (kind) => {
    const initialProps = inputs();
    initialProps.navigation.driving = true;
    initialProps.openTarget =
      kind === 'already-current'
        ? open(initialProps.queue.currentClimbQueueItem!)
        : open(item('new'), { committedExternally: true });
    renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(null);
  });

  it('browses a crew open while retaining its source and existing latch', () => {
    const selected = item('new');
    const selectedSource = source([selected, item('next')]);
    const initialProps = inputs();
    initialProps.navigation.browseByDefault = true;
    initialProps.openTarget = open(selected, { playlistSuggestionSource: selectedSource });
    renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(
      expect.objectContaining({ climb: expect.objectContaining({ uuid: 'new' }) }),
    );
    expect(initialProps.preview.setDrawerPreviewSuggestionSource).toHaveBeenCalledWith(selectedSource);
    expect(initialProps.preview.setSharedBrowseLatched).not.toHaveBeenCalled();
  });

  it('preserves an explicitly pinned wall preview without committing', () => {
    const selected = item('wall');
    const initialProps = {
      ...inputs(),
      openTarget: open(selected, { previewQueueItem: selected, previewIsWallClimb: true }),
    };
    renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(selected);
    expect(initialProps.preview.setDrawerPreviewIsWallClimb).toHaveBeenCalledWith(true);
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
  });

  it('keys target application only on the target and uses latest selection closures for the next nonce', () => {
    const initialProps = { ...inputs(), openTarget: open(item('new')) };
    initialProps.navigation.driving = true;
    const { rerender } = renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledOnce();
    // The drive ended (a stop, or a crew formed): the next nonce previews.
    const crew = { ...initialProps, navigation: { ...initialProps.navigation, browseByDefault: true, driving: false } };
    rerender(crew);
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledOnce();
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledTimes(1);
    rerender({ ...crew, openTarget: { ...initialProps.openTarget, nonce: 2 } });
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledOnce();
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ climb: expect.objectContaining({ uuid: 'new' }) }),
    );
  });
});

describe('swipe selection callbacks', () => {
  it.each(['handlePrev', 'handleNext'] as const)('%s preserves the live queue path while driving', (handler) => {
    const initialProps = inputs();
    initialProps.navigation.driving = true;
    initialProps.navigation.nextPreviewSource = source([item('current'), item('next')]);
    initialProps.navigation.previousPreviewSource = source([item('previous'), item('current')]);
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current[handler]('button'));
    expect(
      handler === 'handlePrev' ? initialProps.queue.previousClimb : initialProps.queue.nextClimb,
    ).toHaveBeenCalledOnce();
    // Driving commits and lights each step: no look, so no list handed to one.
    expect(initialProps.preview.setDrawerPreviewSuggestionSource).not.toHaveBeenCalled();
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(null);
    expect(initialProps.preview.setDrawerPreviewIsWallClimb).toHaveBeenCalledWith(false);
    expect(initialProps.chrome.clearMirror).toHaveBeenCalledOnce();
  });

  it.each(['crew', 'not-driving', 'tracked-preview'] as const)('keeps %s navigation view-only', (kind) => {
    const initialProps = inputs();
    if (kind === 'crew') initialProps.navigation.browseByDefault = true;
    if (kind === 'tracked-preview') {
      initialProps.preview.drawerPreviewItem = item('preview');
      initialProps.preview.drawerPreviewSuggestionSource = source([item('preview'), item('next')]);
    }
    // The track this walk is on (the preview's own, or the committed climb's).
    const walked = initialProps.preview.drawerPreviewSuggestionSource ?? source([item('current'), item('next')]);
    initialProps.navigation.nextPreviewSource = walked;
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.handleNext('swipe'));
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(
      initialProps.navigation.navigationState.nextItem,
    );
    // The look keeps walking that list, in a crew too (#7227).
    expect(initialProps.preview.setDrawerPreviewSuggestionSource).toHaveBeenCalledWith(walked);
    expect(initialProps.queue.nextClimb).not.toHaveBeenCalled();
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(initialProps.preview.setDrawerPreviewIsWallClimb).toHaveBeenCalledWith(false);
  });

  it('consumes the end of a preview track without falling through to live navigation', () => {
    const initialProps = inputs();
    initialProps.navigation.browseByDefault = true;
    initialProps.navigation.navigationState.nextItem = null;
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.handleNext('swipe'));
    expect(initialProps.queue.nextClimb).not.toHaveBeenCalled();
    expect(initialProps.preview.setDrawerPreviewItem).not.toHaveBeenCalled();
    expect(initialProps.chrome.clearMirror).not.toHaveBeenCalled();
  });

  it('does not churn the previous callback when only the next target changes', () => {
    const initialProps = inputs();
    initialProps.navigation.driving = true;
    const { result, rerender } = renderHook(usePlaySelectionController, { initialProps });
    const previous = result.current.handlePrev;
    const next = result.current.handleNext;
    rerender({
      ...initialProps,
      navigation: {
        ...initialProps.navigation,
        navigationState: { ...initialProps.navigation.navigationState, nextItem: item('new-next') },
      },
    });
    expect(result.current.handlePrev).toBe(previous);
    expect(result.current.handleNext).not.toBe(next);
    act(() => result.current.handleNext('swipe'));
    expect(initialProps.queue.nextClimb).toHaveBeenCalledOnce();
  });

  describe('Queue Navigation steps (#6940)', () => {
    it.each([
      ['handlePrev', 'previous', 'button'],
      ['handleNext', 'next', 'button'],
      ['handlePrev', 'previous', 'swipe'],
      ['handleNext', 'next', 'swipe'],
    ] as const)('%s reports one moved %s step by %s', (handler, direction, method) => {
      const initialProps = inputs();
      initialProps.navigation.driving = true;
      const { result } = renderHook(usePlaySelectionController, { initialProps });
      act(() => result.current[handler](method));
      expect(initialProps.onNavigationStep).toHaveBeenCalledOnce();
      expect(initialProps.onNavigationStep).toHaveBeenCalledWith({ direction, method, outcome: 'moved' });
    });

    it.each(['crew', 'not-driving'] as const)('reports a %s step as a preview', (kind) => {
      const initialProps = inputs();
      if (kind === 'crew') initialProps.navigation.browseByDefault = true;
      const { result } = renderHook(usePlaySelectionController, { initialProps });
      act(() => result.current.handleNext('swipe'));
      expect(initialProps.onNavigationStep).toHaveBeenCalledOnce();
      expect(initialProps.onNavigationStep).toHaveBeenCalledWith({
        direction: 'next',
        method: 'swipe',
        outcome: 'preview',
      });
    });

    // The dead-swipe fix: a swipe that went before the climb's board had
    // painted says so, whichever way the step lands.
    it.each(['queue', 'crew preview', 'list preview', 'slot preview'] as const)(
      'carries what the board was still doing on a %s step',
      (kind) => {
        const artWait = { artState: 'loading' as const, waitedMs: 700 };
        const initialProps = inputs();
        // A step lights (moves) only while driving; the crew's look previews.
        if (kind === 'crew preview') initialProps.navigation.browseByDefault = true;
        else initialProps.navigation.driving = true;
        if (kind === 'list preview') {
          initialProps.preview.drawerPreviewItem = item('preview');
          initialProps.preview.drawerPreviewSuggestionSource = source([
            item('preview'),
            initialProps.navigation.navigationState.nextItem!,
          ]);
        }
        if (kind === 'slot preview') initialProps.preview.drawerPreviewItem = item('slot');
        const { result } = renderHook(usePlaySelectionController, { initialProps });
        act(() => result.current.handleNext('swipe', artWait));
        expect(initialProps.onNavigationStep).toHaveBeenCalledExactlyOnceWith({
          direction: 'next',
          method: 'swipe',
          outcome: kind === 'crew preview' ? 'preview' : 'moved',
          artWait,
        });
      },
    );

    it('reports nothing when there is nowhere to go', () => {
      const initialProps = inputs();
      initialProps.navigation.navigationState.nextItem = null;
      const crew = inputs();
      crew.navigation.browseByDefault = true;
      crew.navigation.navigationState.nextItem = null;
      for (const props of [initialProps, crew]) {
        const { result } = renderHook(usePlaySelectionController, { initialProps: props });
        act(() => result.current.handleNext('button'));
        expect(props.onNavigationStep).not.toHaveBeenCalled();
      }
    });
  });
});

describe('explicit wall commitment', () => {
  it('asks once before replacing a crew wall that moved during browsing', () => {
    const initialProps = inputs();
    initialProps.preview.drawerPreviewItem = item('preview');
    initialProps.navigation.browseByDefault = true;
    initialProps.confirmation.browseLatchActive = true;
    initialProps.confirmation.wallUuidAtLatchStartRef.current = 'old-wall';
    const { result, rerender } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.handleSetActive());
    // The first tap only arms the question: nothing is sent, the latch holds,
    // and the question row says it out loud when it mounts, not this hook.
    expect(initialProps.confirmation.setBusyWallConfirmArmed).toHaveBeenCalledWith(true);
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(initialProps.confirmation.markLatchExit).not.toHaveBeenCalled();
    expect(initialProps.preview.setDrawerPreviewItem).not.toHaveBeenCalled();
    expect(authority.announce).not.toHaveBeenCalled();
    rerender({ ...initialProps, confirmation: { ...initialProps.confirmation, busyWallConfirmArmed: true } });
    act(() => result.current.handleSetActive());
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledOnce();
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledWith(
      expect.objectContaining({ climb: expect.objectContaining({ uuid: 'preview' }) }),
      expect.objectContaining({ trigger: 'put_on_wall' }),
    );
    expect(initialProps.confirmation.setBusyWallConfirmArmed).toHaveBeenLastCalledWith(false);
    expect(initialProps.confirmation.markLatchExit).toHaveBeenCalledWith('commit');
    expect(initialProps.preview.setSharedBrowseLatched).toHaveBeenCalledWith(false);
    expect(initialProps.preview.setDrawerPreviewSuggestionSource).toHaveBeenCalledWith(null);
    expect(initialProps.preview.setDrawerPreviewIsWallClimb).toHaveBeenCalledWith(false);
    expect(initialProps.chrome.clearMirror).toHaveBeenCalledOnce();
  });

  // In a crew a queue row or Replay from here always opens as a preview that
  // defers its commit, so this is the main path a deferred commit takes there:
  // the press that only raises the question must keep the slot's options for
  // Put mine up, or the climb goes up as a plain look and History's order is lost.
  it('keeps a deferred commit through the busy-wall question, then commits it once with its options', () => {
    const slot = item('history');
    const initialProps = inputs();
    initialProps.preview.drawerPreviewItem = slot;
    initialProps.navigation.browseByDefault = true;
    initialProps.confirmation.browseLatchActive = true;
    initialProps.confirmation.wallUuidAtLatchStartRef.current = 'old-wall';
    initialProps.openTarget = open(slot, {
      previewQueueItem: slot,
      previewCommitOptions: { placement: 'STEP', playlistSuggestionSource: null },
    });
    const { result, rerender } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.handleSetActive());
    expect(initialProps.confirmation.setBusyWallConfirmArmed).toHaveBeenCalledWith(true);
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
    rerender({ ...initialProps, confirmation: { ...initialProps.confirmation, busyWallConfirmArmed: true } });
    act(() => result.current.handleSetActive());
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(slot, {
      placement: 'STEP',
      playlistSuggestionSource: null,
      trigger: 'put_on_wall',
    });
  });

  it.each(['ios', 'android'] as const)('leaves the busy-wall question to the question row on %s', (platform) => {
    authority.platform = platform;
    const initialProps = inputs();
    initialProps.preview.drawerPreviewItem = item('preview');
    initialProps.navigation.browseByDefault = true;
    initialProps.confirmation.browseLatchActive = true;
    initialProps.confirmation.wallUuidAtLatchStartRef.current = 'old-wall';
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.handleSetActive());
    expect(initialProps.confirmation.setBusyWallConfirmArmed).toHaveBeenCalledWith(true);
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(authority.announce).not.toHaveBeenCalled();
  });

  it('tells Put on the wall apart from a plain pick, and goes straight up on an unmoved wall', () => {
    const initialProps = inputs();
    initialProps.preview.drawerPreviewItem = item('preview');
    initialProps.navigation.browseByDefault = true;
    initialProps.confirmation.browseLatchActive = true;
    // The wall still shows what it showed when browsing began: nothing to ask.
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.handleSetActive());
    expect(initialProps.confirmation.setBusyWallConfirmArmed).not.toHaveBeenCalledWith(true);
    // A trackless look: the provider decides whether the committed list keeps
    // going after it (#6777), and clears it otherwise.
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledWith(
      expect.objectContaining({ climb: expect.objectContaining({ uuid: 'preview' }) }),
      { keepWalkedTrack: true, trigger: 'put_on_wall' },
    );
    expect(initialProps.preview.setSharedBrowseLatched).toHaveBeenCalledWith(false);
  });

  it('launders transient suggestions and reanchors the source on the committed climb', () => {
    const initialProps = inputs();
    const preview = { ...item('preview'), uuid: 'playlist-peek:preview', suggested: true };
    initialProps.preview.drawerPreviewItem = preview;
    initialProps.preview.drawerPreviewSuggestionSource = source([item('start'), preview, item('end')]);
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.handleSetActive());
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledWith(
      expect.objectContaining({
        uuid: 'selection-1',
        suggested: true,
        climb: expect.objectContaining({ uuid: 'preview' }),
      }),
      {
        playlistSuggestionSource: expect.objectContaining({ activatedClimbUuid: 'preview' }),
        // A step along the list, as Next takes it: the provider keeps the queue
        // when the walk went through Up next (#7227).
        keepQueue: true,
        // A peek is a step along the list: a fresh copy, as Next places one.
        historyCopy: 'fresh',
        trigger: 'put_on_wall',
      },
    );
  });

  // A list tap's own climb is not a peek: it goes up as a tap does, with no
  // fresh copy. It asks to keep the queue as a step would, which the provider
  // grants only to a climb already in it or a list that went through Up next
  // (#7227), so a list tap's fresh climb still prunes after it.
  it('puts a tapped list climb up without the step rule', () => {
    const initialProps = inputs();
    initialProps.preview.drawerPreviewItem = item('preview');
    initialProps.preview.drawerPreviewSuggestionSource = source([item('preview'), item('end')]);
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => {
      result.current.handleSetActive();
    });
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledWith(expect.anything(), {
      playlistSuggestionSource: expect.objectContaining({ activatedClimbUuid: 'preview' }),
      keepQueue: true,
      trigger: 'put_on_wall',
    });
  });

  // #7227: outside a drive, a swipe off the climb on the wall is a look that
  // carries the list the walk is on. It used to carry none, so the look walked
  // only the queue and stopped at its end, or one climb past the wall's.
  it.each([
    ['handleNext', 'nextItem', 'nextPreviewSource'],
    ['handlePrev', 'prevItem', 'previousPreviewSource'],
  ] as const)('%s off the climb on the wall keeps walking its list', (handler, target, stepSource) => {
    const initialProps = inputs();
    const peek = { ...item('step'), uuid: 'playlist-peek:step', suggested: true };
    const list = {
      ...source([item('current'), peek]),
      resume: { climbUuid: 'current', queueItemUuid: 'queue-current' },
    };
    initialProps.navigation.navigationState = { ...initialProps.navigation.navigationState, [target]: peek };
    initialProps.navigation[stepSource] = list;
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current[handler]('swipe'));
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(peek);
    expect(initialProps.preview.setDrawerPreviewSuggestionSource).toHaveBeenCalledExactlyOnceWith(list);
    // A look: nothing written, nothing lit.
    expect(initialProps.queue.nextClimb).not.toHaveBeenCalled();
    expect(initialProps.queue.previousClimb).not.toHaveBeenCalled();
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
  });

  it('puts the look up with the list it walked, as Next would leave it', () => {
    const initialProps = inputs();
    const peek = { ...item('next'), uuid: 'playlist-peek:next', suggested: true };
    const list = source([item('current'), peek]);
    initialProps.preview.drawerPreviewItem = peek;
    initialProps.preview.drawerPreviewSuggestionSource = list;
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => {
      result.current.handleSetActive();
    });
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'selection-1', climb: expect.objectContaining({ uuid: 'next' }) }),
      {
        playlistSuggestionSource: expect.objectContaining({ playlistUuid: 'playlist', activatedClimbUuid: 'next' }),
        // Leaving the queue as Next does: a workout the walk played in Up next
        // stays queued (#7227).
        keepQueue: true,
        // A step along the list, placed as Next places one: a fresh copy, never
        // an older entry of the climb pulled out of History.
        historyCopy: 'fresh',
        trigger: 'put_on_wall',
      },
    );
  });

  // #7113 QA: a peek on screen with no list of its own (a MiniPlayer pick
  // reopened from an older look). Put on board used to send
  // `playlistSuggestionSource: null`, dropping "Search results · 4 of 23".
  it('hands a peek with no list of its own to the provider to keep the list', () => {
    const initialProps = inputs();
    const peek = { ...item('next'), uuid: 'playlist-peek:next', suggested: true };
    initialProps.preview.drawerPreviewItem = peek;
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => {
      result.current.handleSetActive();
    });
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'selection-1', climb: expect.objectContaining({ uuid: 'next' }) }),
      { keepWalkedTrack: true, walkedPeek: true, historyCopy: 'fresh', trigger: 'put_on_wall' },
    );
  });

  // #5403: a crew browse open of a list climb (a peer's tick) is no peek.
  it('never marks a fresh look, such as a peer tick, as the walk peek', () => {
    const initialProps = inputs();
    initialProps.navigation.browseByDefault = true;
    initialProps.preview.drawerPreviewItem = item('tick');
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => {
      result.current.handleSetActive();
    });
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledWith(
      expect.objectContaining({ climb: expect.objectContaining({ uuid: 'tick' }) }),
      { keepWalkedTrack: true, trigger: 'put_on_wall' },
    );
  });

  it('leaves absent or mismatched relay targets untouched', () => {
    const initialProps = inputs();
    const { result, rerender } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.commitDisplayedToWall());
    rerender({
      ...initialProps,
      showBoardMismatch: true,
      preview: { ...initialProps.preview, drawerPreviewItem: item('foreign') },
    });
    act(() => result.current.commitDisplayedToWall());
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
  });
});

// Issue #6665: a similar climb plays from the similar-climbs strip, and the
// tap never appends it to the end of the queue.
describe('similar-climb selection', () => {
  const strip = () => [item('similar-a').climb, item('similar').climb, item('similar-b').climb] as Climb[];

  it.each(['anonymous, driving', 'a crew', 'solo, not driving', 'another board, driving'] as const)(
    'previews with the strip as its track for %s',
    (kind) => {
      const initialProps = inputs();
      // The signed-out reader and the other board preview even while driving.
      if (kind.endsWith('driving') && !kind.includes('not')) initialProps.navigation.driving = true;
      if (kind.startsWith('anonymous')) initialProps.viewer = 'anonymous';
      if (kind === 'a crew') initialProps.navigation.browseByDefault = true;
      if (kind.startsWith('another board')) initialProps.showBoardMismatch = true;
      const { result } = renderHook(usePlaySelectionController, { initialProps });

      act(() => result.current.handleSimilarClimbPress(item('similar').climb as Climb, strip()));

      expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(
        expect.objectContaining({ climb: expect.objectContaining({ uuid: 'similar' }) }),
      );
      expect(initialProps.preview.setDrawerPreviewSuggestionSource).toHaveBeenCalledWith(
        expect.objectContaining({
          playlistUuid: 'similar:preview',
          activatedClimbUuid: 'similar',
          boardKey: 'kilter:1:10:1,2',
          label: 'Similar climbs',
          climbs: strip(),
        }),
      );
      expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
    },
  );

  it('puts the climb up while driving, playing from the strip, without appending it to the queue', () => {
    const initialProps = inputs();
    initialProps.navigation.driving = true;
    const { result } = renderHook(usePlaySelectionController, { initialProps });

    act(() => result.current.handleSimilarClimbPress(item('similar').climb as Climb, strip()));

    // setCurrentClimb inserts after the current climb; nothing goes to the end.
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledTimes(1);
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledWith(
      expect.objectContaining({ suggested: true, climb: expect.objectContaining({ uuid: 'similar' }) }),
      {
        playlistSuggestionSource: expect.objectContaining({
          activatedClimbUuid: 'similar',
          label: 'Similar climbs',
          climbs: strip(),
        }),
      },
    );
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(null);
    expect(initialProps.preview.setDrawerPreviewSuggestionSource).toHaveBeenCalledWith(null);
    expect(initialProps.chrome.setIsTickBarActive).toHaveBeenCalledWith(false);
  });

  // An upsized climb, or a tick from another size of the layout, is drawn on a
  // board that is not the stored active one. The queue masks a track whose key
  // is not the active board's, so a commit keyed to the drawn board would go
  // dormant at once and swipes would walk the queue.
  it('keys a committed strip to the active board, and a preview to the board the climb is drawn on', () => {
    const committedProps = inputs();
    committedProps.navigation.driving = true;
    committedProps.similarTrack = {
      boardKey: 'kilter:1:14:1,2',
      committedBoardKey: 'kilter:1:10:1,2',
      label: 'Similar climbs',
    };
    const committed = renderHook(usePlaySelectionController, { initialProps: committedProps });

    act(() => committed.result.current.handleSimilarClimbPress(item('similar').climb as Climb, strip()));

    expect(committedProps.queue.setCurrentClimb).toHaveBeenCalledWith(expect.anything(), {
      playlistSuggestionSource: expect.objectContaining({ boardKey: 'kilter:1:10:1,2' }),
    });

    const previewProps = inputs();
    previewProps.navigation.browseByDefault = true;
    previewProps.similarTrack = committedProps.similarTrack;
    const preview = renderHook(usePlaySelectionController, { initialProps: previewProps });

    act(() => preview.result.current.handleSimilarClimbPress(item('similar').climb as Climb, strip()));

    expect(previewProps.preview.setDrawerPreviewSuggestionSource).toHaveBeenCalledWith(
      expect.objectContaining({ boardKey: 'kilter:1:14:1,2' }),
    );
  });

  it('keeps one handler across player moves and keys the track on the climb shown at tap time', () => {
    const initialProps = inputs();
    initialProps.navigation.driving = true;
    const { result, rerender } = renderHook(usePlaySelectionController, { initialProps });
    const firstHandler = result.current.handleSimilarClimbPress;

    rerender({ ...initialProps, confirmation: { ...initialProps.confirmation, displayedClimbUuid: 'moved-to' } });

    expect(result.current.handleSimilarClimbPress).toBe(firstHandler);
    act(() => result.current.handleSimilarClimbPress(item('similar').climb as Climb, strip()));
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledWith(expect.anything(), {
      playlistSuggestionSource: expect.objectContaining({ playlistUuid: 'similar:moved-to' }),
    });
  });
});

// Issue #6664: the end card's "Keep going with your queue" from a committed
// climb. It must never take a wall that a swipe from the same state would not.
describe('continuing into the queue from the end of a list', () => {
  it('commits the queued climb while driving, and leaves the list behind', () => {
    const initialProps = inputs();
    initialProps.navigation.driving = true;
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    const queued = item('queued');

    act(() => result.current.continueIntoQueue(queued));

    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledWith(queued, { playlistSuggestionSource: null });
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(null);
    expect(initialProps.preview.setDrawerPreviewSuggestionSource).toHaveBeenCalledWith(null);
    expect(initialProps.chrome.clearMirror).toHaveBeenCalled();
  });

  it('only previews the queued climb with a crew here, so the wall stays put', () => {
    const initialProps = inputs();
    initialProps.navigation.browseByDefault = true;
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    const queued = item('queued');

    act(() => result.current.continueIntoQueue(queued));

    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenLastCalledWith(queued);
    // A preview of a queued climb with no track walks the queue from there.
    expect(initialProps.preview.setDrawerPreviewSuggestionSource).toHaveBeenLastCalledWith(null);
  });

  it('only previews the queued climb outside a drive, solo too', () => {
    const initialProps = inputs();
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    const queued = item('queued');

    act(() => result.current.continueIntoQueue(queued));

    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenLastCalledWith(queued);
  });
});

// #7113: while this phone drives the wall, every change of climb commits and
// lights it, in a crew too. A climb from another board stays a preview.
describe('driving the wall', () => {
  function driving(): SelectionInputs {
    const props = inputs();
    props.navigation.driving = true;
    props.navigation.browseByDefault = true;
    return props;
  }
  const strip = () => [item('similar-a').climb, item('similar').climb, item('similar-b').climb] as Climb[];

  it.each(['handlePrev', 'handleNext'] as const)('%s in a crew moves the wall', (handler) => {
    const initialProps = driving();
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current[handler]('swipe'));
    expect(
      handler === 'handlePrev' ? initialProps.queue.previousClimb : initialProps.queue.nextClimb,
    ).toHaveBeenCalledOnce();
    expect(initialProps.onNavigationStep).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'moved' }));
  });

  it('commits the next climb on a tracked preview, keeping the list as its track', () => {
    const initialProps = driving();
    const next = initialProps.navigation.navigationState.nextItem!;
    initialProps.preview.drawerPreviewItem = item('preview');
    initialProps.preview.drawerPreviewSuggestionSource = source([item('preview'), next]);
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.handleNext('swipe'));
    expect(initialProps.queue.nextClimb).not.toHaveBeenCalled();
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledWith(
      expect.objectContaining({ climb: expect.objectContaining({ uuid: 'next' }) }),
      {
        playlistSuggestionSource: expect.objectContaining({ playlistUuid: 'playlist', activatedClimbUuid: 'next' }),
        // A queued target (no peek) goes up leaving the queue as it is (#7227).
        keepQueue: true,
        // A step, placed as Next places one: fresh, never pulled out of History.
        trigger: 'next',
        historyCopy: 'fresh',
      },
    );
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(null);
    expect(initialProps.preview.setDrawerPreviewSuggestionSource).toHaveBeenCalledWith(null);
    expect(initialProps.preview.setSharedBrowseLatched).toHaveBeenCalledWith(false);
    expect(initialProps.onNavigationStep).toHaveBeenCalledWith({
      direction: 'next',
      method: 'swipe',
      outcome: 'moved',
    });
  });

  // #7227 review: a drive that starts while a look stands on the list climb
  // (the look came back out of Up next, so its list holds only a detour). The
  // step into Up next must go up with the step's own place on the list, or the
  // committed list goes dormant at the queued climb and Up next ends it.
  it.each([
    ['handleNext', 'nextItem', 'nextPreviewSource'],
    ['handlePrev', 'prevItem', 'previousPreviewSource'],
  ] as const)('%s from a look commits the step with its own place in Up next', (handler, target, stepSource) => {
    const initialProps = driving();
    const upNext = initialProps.navigation.navigationState[target]!;
    const listClimb = item('list-climb');
    const resume = { climbUuid: 'list-climb', queueItemUuid: 'queue-list-climb' };
    const lookSource = { ...source([listClimb, item('list-next')]), detour: resume };
    initialProps.preview.drawerPreviewItem = listClimb;
    initialProps.preview.drawerPreviewSuggestionSource = lookSource;
    initialProps.navigation[stepSource] = { ...source([listClimb, item('list-next')]), resume };
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current[handler]('swipe'));
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ uuid: upNext.uuid }),
      expect.objectContaining({
        playlistSuggestionSource: expect.objectContaining({ playlistUuid: 'playlist', resume }),
        keepQueue: true,
      }),
    );
  });

  it('leaves a preview of a climb from another board a preview', () => {
    const initialProps = driving();
    initialProps.navigation.previewOnOtherBoard = true;
    initialProps.preview.drawerPreviewItem = item('preview');
    initialProps.preview.drawerPreviewSuggestionSource = source([item('preview'), item('next')]);
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.handleNext('swipe'));
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(initialProps.queue.nextClimb).not.toHaveBeenCalled();
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(
      initialProps.navigation.navigationState.nextItem,
    );
    expect(initialProps.onNavigationStep).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'preview' }));
  });

  // A stop ends the drive, Always drive the wall's included: swipes preview.
  it('once a stop ended the drive, solo swipes are previews', () => {
    const initialProps = inputs();
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.handleNext('swipe'));
    expect(initialProps.queue.nextClimb).not.toHaveBeenCalled();
    expect(initialProps.onNavigationStep).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'preview' }));
  });

  it('a fresh open in a crew puts the climb up instead of browsing', () => {
    const initialProps = driving();
    initialProps.openTarget = open(item('new'));
    renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledWith(
      expect.objectContaining({ climb: expect.objectContaining({ uuid: 'new' }) }),
      { playlistSuggestionSource: null },
    );
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(null);
  });

  it('Keep going with your queue in a crew takes the wall', () => {
    const initialProps = driving();
    const target = item('queued');
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.continueIntoQueue(target));
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledWith(target, { playlistSuggestionSource: null });
  });

  it('a similar climb in a crew goes up; on another board it stays a preview', () => {
    const crew = driving();
    const committed = renderHook(usePlaySelectionController, { initialProps: crew });
    act(() => committed.result.current.handleSimilarClimbPress(item('similar').climb as Climb, strip()));
    expect(crew.queue.setCurrentClimb).toHaveBeenCalledOnce();

    const otherBoard = driving();
    otherBoard.showBoardMismatch = true;
    const preview = renderHook(usePlaySelectionController, { initialProps: otherBoard });
    act(() => preview.result.current.handleSimilarClimbPress(item('similar').climb as Climb, strip()));
    expect(otherBoard.queue.setCurrentClimb).not.toHaveBeenCalled();
  });

  it('a similar climb solo goes up while driving', () => {
    const initialProps = driving();
    initialProps.navigation.browseByDefault = false;
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.handleSimilarClimbPress(item('similar').climb as Climb, strip()));
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledOnce();
  });

  it('never asks the busy-wall question of the climber who drives', () => {
    for (const props of [driving(), inputs()]) {
      props.preview.drawerPreviewItem = item('preview');
      props.navigation.browseByDefault = true;
      props.confirmation.browseLatchActive = true;
      props.confirmation.wallUuidAtLatchStartRef.current = 'old-wall';
      const { result } = renderHook(usePlaySelectionController, { initialProps: props });
      // Not driving yet: the swipe that starts a drive skips the question.
      act(() => {
        result.current.handleSetActive(props.navigation.driving ? {} : { skipBusyWall: true });
      });
      expect(props.confirmation.setBusyWallConfirmArmed).not.toHaveBeenCalledWith(true);
      expect(props.queue.setCurrentClimb).toHaveBeenCalledOnce();
    }
  });
});

// Put on board's keep-lighting window (2.7) is a live drive with an end. The
// player's render read it as driving, but Android pauses JS timers with the
// activity (#7038), so the watcher may not have ended it yet: every pick reads
// the wall clock, and a pick past the end stays a preview. The timers here
// never advance; only the clock moves.
describe('a keep-lighting window past its end', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 });
    enterDriveMode({
      startedBy: 'tap',
      sessionId: null,
      boardId: null,
      windowMs: 45_000,
      windowSetting: 'putOnBoardKeepsLighting',
      now: 1_000,
    });
    markDriveLive({ now: 1_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
    resetDriveModeForTests();
  });
  /** What the player rendered while the window was on: driving. */
  function windowInputs(): SelectionInputs {
    const props = inputs();
    props.navigation.driving = true;
    return props;
  }
  const lapse = () => vi.setSystemTime(46_000);

  it.each(['handlePrev', 'handleNext'] as const)('%s inside the window still moves the wall', (handler) => {
    const props = windowInputs();
    const { result } = renderHook(usePlaySelectionController, { initialProps: props });
    vi.setSystemTime(45_999);
    act(() => result.current[handler]('swipe'));
    expect(handler === 'handlePrev' ? props.queue.previousClimb : props.queue.nextClimb).toHaveBeenCalledOnce();
  });

  it.each(['handlePrev', 'handleNext'] as const)('%s past the end opens a preview, the wall untouched', (handler) => {
    const props = windowInputs();
    const { result } = renderHook(usePlaySelectionController, { initialProps: props });
    lapse();
    act(() => result.current[handler]('swipe'));
    expect(props.queue.previousClimb).not.toHaveBeenCalled();
    expect(props.queue.nextClimb).not.toHaveBeenCalled();
    expect(props.preview.setDrawerPreviewItem).toHaveBeenCalledWith(
      handler === 'handlePrev' ? props.navigation.navigationState.prevItem : props.navigation.navigationState.nextItem,
    );
    expect(props.onNavigationStep).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'preview' }));
    // The watcher, not the pick, ends the drive and tidies the button.
    expect(getDriveMode()?.phase).toBe('live');
  });

  it('a fresh open past the end is a preview', () => {
    const props = windowInputs();
    lapse();
    props.openTarget = open(item('new'));
    renderHook(usePlaySelectionController, { initialProps: props });
    expect(props.queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(props.preview.setDrawerPreviewItem).toHaveBeenCalledWith(
      expect.objectContaining({ climb: expect.objectContaining({ uuid: 'new' }) }),
    );
  });

  it('a similar climb past the end is a preview', () => {
    const props = windowInputs();
    const { result } = renderHook(usePlaySelectionController, { initialProps: props });
    lapse();
    act(() => result.current.handleSimilarClimbPress(item('similar').climb as Climb, [item('similar').climb as Climb]));
    expect(props.queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(props.preview.setDrawerPreviewItem).toHaveBeenCalledWith(
      expect.objectContaining({ climb: expect.objectContaining({ uuid: 'similar' }) }),
    );
  });

  it('Keep going with your queue past the end is a preview', () => {
    const props = windowInputs();
    const target = item('queued');
    const { result } = renderHook(usePlaySelectionController, { initialProps: props });
    lapse();
    act(() => result.current.continueIntoQueue(target));
    expect(props.queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(props.preview.setDrawerPreviewItem).toHaveBeenCalledWith(target);
  });
});

describe('preview-first host selections and deferred commits', () => {
  it('does not reactivate a stale accessory target when the current climb changes before opening', () => {
    const initialProps = { ...inputs(), openTarget: open(item('old-current'), { reopensCurrent: true }) };
    renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(initialProps.hold.putHeldClimbOnWall).not.toHaveBeenCalled();
  });

  it('keeps a fresh solo open in preview outside a drive', () => {
    const initialProps = { ...inputs(), openTarget: open(item('new')) };
    renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(
      expect.objectContaining({ climb: expect.objectContaining({ uuid: 'new' }) }),
    );
  });

  it('reopens the committed current slot, not a preview copy, outside a drive', () => {
    // The mini player and the workout card's current-climb row: the drawer must
    // show the committed queue item, whose uuid the workout stage label and the
    // timed block's Fell / Sent row key on.
    const initialProps = inputs();
    initialProps.hold.heldQueueItemUuid = initialProps.queue.currentClimbQueueItem!.uuid;
    initialProps.openTarget = open(initialProps.queue.currentClimbQueueItem!, { reopensCurrent: true });
    renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledExactlyOnceWith(null);
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(initialProps.hold.putHeldClimbOnWall).not.toHaveBeenCalled();
  });

  // The iPad host keeps its pane target, and each tab mounts its own pane: the
  // later pane shows what the first did, without a second pick.
  describe('a pane that mounts after the tap', () => {
    function sharedTarget(selected: ClimbQueueItem, options?: PlayDrawerOpenOptions) {
      let applied = false;
      return {
        ...open(selected, options),
        claimFirstApply: () => {
          if (applied) return false;
          applied = true;
          return true;
        },
      };
    }

    it.each([
      ['nothing drives the wall', () => {}, {}],
      ['the climb is on another board', () => {}, { showBoardMismatch: true }],
    ])('shows the same browse preview when %s', (_label, arrange, patch) => {
      arrange();
      const target = sharedTarget(item('new'));
      const first = { ...inputs(), ...patch, openTarget: target };
      renderHook(usePlaySelectionController, { initialProps: first });
      expect(first.preview.setDrawerPreviewItem).toHaveBeenCalledWith(
        expect.objectContaining({ climb: expect.objectContaining({ uuid: 'new' }) }),
      );

      const later = { ...inputs(), ...patch, openTarget: target };
      renderHook(usePlaySelectionController, { initialProps: later });
      expect(later.preview.setDrawerPreviewItem).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ climb: expect.objectContaining({ uuid: 'new' }) }),
      );
      expect(later.queue.setCurrentClimb).not.toHaveBeenCalled();
    });

    it('keeps the workout row reopening the committed slot', () => {
      const current = inputs().queue.currentClimbQueueItem!;
      const target = sharedTarget(current, { reopensCurrent: true });
      renderHook(usePlaySelectionController, { initialProps: { ...inputs(), openTarget: target } });
      const later = { ...inputs(), openTarget: target };
      renderHook(usePlaySelectionController, { initialProps: later });
      expect(later.preview.setDrawerPreviewItem).toHaveBeenCalledExactlyOnceWith(null);
      expect(later.queue.setCurrentClimb).not.toHaveBeenCalled();
    });

    it('never puts the tapped climb up again after the climber moved on', () => {
      const target = sharedTarget(item('new'));
      const first = { ...inputs(), openTarget: target };
      first.navigation.driving = true;
      renderHook(usePlaySelectionController, { initialProps: first });
      expect(first.queue.setCurrentClimb).toHaveBeenCalledOnce();

      // The current climb is still `current` here: the climber swiped on.
      const later = { ...inputs(), openTarget: target };
      later.navigation.driving = true;
      renderHook(usePlaySelectionController, { initialProps: later });
      expect(later.queue.setCurrentClimb).not.toHaveBeenCalled();
      expect(later.preview.setDrawerPreviewItem).toHaveBeenCalledExactlyOnceWith(null);
    });
  });

  it('does not relight an already-current held climb when it opens as preview', () => {
    const initialProps = inputs();
    initialProps.hold.heldQueueItemUuid = initialProps.queue.currentClimbQueueItem!.uuid;
    initialProps.openTarget = open(initialProps.queue.currentClimbQueueItem!);
    renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.hold.putHeldClimbOnWall).not.toHaveBeenCalled();
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(
      expect.objectContaining({ climb: initialProps.queue.currentClimbQueueItem!.climb }),
    );
  });

  it('commits the selected duplicate slot and clears the former playlist source', () => {
    const selected = { ...item('duplicate'), uuid: 'second-duplicate-slot' };
    const initialProps = inputs();
    initialProps.preview.drawerPreviewItem = selected;
    initialProps.openTarget = open(selected, {
      previewQueueItem: selected,
      previewCommitOptions: { playlistSuggestionSource: null },
    });
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
    act(() => result.current.handleSetActive());
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(selected, {
      playlistSuggestionSource: null,
      trigger: 'put_on_wall',
    });
  });

  it('keeps deferred replay placement when the same preview is re-anchored at another angle', () => {
    const selected = item('history');
    const initialProps = inputs();
    initialProps.preview.drawerPreviewItem = selected;
    initialProps.openTarget = open(selected, {
      previewQueueItem: selected,
      previewCommitOptions: { placement: 'STEP', playlistSuggestionSource: null },
    });
    const { result, rerender } = renderHook(usePlaySelectionController, { initialProps });
    const atAnotherAngle = { ...selected, climb: { ...selected.climb, angle: 45 } };
    rerender({ ...initialProps, preview: { ...initialProps.preview, drawerPreviewItem: atAnotherAngle } });
    act(() => result.current.handleSetActive());
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(atAnotherAngle, {
      placement: 'STEP',
      playlistSuggestionSource: null,
      trigger: 'put_on_wall',
    });
  });

  // A queue-sheet row (or Replay from here) opens its slot as a preview. While
  // driving, solo, a swipe from it commits the slot's own neighbour, the one
  // the peek showed, never the queue's next from the wall.
  it.each([
    ['handleNext', 'nextItem', 'next'],
    ['handlePrev', 'prevItem', 'previous'],
  ] as const)('%s from a queue-slot preview commits the slot’s neighbour the peek showed', (handler, side, trigger) => {
    const slot = item('slot-d');
    const initialProps = inputs();
    initialProps.navigation.driving = true;
    initialProps.navigation.navigationState = { prevItem: item('slot-c'), nextItem: item('slot-e') };
    initialProps.preview.drawerPreviewItem = slot;
    initialProps.openTarget = open(slot, {
      previewQueueItem: slot,
      previewCommitOptions: { placement: 'STEP', playlistSuggestionSource: null },
    });
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current[handler]('swipe'));
    expect(initialProps.queue.nextClimb).not.toHaveBeenCalled();
    expect(initialProps.queue.previousClimb).not.toHaveBeenCalled();
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(
      initialProps.navigation.navigationState[side],
      { keepWalkedTrack: true, trigger, historyCopy: 'fresh' },
    );
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenLastCalledWith(null);
    expect(initialProps.onNavigationStep).toHaveBeenCalledWith({
      direction: trigger,
      method: 'swipe',
      outcome: 'moved',
    });
  });

  it('keeps going through the queue from a preview with no neighbour of its own', () => {
    const orphan = item('deep-link');
    const initialProps = inputs();
    initialProps.navigation.driving = true;
    initialProps.navigation.navigationState = { prevItem: null, nextItem: null };
    initialProps.preview.drawerPreviewItem = orphan;
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.handleNext('swipe'));
    expect(initialProps.queue.nextClimb).toHaveBeenCalledOnce();
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
  });

  // The deferred options belong to the slot as it was opened: a swipe away and
  // back to the same slot is an ordinary browse, and Put on board then commits
  // it plainly, not with Replay from here's STEP.
  it('drops deferred replay placement after a swipe away and back to the same slot', () => {
    const history = item('history');
    const next = item('next');
    const initialProps = inputs();
    initialProps.navigation.navigationState = { prevItem: item('before'), nextItem: next };
    initialProps.preview.drawerPreviewItem = history;
    initialProps.openTarget = open(history, {
      previewQueueItem: history,
      previewCommitOptions: { placement: 'STEP', playlistSuggestionSource: null },
    });
    const { result, rerender } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.handleNext('swipe'));
    const atNext = {
      ...initialProps,
      preview: { ...initialProps.preview, drawerPreviewItem: next },
      navigation: { ...initialProps.navigation, navigationState: { prevItem: history, nextItem: item('after') } },
    };
    rerender(atNext);
    act(() => result.current.handlePrev('swipe'));
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenLastCalledWith(history);
    rerender({ ...atNext, preview: { ...atNext.preview, drawerPreviewItem: history } });
    act(() => result.current.handleSetActive());
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(history, {
      keepWalkedTrack: true,
      trigger: 'put_on_wall',
    });
  });

  it('keeps deferred options to their own slot when another climb is on screen', () => {
    const history = item('history');
    const other = item('other');
    const initialProps = inputs();
    initialProps.preview.drawerPreviewItem = history;
    initialProps.openTarget = open(history, {
      previewQueueItem: history,
      previewCommitOptions: { placement: 'STEP', playlistSuggestionSource: null },
    });
    const { result, rerender } = renderHook(usePlaySelectionController, { initialProps });
    rerender({ ...initialProps, preview: { ...initialProps.preview, drawerPreviewItem: other } });
    act(() => result.current.handleSetActive());
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(other, {
      keepWalkedTrack: true,
      trigger: 'put_on_wall',
    });
  });

  it('does not carry deferred replay placement to a climb reached by Next', () => {
    const selected = item('history');
    const initialProps = inputs();
    initialProps.preview.drawerPreviewItem = selected;
    initialProps.openTarget = open(selected, {
      previewQueueItem: selected,
      previewCommitOptions: { placement: 'STEP', playlistSuggestionSource: null },
    });
    const { result, rerender } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.handleNext('button'));
    const next = initialProps.navigation.navigationState.nextItem;
    rerender({ ...initialProps, preview: { ...initialProps.preview, drawerPreviewItem: next } });
    act(() => result.current.handleSetActive());
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledExactlyOnceWith(next, {
      keepWalkedTrack: true,
      trigger: 'put_on_wall',
    });
  });
});

// Owner decision A: every open the player applies is reported, so the player
// can keep the climber's last pick and run the MiniPlayer bulb's Put on board.
describe('the applied open (the last pick)', () => {
  it('reports a preview open with its list, its deferred commit and its busy-wall snapshot', () => {
    const initialProps = inputs();
    const onOpenApplied = vi.fn();
    initialProps.onOpenApplied = onOpenApplied;
    const preview = item('preview');
    const track = source([preview, item('next')]);
    const commitOptions = { placement: 'STEP' as const };
    const latchStart = { wallClimbUuid: 'wall-at-pick', at: 1_000 };
    initialProps.openTarget = open(preview, {
      previewQueueItem: preview,
      playlistSuggestionSource: track,
      previewCommitOptions: commitOptions,
      previewLatchStart: latchStart,
    });
    renderHook(usePlaySelectionController, { initialProps });
    expect(onOpenApplied).toHaveBeenCalledWith({
      previewItem: preview,
      suggestionSource: track,
      commitOptions,
      mirrored: false,
      replay: false,
      latchStart,
      putOnBoard: false,
    });
  });

  it('reports a committed open as no preview', () => {
    const initialProps = inputs();
    const onOpenApplied = vi.fn();
    initialProps.onOpenApplied = onOpenApplied;
    initialProps.openTarget = open(initialProps.queue.currentClimbQueueItem!, { reopensCurrent: true });
    renderHook(usePlaySelectionController, { initialProps });
    expect(onOpenApplied).toHaveBeenCalledWith(expect.objectContaining({ previewItem: null, putOnBoard: false }));
  });

  it('puts the pick’s mirror flip back, and only when it differs from the climb’s own', () => {
    const flipped = inputs();
    const preview = item('preview');
    flipped.onOpenApplied = vi.fn();
    flipped.openTarget = open(preview, { previewQueueItem: preview, previewMirrored: true });
    renderHook(usePlaySelectionController, { initialProps: flipped });
    expect(flipped.chrome.restoreMirror).toHaveBeenCalledWith('preview', true);
    expect(flipped.onOpenApplied).toHaveBeenCalledWith(expect.objectContaining({ mirrored: true }));

    const straight = inputs();
    straight.openTarget = open(preview, { previewQueueItem: preview, previewMirrored: false });
    renderHook(usePlaySelectionController, { initialProps: straight });
    expect(straight.chrome.restoreMirror).not.toHaveBeenCalled();
  });

  it('asks for Put on board only on a fresh open of a preview, never on a pane’s replay', () => {
    const preview = item('preview');
    const fresh = inputs();
    fresh.onOpenApplied = vi.fn();
    fresh.openTarget = open(preview, { previewQueueItem: preview, putOnBoard: true });
    renderHook(usePlaySelectionController, { initialProps: fresh });
    expect(fresh.onOpenApplied).toHaveBeenCalledWith(expect.objectContaining({ putOnBoard: true, replay: false }));

    const replayed = inputs();
    replayed.onOpenApplied = vi.fn();
    replayed.openTarget = {
      ...open(preview, { previewQueueItem: preview, putOnBoard: true }),
      claimFirstApply: () => false,
    };
    renderHook(usePlaySelectionController, { initialProps: replayed });
    expect(replayed.onOpenApplied).toHaveBeenCalledWith(expect.objectContaining({ putOnBoard: false, replay: true }));
  });
});
