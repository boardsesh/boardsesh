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
export type OwnedBoard = BoardConfigRow & {
  id: number;
  ownerId: string;
  createdAt: string;
  deletedAt: string | null;
};
export type FeedTick = {
  uuid: string;
  userId: string;
  boardId: number;
  createdAt: string;
  sessionBoard: SharedFeedBoard | null;
};

export type PlannedMove = { uuid: string; oldBoardId: number; newBoardId: number };

export type MovePlan = {
  moves: PlannedMove[];
  /** Climbers with at least one moved tick. */
  movedUserIds: Set<string>;
  /** Moves whose active, matching session wall resolved the destination. */
  sessionMoves: number;
  /** Ticks already on the active, matching board named by their session. */
  sessionRetained: number;
  /** Ticks left alone because their climber owns several boards of that config. */
  ambiguous: number;
  ambiguousUserIds: Set<string>;
  /** Ticks with no unique usable owned wall for their recorded-at time. */
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

/** Normalize PostgreSQL `timestamp` text while retaining its full microsecond precision. */
function timestampKey(timestamp: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(timestamp.trim());
  if (!match) return null;
  return `${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(6, '0')}`;
}

function existedAt(timestamp: string, recordedAt: string): boolean {
  const timestampKeyValue = timestampKey(timestamp);
  const recordedAtKey = timestampKey(recordedAt);
  return timestampKeyValue !== null && recordedAtKey !== null && timestampKeyValue <= recordedAtKey;
}

function occurredBefore(timestamp: string, later: string): boolean {
  const timestampKeyValue = timestampKey(timestamp);
  const laterKey = timestampKey(later);
  return timestampKeyValue !== null && laterKey !== null && timestampKeyValue < laterKey;
}

/**
 * Which ticks can be moved off a per-config shared feed, and why the rest
 * cannot.
 *
 * An active session wall with the feed's full configuration wins, even when
 * another climber owns it. Otherwise count matching boards that existed and
 * were not yet deleted when the tick row was recorded. Move only when that
 * historical set has one member and the board is still active now. Deleted
 * historical candidates still make the set ambiguous; absent, later-created,
 * or now-deleted sole candidates retain the feed. Neither fallback guesses.
 */
export function planSharedFeedTickMoves(input: {
  feeds: SharedFeedBoard[];
  ticks: FeedTick[];
  ownedBoards: OwnedBoard[];
}): MovePlan {
  const feedConfigById = new Map(input.feeds.map((feed) => [feed.id, boardConfigKey(feed)]));

  const ownedByOwnerConfig = new Map<string, OwnedBoard[]>();
  for (const board of input.ownedBoards) {
    const key = `${board.ownerId}|${boardConfigKey(board)}`;
    const bucket = ownedByOwnerConfig.get(key);
    if (bucket) bucket.push(board);
    else ownedByOwnerConfig.set(key, [board]);
  }

  const plan: MovePlan = {
    moves: [],
    movedUserIds: new Set(),
    sessionMoves: 0,
    sessionRetained: 0,
    ambiguous: 0,
    ambiguousUserIds: new Set(),
    noOwnedBoard: 0,
  };

  for (const tick of input.ticks) {
    const feedConfig = feedConfigById.get(tick.boardId);
    // Not on a feed at all — the caller's query shouldn't return these, but a
    // tick that moved between the two reads must not be re-filed on a guess.
    if (!feedConfig) continue;

    if (tick.sessionBoard && boardConfigKey(tick.sessionBoard) === feedConfig) {
      if (tick.sessionBoard.id === tick.boardId) {
        plan.sessionRetained += 1;
      } else {
        plan.sessionMoves += 1;
        plan.movedUserIds.add(tick.userId);
        plan.moves.push({ uuid: tick.uuid, oldBoardId: tick.boardId, newBoardId: tick.sessionBoard.id });
      }
      continue;
    }

    // Count every matching wall that existed when the tick was recorded, even
    // if it was deleted later. A replacement created after the tick cannot be
    // used to infer the wall the climber stood on, and a deleted historical
    // match still makes a now-single survivor ambiguous.
    const historicalCandidates = (ownedByOwnerConfig.get(`${tick.userId}|${feedConfig}`) ?? []).filter(
      (board) =>
        existedAt(board.createdAt, tick.createdAt) &&
        (!board.deletedAt || occurredBefore(tick.createdAt, board.deletedAt)),
    );
    if (historicalCandidates.length === 0) {
      plan.noOwnedBoard += 1;
      continue;
    }
    if (historicalCandidates.length > 1) {
      plan.ambiguous += 1;
      plan.ambiguousUserIds.add(tick.userId);
      continue;
    }
    const candidate = historicalCandidates[0];
    if (candidate.deletedAt !== null) {
      // The only historical wall has since been removed, so there is no safe
      // current destination for the foreign key.
      plan.noOwnedBoard += 1;
      continue;
    }
    plan.movedUserIds.add(tick.userId);
    plan.moves.push({ uuid: tick.uuid, oldBoardId: tick.boardId, newBoardId: candidate.id });
  }

  return plan;
}
