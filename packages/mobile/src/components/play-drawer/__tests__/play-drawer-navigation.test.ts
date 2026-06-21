import { describe, expect, it } from 'vitest';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { getViewOnlyPreviewNavigationTarget } from '../play-drawer-navigation';

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
});
