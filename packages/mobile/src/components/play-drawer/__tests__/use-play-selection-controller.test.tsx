// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';
import type { PlayDrawerOpenOptions } from '../play-drawer-types';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { usePlaySelectionController } from '../use-play-selection-controller';
import { setSetting } from '../../../settings/hooks';

const authority = vi.hoisted(() => ({ privacy: 0, uuid: 0, platform: 'ios', announce: vi.fn() }));
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: authority.announce },
  Platform: {
    get OS() {
      return authority.platform;
    },
  },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => `selection-${++authority.uuid}` }));
vi.mock('../../../lib/privacy/privacy-cache', () => ({ getPrivacyRevocationGeneration: () => authority.privacy }));

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
      lightOnSwipe: true,
      browseByDefault: false,
    },
    chrome: {
      clearMirror: vi.fn(),
      resetFavoriteOverride: vi.fn(),
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
  };
}
function open(selected: ClimbQueueItem, options?: PlayDrawerOpenOptions) {
  return { climb: selected.climb as Climb, nonce: 1, options };
}

beforeEach(() => {
  authority.privacy = 0;
  authority.uuid = 0;
  authority.platform = 'ios';
  authority.announce.mockClear();
  setSetting('lightOnClimbTap', true);
});

describe('host target application', () => {
  it('commits a genuinely new solo open and resets its chrome', () => {
    const initialProps = { ...inputs(), openTarget: open(item('new')) };
    renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledWith(
      expect.objectContaining({ climb: expect.objectContaining({ uuid: 'new' }) }),
      { playlistSuggestionSource: null },
    );
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(null);
    expect(initialProps.preview.setSharedBrowseLatched).toHaveBeenCalledWith(false);
    expect(initialProps.chrome.resetFavoriteOverride).toHaveBeenCalledOnce();
    expect(initialProps.chrome.setIsTickBarActive).toHaveBeenCalledWith(false);
    expect(initialProps.chrome.setActiveSubDrawer).toHaveBeenCalledWith('none');
    expect(initialProps.chrome.clearMirror).toHaveBeenCalledOnce();
  });

  it.each(['already-current', 'committed-externally'] as const)('does not append an %s open', (kind) => {
    const initialProps = inputs();
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
    const { rerender } = renderHook(usePlaySelectionController, { initialProps });
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledOnce();
    const crew = { ...initialProps, navigation: { ...initialProps.navigation, browseByDefault: true } };
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
  it.each(['handlePrev', 'handleNext'] as const)('%s preserves the live queue path', (handler) => {
    const initialProps = inputs();
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current[handler]());
    expect(
      handler === 'handlePrev' ? initialProps.queue.previousClimb : initialProps.queue.nextClimb,
    ).toHaveBeenCalledOnce();
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(null);
    expect(initialProps.preview.setDrawerPreviewIsWallClimb).toHaveBeenCalledWith(false);
    expect(initialProps.chrome.clearMirror).toHaveBeenCalledOnce();
  });

  it.each(['crew', 'lighting-off', 'tracked-preview'] as const)('keeps %s navigation view-only', (kind) => {
    const initialProps = inputs();
    if (kind === 'crew') initialProps.navigation.browseByDefault = true;
    if (kind === 'lighting-off') initialProps.navigation.lightOnSwipe = false;
    if (kind === 'tracked-preview') {
      initialProps.preview.drawerPreviewItem = item('preview');
      initialProps.preview.drawerPreviewSuggestionSource = source([item('preview'), item('next')]);
    }
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.handleNext());
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenCalledWith(
      initialProps.navigation.navigationState.nextItem,
    );
    expect(initialProps.queue.nextClimb).not.toHaveBeenCalled();
    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(initialProps.preview.setDrawerPreviewIsWallClimb).toHaveBeenCalledWith(false);
  });

  it('consumes the end of a preview track without falling through to live navigation', () => {
    const initialProps = inputs();
    initialProps.navigation.browseByDefault = true;
    initialProps.navigation.navigationState.nextItem = null;
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    act(() => result.current.handleNext());
    expect(initialProps.queue.nextClimb).not.toHaveBeenCalled();
    expect(initialProps.preview.setDrawerPreviewItem).not.toHaveBeenCalled();
    expect(initialProps.chrome.clearMirror).not.toHaveBeenCalled();
  });

  it('does not churn the previous callback when only the next target changes', () => {
    const initialProps = inputs();
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
    act(() => result.current.handleNext());
    expect(initialProps.queue.nextClimb).toHaveBeenCalledOnce();
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
    expect(initialProps.queue.setCurrentClimb).toHaveBeenCalledWith(
      expect.objectContaining({ climb: expect.objectContaining({ uuid: 'preview' }) }),
      { playlistSuggestionSource: null, trigger: 'put_on_wall' },
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
      { playlistSuggestionSource: expect.objectContaining({ activatedClimbUuid: 'preview' }), trigger: 'put_on_wall' },
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

  it.each(['anonymous', 'crew', 'light-on-tap off', 'another board'] as const)(
    'previews with the strip as its track for %s',
    (kind) => {
      const initialProps = inputs();
      if (kind === 'anonymous') initialProps.viewer = 'anonymous';
      if (kind === 'crew') initialProps.navigation.browseByDefault = true;
      if (kind === 'light-on-tap off') setSetting('lightOnClimbTap', false);
      if (kind === 'another board') initialProps.showBoardMismatch = true;
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

  it('puts the climb up solo, playing from the strip, without appending it to the queue', () => {
    const initialProps = inputs();
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
  it('commits the queued climb solo, and leaves the list behind', () => {
    const initialProps = inputs();
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

  it('only previews the queued climb with Light on swipe off', () => {
    const initialProps = inputs();
    initialProps.navigation.lightOnSwipe = false;
    const { result } = renderHook(usePlaySelectionController, { initialProps });
    const queued = item('queued');

    act(() => result.current.continueIntoQueue(queued));

    expect(initialProps.queue.setCurrentClimb).not.toHaveBeenCalled();
    expect(initialProps.preview.setDrawerPreviewItem).toHaveBeenLastCalledWith(queued);
  });
});
