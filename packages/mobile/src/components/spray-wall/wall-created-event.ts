// The `Board Created` properties for a spray wall (epic #5346, SW-09).
//
// Pulled out of the wizard so the RESUMED path can be pinned by a test. The
// event fires in exactly one place — the publish step — and every property used
// to be read straight off `useSprayWallBuilder`. That is right for a wall built
// in one sitting and quietly wrong for one finished in two: a resumed run
// rejoins at the photo or at the editor and NEVER runs the meta step, so the
// builder still holds its constructor defaults (40 degrees, no gym, private).
// Sending those would bias `angle`, `isPublic` and `hasGym` for every resumed
// wall, and nobody reading the funnel months later would know to distrust it.
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
// `app/boards/create.tsx`, plus `resumed`.

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
 * What the meta step answered, or null when this run never ran it.
 *
 * Nullable on purpose — null IS the resumed case, and making the caller say so
 * is what keeps a defaulted builder from being mistaken for a real answer.
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
  /** The meta step's own answers, or null on a resumed run. */
  meta: WallCreatedMeta | null;
  /** The visibility about to be applied by `updateSprayWall`, or null when the wall stays private. */
  pendingVisibility: { isPublic: boolean; isUnlisted: boolean } | null;
};

export type WallCreatedEventProperties = {
  boardType: 'spray';
  layoutId: number;
  sizeId: number;
  setCount: number;
  angle: number;
  isOwned: true;
  isPublic: boolean;
  /** Absent on a resumed run — see `resumed`. */
  hasLocationName?: boolean;
  /** Absent on a resumed run — see `resumed`. */
  hasCoords?: boolean;
  hasGym: boolean;
  gymUuid?: string;
  source: 'spray_wizard';
  resumed: boolean;
};

/** The `Board Created` payload for a wall that has just published its first version. */
export function wallCreatedEventProperties(input: WallCreatedEventInput): WallCreatedEventProperties {
  const { layoutId, board, meta, pendingVisibility } = input;

  // The row wins wherever it can. On a resumed wall it is the only honest
  // source; on a fresh one it holds the value the meta step just sent, so
  // preferring it costs nothing and removes the branch.
  const angle = board?.angle ?? meta?.angle ?? 0;
  const gymUuid = board?.gymUuid ?? meta?.gymUuid ?? null;

  // The END state, not the state at creation. EVERY wall is created private
  // whatever the climber chose (`use-spray-wall-builder.ts`), and the chosen
  // visibility is applied by `updateSprayWall` in the same publish that fires
  // this event — so the pending write, when there is one, is what the wall is
  // about to be. A resumed run has no pending write and the row is the answer.
  const isPublic = pendingVisibility?.isPublic ?? board?.isPublic ?? false;

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
    isPublic,
    // Omitted, not defaulted, when the meta step did not run.
    ...(meta ? { hasLocationName: meta.hasLocationName, hasCoords: meta.hasCoords } : {}),
    hasGym: gymUuid != null,
    // The gym being ATTACHED, and deliberately not the `gym_uuid` super property,
    // which carries the ACTIVE board's gym. Uuid only — the gym's name is
    // resolvable from it and this payload carries no free text.
    ...(gymUuid != null ? { gymUuid } : {}),
    source: 'spray_wizard',
    // Splits the funnel's two populations. A resumed wall carries neither
    // location property, so an analyst who pools the two reads a denominator
    // that is missing rows rather than one that is wrong.
    resumed: meta == null,
  };
}
