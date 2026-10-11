/**
 * The climber's own grade for a climb, and how it renders next to the crowd's.
 *
 * Boardsesh shows three different grades for the same climb: the legacy
 * Aurora/setter `difficulty`, the data-science Boardsesh grade, and — from
 * here on — the grade the climber gave it themselves when they logged a tick.
 * Issues #4796 and #4828 are both the same complaint from opposite ends: a
 * Woods climber logs V10 on a climb the board calls V0, and nothing anywhere
 * changes. The rule is "your grade wins": if you graded it, that is the number
 * you see.
 *
 * This module owns SELECTING and BOUNDING that grade. How it then renders
 * against the crowd's — which number sits in the column, whether it wears a
 * provenance glyph, and where the other number goes — lives next door in
 * ./grade-token.ts.
 *
 * Pure TS on purpose — no React, no formatting, so both web and mobile can
 * branch identically and the whole thing is unit testable. The one table it
 * reads is BOULDER_GRADES, and only for the scale's end points.
 */

import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';

/**
 * The difficulty-id bounds of the boulder scale, derived from the table rather
 * than hardcoded so extending `BOULDER_GRADES` moves them for free. The server
 * derives its own copy the same way
 * (PERSONAL_GRADE_MIN_ID / PERSONAL_GRADE_MAX_ID in
 * packages/db/src/queries/climbs/create-climb-filters.ts), as does the write
 * validation (packages/backend/src/validation/schemas/ticks.ts).
 */
export const BOULDER_SCALE_MIN_ID = BOULDER_GRADES[0].difficulty_id;
export const BOULDER_SCALE_MAX_ID = BOULDER_GRADES[BOULDER_GRADES.length - 1].difficulty_id;

/**
 * A difficulty id pulled onto the boulder scale.
 *
 * Every read of a personal grade goes through this, on BOTH halves of the
 * feature. The server clamps in SQL (`LEAST(GREATEST(difficulty, MIN), MAX)`)
 * before it filters and sorts on the number, and the local SQLite mirror does
 * the same; a display path that returned the raw value would show one grade
 * while the list sorted the row by another. New ticks are already bounded at
 * write time, so this only ever has work to do for a row that predates that
 * validation or arrived through an import — which is exactly the row that would
 * otherwise disagree.
 *
 * `null` passes straight through: "no grade" is not a grade to clamp.
 */
export function clampToBoulderScale(difficultyId: number): number;
export function clampToBoulderScale(difficultyId: number | null | undefined): number | null;
export function clampToBoulderScale(difficultyId: number | null | undefined): number | null {
  if (difficultyId == null) return null;
  return Math.min(Math.max(difficultyId, BOULDER_SCALE_MIN_ID), BOULDER_SCALE_MAX_ID);
}

/**
 * The minimum shape `pickLatestGradedTick` needs. Structural rather than an
 * import of `LogbookEntry` (which lives in the React-flavoured
 * `@boardsesh/board-react`) so this package stays dependency-free and both the
 * snake_case client entry and any server-side row can be passed straight in.
 */
export type GradedTickLike = {
  /** Difficulty grade id. `null` for a tick logged without a grade. */
  difficulty: number | null;
  /** ISO-ish timestamp string, as carried on the wire and in the client cache. */
  climbed_at: string;
  /** Our own tick uuid — the tiebreaker both client and server can agree on. */
  uuid: string;
};

/**
 * Compare two ticks by recency, newest first.
 *
 * The tiebreaker is `uuid`, NOT the `boardsesh_ticks.id` bigserial, even though
 * the id is the more natural "insertion order" key server-side. The client
 * never sees it: neither `LogbookEntry` nor the GraphQL tick payload carries an
 * id, only a uuid. Ordering on the id server-side and on the uuid client-side
 * would let the two disagree about which grade is "latest" whenever two ticks
 * on the same climb+angle share a `climbed_at`, so both sides order by
 * `(climbed_at DESC, uuid DESC)` and the disagreement can't arise.
 *
 * Timestamps are compared numerically where they parse, and lexically where
 * they don't: the tick corpus still carries legacy rows with inconsistent
 * timezone labelling (#3909), and a lexical fallback is stable and total rather
 * than silently ordering `NaN` values arbitrarily.
 */
function compareByRecencyDesc(left: GradedTickLike, right: GradedTickLike): number {
  const leftTime = Date.parse(left.climbed_at);
  const rightTime = Date.parse(right.climbed_at);
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
    if (left.climbed_at !== right.climbed_at) return left.climbed_at < right.climbed_at ? 1 : -1;
  }
  if (left.uuid === right.uuid) return 0;
  return left.uuid < right.uuid ? 1 : -1;
}

/**
 * The tick carrying the climber's current opinion of a climb: the most recent
 * one they actually put a grade on, or `null` when they never graded it.
 *
 * Takes the newest rather than the hardest deliberately — a stiff grade from
 * one bad day must not stick forever, and the maintainer's framing on #4796 is
 * "their last estimate of the grade".
 *
 * The caller is expected to pass one climb+angle bucket from
 * `logbookByClimbAngle`, so this scans a handful of entries, never the whole
 * logbook. Buckets are NOT in chronological order — `mergeLogbookEntries`
 * appends each fetched page while an optimistic save prepends — so reading
 * `entries[0]` shows a stale grade and this has to compare rather than index.
 *
 * `difficulty` is checked against `null` explicitly, never for falsiness: `0`
 * is a real difficulty id.
 */
export function pickLatestGradedTick<TickShape extends GradedTickLike>(
  entries: readonly TickShape[] | undefined,
): TickShape | null {
  if (!entries?.length) return null;
  let latest: TickShape | null = null;
  for (const entry of entries) {
    if (entry.difficulty == null) continue;
    if (latest === null || compareByRecencyDesc(entry, latest) < 0) latest = entry;
  }
  return latest;
}
