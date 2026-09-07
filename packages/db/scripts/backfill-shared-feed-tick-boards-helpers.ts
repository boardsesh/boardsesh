/**
 * The row-selection rule behind `backfill-shared-feed-tick-boards.ts`, kept
 * pure so it can be tested without a database. See that script's header for why
 * these ticks are misfiled in the first place (#5121).
 */

import { normaliseSetIds } from '@boardsesh/board-config';

export type BoardConfigRow = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

export type SharedFeedBoard = BoardConfigRow & { id: number };
export type OwnedBoard = BoardConfigRow & { id: number; ownerId: string };
export type FeedTick = { uuid: string; userId: string; boardId: number };

export type PlannedMove = { uuid: string; oldBoardId: number; newBoardId: number };

export type MovePlan = {
  moves: PlannedMove[];
  /** Climbers with at least one moved tick. */
  movedUserIds: Set<string>;
  /** Ticks left alone because their climber owns several boards of that config. */
  ambiguous: number;
  ambiguousUserIds: Set<string>;
  /** Ticks left alone because their climber owns no board of that config. */
  noOwnedBoard: number;
};

/**
 * The identity a tick's feed and a climber's board have to agree on to be the
 * same wall.
 *
 * Set ids are normalised because `createBoard` persists whatever order it was
 * handed: a board saved as '25,26,27,24' is the same wall as a feed keyed
 * '24,25,26,27', and a raw string compare would call them different and leave
 * the tick on the feed.
 */
export function boardConfigKey(board: BoardConfigRow): string {
  return `${board.boardType}|${board.layoutId}|${board.sizeId}|${normaliseSetIds(board.setIds)}`;
}

/**
 * Which ticks can be moved off a per-config shared feed, and why the rest
 * cannot.
 *
 * A tick moves only when its climber owns EXACTLY ONE non-deleted board with
 * the feed's configuration. Two same-config boards is the #4174 "same wall at
 * home and at the gym" case and nothing in the row says which one the climber
 * was standing at; zero means the feed is where the tick belongs, and the fixed
 * code still files it there. Both are counted rather than guessed at.
 */
export function planSharedFeedTickMoves(input: {
  feeds: SharedFeedBoard[];
  ticks: FeedTick[];
  ownedBoards: OwnedBoard[];
}): MovePlan {
  const feedConfigById = new Map(input.feeds.map((feed) => [feed.id, boardConfigKey(feed)]));

  const ownedByOwnerConfig = new Map<string, number[]>();
  for (const board of input.ownedBoards) {
    const key = `${board.ownerId}|${boardConfigKey(board)}`;
    const bucket = ownedByOwnerConfig.get(key);
    if (bucket) bucket.push(board.id);
    else ownedByOwnerConfig.set(key, [board.id]);
  }

  const plan: MovePlan = {
    moves: [],
    movedUserIds: new Set(),
    ambiguous: 0,
    ambiguousUserIds: new Set(),
    noOwnedBoard: 0,
  };

  for (const tick of input.ticks) {
    const feedConfig = feedConfigById.get(tick.boardId);
    // Not on a feed at all — the caller's query shouldn't return these, but a
    // tick that moved between the two reads must not be re-filed on a guess.
    if (!feedConfig) continue;

    const candidates = ownedByOwnerConfig.get(`${tick.userId}|${feedConfig}`) ?? [];
    if (candidates.length === 0) {
      plan.noOwnedBoard += 1;
      continue;
    }
    if (candidates.length > 1) {
      plan.ambiguous += 1;
      plan.ambiguousUserIds.add(tick.userId);
      continue;
    }
    plan.movedUserIds.add(tick.userId);
    plan.moves.push({ uuid: tick.uuid, oldBoardId: tick.boardId, newBoardId: candidates[0] });
  }

  return plan;
}
