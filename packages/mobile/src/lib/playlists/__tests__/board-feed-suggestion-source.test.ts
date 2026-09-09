import { describe, it, expect } from 'vitest';
import type { Climb, PlaylistSuggestionSource } from '@boardsesh/queue';
import { canAddClimbToBoard, type BoardCompatibilityTarget } from '@boardsesh/board-config';
import { findNextQueueItemWithSuggestions } from '@boardsesh/play-view';
import {
  createBoardFeedSuggestionSource,
  normalizeBoardSuggestionSource,
  BOARD_FEED_SUGGESTION_SOURCE_ID,
} from '../board-feed-suggestion-source';

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

describe('normalizeBoardSuggestionSource', () => {
  const tensionTarget: BoardCompatibilityTarget = { board_name: 'tension', layout_id: 8, holdsData: [] };
  const fitsTension = (climb: Climb) => canAddClimbToBoard(climb, tensionTarget).ok;
  function sourceFor(climbs: Climb[], playlistUuid = 'saved-playlist'): PlaylistSuggestionSource {
    return { playlistUuid, activatedClimbUuid: climbs[0].uuid, boardKey: BOARD_KEY, climbs };
  }

  it('retains identity when every climb already fits', () => {
    const source = sourceFor([makeClimb('first'), makeClimb('next')]);
    expect(normalizeBoardSuggestionSource(source, fitsTension)).toBe(source);
  });

  it('filters a foreign activated climb in a real playlist without mutating its snapshot', () => {
    const foreign = makeClimb('foreign', 'kilter', 1);
    const local = makeClimb('local');
    const source = sourceFor([foreign, local]);
    expect(normalizeBoardSuggestionSource(source, fitsTension).climbs).toEqual([local]);
    expect(source.climbs).toEqual([foreign, local]);
  });

  it('keeps only the synthetic first foreign anchor and can navigate forward from it', () => {
    const anchor = makeClimb('anchor', 'kilter', 1);
    const local = makeClimb('local');
    const source = sourceFor([anchor, makeClimb('foreign', 'kilter', 1), local], BOARD_FEED_SUGGESTION_SOURCE_ID);
    const normalized = normalizeBoardSuggestionSource(source, fitsTension);
    expect(normalized.climbs).toEqual([anchor, local]);
    const current = { uuid: 'current', climb: anchor };
    expect(findNextQueueItemWithSuggestions([current], current, normalized)?.climb).toBe(local);
  });

  it('rejects a same-layout climb for a different board size', () => {
    const target: BoardCompatibilityTarget = { board_name: 'woods', layout_id: 1, size_id: 2, holdsData: [] };
    const local = { ...makeClimb('local', 'woods', 1), compatibleSizeIds: [2] };
    const foreign = { ...makeClimb('small', 'woods', 1), compatibleSizeIds: [1] };
    const normalized = normalizeBoardSuggestionSource(
      sourceFor([local, foreign]),
      (climb) => canAddClimbToBoard(climb, target).ok,
    );
    expect(normalized.climbs).toEqual([local]);
  });

  it('rejects a same-layout MoonBoard climb requiring uninstalled hold sets', () => {
    const target: BoardCompatibilityTarget = { board_name: 'moonboard', layout_id: 3, set_ids: [5], holdsData: [] };
    const local = { ...makeClimb('base', 'moonboard', 3), frames: 'p1r42p9r43' };
    const foreign = { ...makeClimb('wooden', 'moonboard', 3), frames: 'p1r42p2r43p17r44' };
    const normalized = normalizeBoardSuggestionSource(
      sourceFor([local, foreign]),
      (climb) => canAddClimbToBoard(climb, target).ok,
    );
    expect(normalized.climbs).toEqual([local]);
  });
});
