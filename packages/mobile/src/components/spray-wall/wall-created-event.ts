// The `Board Created` properties for a spray wall (epic #5346, SW-09).
//
// Pulled out of the wizard so the paths that never answer the details step can
// be pinned by a test. The event fires in exactly one place — the publish step —
// and every property used to be read straight off `useSprayWallBuilder`. That is
// right for a run that saved the details step and quietly wrong for one that did
// not (a reset, which has no details step): there the builder still holds its
// constructor defaults (40 degrees, no gym, private). Sending those would bias
// `angle`, `isPublic` and `hasGym`, and nobody reading the funnel months later
// would know to distrust it.
//
// So the rule here is: anything the `user_boards` row can answer comes off the
// ROW, which is real on both paths. The two properties it cannot answer are left
// ABSENT rather than defaulted to false — a hole in the data is recoverable, a
// confident wrong number is not.
//
// `Board Created` is the SAME event every other board type fires
// (`packages/shared/analytics/src/events.ts`); a wall is a board, and a
// spray-only variant would hide walls from every board-creation number we
// already watch. The property set therefore matches `describeInput` in
// `app/boards/create.tsx`, plus `resumed` and `isReset`.

/**
 * The slice of the wall's `user_boards` row this module reads.
 *
 * Structural rather than `UserBoard`, because the wall queries select a subset
 * of that type and a partial row has to satisfy this without a cast.
 * `locationName` and the coordinates are deliberately NOT here: the wall's board
 * payload does not select them, so the row cannot answer for them at all.
 */
export type WallBoardRow = {
  angle: number;
  isPublic: boolean;
  gymUuid?: string | null;
};

/**
 * What the details step answered, as saved, or null when this run never ran it.
 *
 * Nullable on purpose — null is a run without a details step (a reset), and
 * making the caller say so is what keeps a defaulted builder from being
 * mistaken for a real answer.
 */
export type WallCreatedMeta = {
  angle: number;
  hasLocationName: boolean;
  hasCoords: boolean;
  gymUuid: string | null;
};

export type WallCreatedEventInput = {
  /** The wall's catalogue layout id. Its size id is the same number by construction. */
  layoutId: number;
  /** The wall's board row, when it arrived. Authoritative for everything it carries. */
  board: WallBoardRow | null;
  /** The details step's answers as the server took them, or null on a run without that step (a reset). */
  meta: WallCreatedMeta | null;
  /**
   * The visibility the wall is about to have (parked by the details save and
   * applied by the publish, then re-stated by the repair write), or null when
   * it stays private or the run does not set it (a reset).
   */
  pendingVisibility: { isPublic: boolean; isUnlisted: boolean } | null;
  /** The wall is a reset's replacement (`resetSprayWall`), not a new wall. */
  isReset: boolean;
  /**
   * The wall was picked back up from an earlier sitting (the resume prompt, a
   * targeted open, a reset's clone with a photo already on it). The wizard
   * always says. Left out, it is read off `meta` as it used to be, for a caller
   * from before every run had a details step.
   */
  resumed?: boolean;
};

export type WallCreatedEventProperties = {
  boardType: 'spray';
  layoutId: number;
  sizeId: number;
  setCount: number;
  angle: number;
  isOwned: true;
  /**
   * Absent for a reset's replacement whose visibility this run did not set: the
   * clone is private until its publish, which then gives it the visibility of
   * the wall it replaces. The row cannot say which, and false would be wrong.
   */
  isPublic?: boolean;
  /** Absent when the run had no details step (a reset). */
  hasLocationName?: boolean;
  /** Absent when the run had no details step (a reset). */
  hasCoords?: boolean;
  hasGym: boolean;
  gymUuid?: string;
  source: 'spray_wizard';
  resumed: boolean;
  /**
   * The wall replaces one a reset archived. Its publish nets to zero walls, so
   * activation and creation counts leave it out.
   */
  isReset: boolean;
};

/** The `Board Created` payload for a wall that has just published its first version. */
export function wallCreatedEventProperties(input: WallCreatedEventInput): WallCreatedEventProperties {
  const { layoutId, board, meta, pendingVisibility, isReset, resumed } = input;

  // The row wins wherever it can: it holds what the details step saved, as
  // the server answered, and on a reset it is the only honest source.
  const angle = board?.angle ?? meta?.angle ?? 0;
  const gymUuid = board?.gymUuid ?? meta?.gymUuid ?? null;

  // The END state, not the row as it stands: an unpublished wall's row stays
  // private whatever the climber chose, and the publish that fires this event
  // applies the parked choice — so the pending pair, when there is one, is what
  // the wall is about to be. Without one the row is the answer.
  const isPublic = pendingVisibility?.isPublic ?? (isReset ? undefined : (board?.isPublic ?? false));

  return {
    boardType: 'spray',
    layoutId,
    // A wall's size id EQUALS its layout id by construction — it has exactly one
    // size, itself (`spraySizeIdForLayout`).
    sizeId: layoutId,
    // One synthetic hold set, "Holds", for every wall.
    setCount: 1,
    angle,
    isOwned: true,
    ...(isPublic !== undefined ? { isPublic } : {}),
    // Omitted, not defaulted, when the details step did not run.
    ...(meta ? { hasLocationName: meta.hasLocationName, hasCoords: meta.hasCoords } : {}),
    hasGym: gymUuid != null,
    // The gym being ATTACHED, and deliberately not the `gym_uuid` super property,
    // which carries the ACTIVE board's gym. Uuid only — the gym's name is
    // resolvable from it and this payload carries no free text.
    ...(gymUuid != null ? { gymUuid } : {}),
    source: 'spray_wizard',
    // Splits the funnel's two populations: walls finished in one sitting, and
    // walls picked back up.
    resumed: resumed ?? meta == null,
    isReset,
  };
}
