import { describe, it, expect } from 'vitest';
import type { Climb } from '@boardsesh/queue';
import { findNextQueueItemWithSuggestions } from '@boardsesh/play-view';
import { createBoardFeedSuggestionSource, BOARD_FEED_SUGGESTION_SOURCE_ID } from '../board-feed-suggestion-source';

function makeClimb(uuid: string, boardType = 'tension', layoutId = 8): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: 'p1r12',
    setter_username: 'setter',
    angle: 40,
    ascensionist_count: 0,
    difficulty: 'V3',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0.3',
    benchmark_difficulty: null,
    boardType,
    layoutId,
  };
}

const BOARD_KEY = 'tension:8:12:1,2';

describe('createBoardFeedSuggestionSource', () => {
  it('returns null for an empty feed so the caller can retry', () => {
    expect(
      createBoardFeedSuggestionSource({ anchorClimb: makeClimb('anchor'), feedClimbs: [], boardKey: BOARD_KEY }),
    ).toBeNull();
  });

  it('puts an anchor the feed does not contain at the head', () => {
    const anchorClimb = makeClimb('kilter-anchor', 'kilter', 1);
    const feedClimbs = [makeClimb('tension-1'), makeClimb('tension-2')];
    const source = createBoardFeedSuggestionSource({ anchorClimb, feedClimbs, boardKey: BOARD_KEY });
    expect(source?.climbs.map((climb) => climb.uuid)).toEqual(['kilter-anchor', 'tension-1', 'tension-2']);
    expect(source?.activatedClimbUuid).toBe('kilter-anchor');
    expect(source?.boardKey).toBe(BOARD_KEY);
    expect(source?.playlistUuid).toBe(BOARD_FEED_SUGGESTION_SOURCE_ID);
  });

  it('leaves the feed order untouched when it already contains the anchor', () => {
    const anchorClimb = makeClimb('tension-1');
    const feedClimbs = [makeClimb('tension-0'), anchorClimb, makeClimb('tension-2')];
    const source = createBoardFeedSuggestionSource({ anchorClimb, feedClimbs, boardKey: BOARD_KEY });
    expect(source?.climbs).toBe(feedClimbs);
  });

  // The reason the anchor goes first: navigation looks the CURRENT climb up
  // inside source.climbs and hands back the entry after it. A feed that omits
  // the current climb resolves to nothing — the dead end this fix removes.
  it('gives a forward swipe somewhere to go from an off-board current climb', () => {
    const anchorClimb = makeClimb('kilter-anchor', 'kilter', 1);
    const source = createBoardFeedSuggestionSource({
      anchorClimb,
      feedClimbs: [makeClimb('tension-1'), makeClimb('tension-2')],
      boardKey: BOARD_KEY,
    });
    const currentItem = { uuid: 'item-anchor', climb: anchorClimb };
    const next = findNextQueueItemWithSuggestions([currentItem], currentItem, source, {
      boardName: 'tension',
      layoutId: 8,
    });
    expect(next?.climb.uuid).toBe('tension-1');
    expect(next?.suggested).toBe(true);
  });
});
