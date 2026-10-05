import type { BoardName, LitUpHoldsMap } from '@boardsesh/shared-schema';
import { accumulateFramesToMaps } from '@boardsesh/board-constants/hold-states';

/**
 * Window after first publish during which a published climb on a CATALOGUE board
 * can still be edited. A spray wall has no window (#5955).
 */
export const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The one board type whose published climbs never lock.
 *
 * A catalogue board is shared by everyone who owns one, so a published climb is
 * something other people have already logged. A spray wall is one physical wall
 * whose holds move, so its climbs stay editable and every edit is kept as a
 * revision instead.
 */
const SPRAY_BOARD_TYPE = 'spray';

/**
 * The minimal record of a saved climb the editor tracks so subsequent saves
 * can update the same row (vs. creating a new one) and so the edit lock can be
 * computed.
 */
export type SavedClimbSnapshot = {
  uuid: string;
  boardType: string;
  createdAt: string | null;
  /** ISO timestamp of first publish; null while the climb is a draft. */
  publishedAt: string | null;
  isDraft: boolean;
};

/**
 * Can the tracked row be updated in place rather than creating a new one?
 * Same board, and one of: still a draft (editable indefinitely), on a spray
 * wall (no window), or published within the 24h window. The server enforces the
 * same rule in `updateClimb`.
 */
export function computeCanUpdate(
  saved: SavedClimbSnapshot | null,
  boardType: string,
  now: number = Date.now(),
): boolean {
  if (!saved) return false;
  if (saved.boardType !== boardType) return false;
  if (saved.isDraft) return true;
  if (saved.boardType === SPRAY_BOARD_TYPE) return true;
  if (!saved.publishedAt) return false;
  const publishedMs = Date.parse(saved.publishedAt);
  return Number.isFinite(publishedMs) && now - publishedMs <= EDIT_WINDOW_MS;
}

/**
 * Is the tracked row published and past the 24h window (no further edits)?
 * Drafts are never locked, and neither is anything on a spray wall.
 */
export function computeEditLocked(saved: SavedClimbSnapshot | null, now: number = Date.now()): boolean {
  if (!saved || saved.isDraft || !saved.publishedAt) return false;
  if (saved.boardType === SPRAY_BOARD_TYPE) return false;
  const publishedMs = Date.parse(saved.publishedAt);
  return Number.isFinite(publishedMs) && now - publishedMs > EDIT_WINDOW_MS;
}

/** The fields of a climb the edit rule reads. A `Climb` satisfies it as is. */
export type EditableClimb = {
  uuid: string;
  /** Null for Aurora-synced climbs that predate Boardsesh accounts. */
  userId?: string | null;
  is_draft?: boolean | null;
  published_at?: string | null;
  created_at?: string | null;
  /** The board the climb itself is on, when the row carries it (queue items do). */
  boardType?: string | null;
  /** The layout the climb itself is on, which on spray is the wall. */
  layoutId?: number | null;
};

export type CanEditClimbInput = {
  climb: EditableClimb | null | undefined;
  /** The board the climb is being looked at on. */
  boardType: string;
  /** Null when signed out. */
  currentUserId: string | null | undefined;
  /**
   * Whether the viewer can edit the WALL the climb is on (`SprayWall.viewerCanEdit`).
   * Only read on spray. Unknown is `false`: the Edit action stays hidden until the
   * wall says otherwise.
   * Kept for backwards compatibility; viewerCanEditClimbs takes precedence when provided.
   */
  viewerCanEditWall?: boolean | null;
  /**
   * Whether the viewer can edit climbs on this wall (`SprayWall.viewerCanEditClimbs`, #6025).
   * Only read on spray. Takes precedence over `viewerCanEditWall`.
   */
  viewerCanEditClimbs?: boolean | null;
  /**
   * The layout of the wall `viewerCanEditWall` was read for. With it, a climb
   * that says it is on a different wall is not offered to a wall editor.
   */
  wallLayoutId?: number | null;
  now?: number;
};

/**
 * Should this viewer be offered Edit on this climb? The whole client rule, in
 * one place, so the two action menus cannot drift:
 *
 * | Board     | The climb is | Who                                   | For how long |
 * | --------- | ------------ | ------------------------------------- | ------------ |
 * | catalogue | a draft      | its setter                            | always       |
 * | catalogue | published    | its setter                            | 24 hours     |
 * | spray     | a draft      | its setter                            | always       |
 * | spray     | published    | its setter, or anyone who can edit    | always       |
 * |           |              | the wall the climb is on              |              |
 *
 * A hint, not a permission: `updateClimb` decides, and a viewer this gets wrong
 * (a role granted or taken away since the wall was last read) meets the server's
 * refusal in the editor.
 */
export function canEditClimb({
  climb,
  boardType,
  currentUserId,
  viewerCanEditWall,
  viewerCanEditClimbs,
  wallLayoutId,
  now = Date.now(),
}: CanEditClimbInput): boolean {
  if (!climb || !currentUserId) return false;
  const isDraft = climb.is_draft ?? false;
  const isSetter = !!climb.userId && climb.userId === currentUserId;

  if (!isSetter) {
    const canEditOtherClimbs = viewerCanEditClimbs ?? viewerCanEditWall;
    // Somebody else's draft is theirs alone, wall editor or not: publishing it
    // would announce a new climb under the wrong name.
    if (boardType !== SPRAY_BOARD_TYPE || canEditOtherClimbs !== true || isDraft) return false;
    // Editing a wall is not editing every climb seen while standing at it. A
    // queue can still hold a climb from another wall, or from Kilter, and that
    // climb says so. A row that does not carry the field is taken on trust:
    // list rows come from the board they are listed under.
    if (climb.boardType != null && climb.boardType !== SPRAY_BOARD_TYPE) return false;
    if (climb.layoutId != null && wallLayoutId != null && climb.layoutId !== wallLayoutId) return false;
    return true;
  }

  return computeCanUpdate(
    {
      uuid: climb.uuid,
      boardType,
      createdAt: climb.created_at ?? null,
      publishedAt: climb.published_at ?? null,
      isDraft,
    },
    boardType,
    now,
  );
}

/**
 * Decode a (possibly multi-frame) fork/draft/edit frames string into the
 * editor's per-frame sequence, preserving frame separation — unlike the old
 * flatten-to-one-map seeding this replaced, a multi-frame route/circuit no
 * longer collapses into a single frame when you fork or edit it.
 *
 * Falls back to a single empty frame for an empty string, matching a
 * brand-new climb's starting state.
 */
export function buildInitialFrames(frames: string, board: BoardName): LitUpHoldsMap[] {
  if (!frames) return [{}];
  const maps = accumulateFramesToMaps(frames, board);
  return maps.length > 0 ? maps : [{}];
}
