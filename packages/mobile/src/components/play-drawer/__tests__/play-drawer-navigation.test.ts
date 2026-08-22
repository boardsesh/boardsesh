import { describe, expect, it } from 'vitest';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import {
  getSimilarClimbTapMode,
  getViewOnlyPreviewNavigationTarget,
  getSwipeNavigationTarget,
  swipeStaysViewOnly,
} from '../play-drawer-navigation';

function makeItem(id: string): ClimbQueueItem {
  return {
    uuid: `queue-${id}`,
    climb: {
      uuid: `climb-${id}`,
      name: `Climb ${id}`,
      frames: 'p1r12',
      setter_username: 'setter',
      angle: 40,
      ascensionist_count: 0,
      difficulty: 'V3',
      quality_average: '3.0',
      stars: 3,
      difficulty_error: '0.3',
      benchmark_difficulty: null,
    },
  };
}

function makePreviewSource(currentItem: ClimbQueueItem): PlaylistSuggestionSource {
  return {
    playlistUuid: 'playlist:pl-1',
    activatedClimbUuid: currentItem.climb.uuid,
    boardKey: 'tension:9:5:1,2',
    climbs: [currentItem.climb],
  };
}

describe('getViewOnlyPreviewNavigationTarget', () => {
  it('returns the previous preview item in view-only mode so callers do not fall through to queue navigation', () => {
    const currentItem = makeItem('current');
    const previousItem = makeItem('previous');
    const previewSource = makePreviewSource(currentItem);

    expect(
      getViewOnlyPreviewNavigationTarget({
        previewItem: currentItem,
        previewSuggestionSource: previewSource,
        targetItem: previousItem,
      }),
    ).toEqual({ viewOnly: true, targetItem: previousItem });
  });

  it('consumes view-only navigation even when there is no target item', () => {
    const currentItem = makeItem('current');
    const previewSource = makePreviewSource(currentItem);

    expect(
      getViewOnlyPreviewNavigationTarget({
        previewItem: currentItem,
        previewSuggestionSource: previewSource,
        targetItem: null,
      }),
    ).toEqual({ viewOnly: true, targetItem: null });
  });

  it('returns a non-view-only result when there is no preview source', () => {
    expect(
      getViewOnlyPreviewNavigationTarget({
        previewItem: makeItem('current'),
        previewSuggestionSource: null,
        targetItem: makeItem('previous'),
      }),
    ).toEqual({ viewOnly: false });
  });

  it('returns a non-view-only result when the preview source exists without a preview item', () => {
    const currentItem = makeItem('current');
    const previewSource = makePreviewSource(currentItem);

    expect(
      getViewOnlyPreviewNavigationTarget({
        previewItem: null,
        previewSuggestionSource: previewSource,
        targetItem: makeItem('previous'),
      }),
    ).toEqual({ viewOnly: false });
  });

  it('forceViewOnly (lightOnSwipe off) goes view-only even with no preview item or source yet', () => {
    // The first swipe away from a real committed climb — there is no
    // pre-existing preview to chain from, unlike the wrong-board path above.
    expect(
      getViewOnlyPreviewNavigationTarget({
        previewItem: null,
        previewSuggestionSource: null,
        targetItem: makeItem('next'),
        forceViewOnly: true,
      }),
    ).toEqual({ viewOnly: true, targetItem: makeItem('next') });
  });

  it('forceViewOnly consumes navigation even when there is no target item', () => {
    expect(
      getViewOnlyPreviewNavigationTarget({
        previewItem: null,
        previewSuggestionSource: null,
        targetItem: null,
        forceViewOnly: true,
      }),
    ).toEqual({ viewOnly: true, targetItem: null });
  });

  it('defaults forceViewOnly to false, preserving prior callers that omit it', () => {
    expect(
      getViewOnlyPreviewNavigationTarget({
        previewItem: null,
        previewSuggestionSource: null,
        targetItem: makeItem('next'),
      }),
    ).toEqual({ viewOnly: false });
  });
});

describe('getSwipeNavigationTarget', () => {
  // This is the exact call PlayDrawer's handlePrev/handleNext make — it exists
  // so the lightOnSwipe -> forceViewOnly wiring is unit-tested without needing
  // to render PlayDrawer (impractical; see IpadPlayPane.test.tsx, which mocks
  // it out).
  it('goes view-only with lightOnSwipe off, even on the very first swipe (no prior preview)', () => {
    const nextItem = makeItem('next');
    expect(
      getSwipeNavigationTarget({
        previewItem: null,
        previewSuggestionSource: null,
        targetItem: nextItem,
        lightOnSwipe: false,
      }),
    ).toEqual({ viewOnly: true, targetItem: nextItem });
  });

  it('stays live with lightOnSwipe on and no wrong-board preview in progress', () => {
    expect(
      getSwipeNavigationTarget({
        previewItem: null,
        previewSuggestionSource: null,
        targetItem: makeItem('next'),
        lightOnSwipe: true,
      }),
    ).toEqual({ viewOnly: false });
  });

  it('still honors the wrong-board preview chain when lightOnSwipe is on', () => {
    const currentItem = makeItem('current');
    const nextItem = makeItem('next');
    const previewSource = makePreviewSource(currentItem);
    expect(
      getSwipeNavigationTarget({
        previewItem: currentItem,
        previewSuggestionSource: previewSource,
        targetItem: nextItem,
        lightOnSwipe: true,
      }),
    ).toEqual({ viewOnly: true, targetItem: nextItem });
  });
});

// What the wall-state chrome is allowed to claim. The pill ("Browsing"), the
// viewfinder brackets and the commit row all promise the wall stays where it is;
// that sentence is only true while the NEXT swipe is view-only, and being in a
// preview is not enough on its own.
describe('swipeStaysViewOnly', () => {
  it('is false for a preview whose next swipe would commit and light the wall', () => {
    const currentItem = makeItem('current');

    // The explicit "Preview" climb action, a deep link, the workout builder: a
    // pinned preview with NO suggestion source. With lightOnSwipe on, the swipe
    // handlers fall straight through to setCurrentClimb — the shared-queue write
    // and BLE re-arm the browse chrome would be denying.
    expect(swipeStaysViewOnly({ previewItem: currentItem, previewSuggestionSource: null, lightOnSwipe: true })).toBe(
      false,
    );
  });

  it('is true when the lightOnSwipe setting is off — no swipe drives the wall', () => {
    expect(swipeStaysViewOnly({ previewItem: null, previewSuggestionSource: null, lightOnSwipe: false })).toBe(true);
  });

  it('is true for a suggestion-sourced preview, which navigates within itself', () => {
    const currentItem = makeItem('current');

    expect(
      swipeStaysViewOnly({
        previewItem: currentItem,
        previewSuggestionSource: makePreviewSource(currentItem),
        lightOnSwipe: true,
      }),
    ).toBe(true);
  });

  it('agrees with the swipe handlers it is derived from, whatever the target', () => {
    const currentItem = makeItem('current');
    const nextItem = makeItem('next');

    for (const lightOnSwipe of [true, false]) {
      for (const previewSuggestionSource of [null, makePreviewSource(currentItem)]) {
        expect(swipeStaysViewOnly({ previewItem: currentItem, previewSuggestionSource, lightOnSwipe })).toBe(
          getSwipeNavigationTarget({
            previewItem: currentItem,
            previewSuggestionSource,
            targetItem: nextItem,
            lightOnSwipe,
          }).viewOnly,
        );
      }
    }
  });
});

describe('getSimilarClimbTapMode', () => {
  it('queues and activates for a signed-in member', () => {
    expect(getSimilarClimbTapMode('member')).toBe('queue');
  });

  // The affordance the anonymous drawer keeps that could still write. Similar
  // Climbs is a read worth keeping, but its member tap does two things a
  // signed-out reader must not get: it writes the local queue (a list they
  // cannot carry anywhere, next to a queue button that is hidden) and it calls
  // `setCurrentClimb`, which re-arms the BLE auto-sender and pushes the climb to
  // a connected board. The lightbulb is hidden for exactly that reason; this is
  // the back door into the same behaviour.
  it('only swaps the preview for a signed-out reader — no queue write, no BLE re-arm', () => {
    expect(getSimilarClimbTapMode('anonymous')).toBe('preview');
  });
});
