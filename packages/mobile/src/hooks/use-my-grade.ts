import { useMemo } from 'react';
import { logbookClimbAngleKey, useOptionalBoardActions, useOptionalBoardLogbook } from '@boardsesh/board-react';
import { clampToBoulderScale, pickLatestGradedTick } from '@boardsesh/logbook';
import { usePersonalGradesActive } from './use-personal-grades';
import { useLocalMyGrade } from './use-local-my-grade';

/**
 * What the app knows about the climber's own grade for one climb at one angle.
 *
 * `unknown` is a distinct state from `none` on purpose: an empty
 * `logbookByClimbAngle` bucket is ambiguous until the fetch for that uuid
 * lands, and reading it as "never graded" would flash the crowd's number and
 * then swap it. Callers render `unknown` exactly like `none` — today's output —
 * but must not persist or act on it. Treating an unfetched bucket as "no
 * history" is what let a repeat ascent be offered as a Flash (#3940).
 */
export type MyGrade =
  | { status: 'unknown' }
  | { status: 'none' }
  // `climbedAt` is null when the grade came from a search row, which carries the
  // number but not the tick it came from.
  | { status: 'set'; difficultyId: number; climbedAt: string | null };

const UNKNOWN: MyGrade = { status: 'unknown' };
const NONE: MyGrade = { status: 'none' };

export type UseMyGradeOptions = {
  /**
   * The `myDifficulty` the search row arrived with (#4828), or `undefined` when
   * the search did not project one. The server and the on-device search both
   * project it whenever they filtered or sorted by the climber's grade, so it is
   * exactly the number that placed the row. Used only while the logbook has not
   * resolved this climb — which offline is always, since the logbook is a
   * network fetch — so a row the list put in the V10 band never reads V0.
   */
  rowDifficulty?: number | null;
  /**
   * Read the grade from the device's own ticks table while the logbook is
   * unresolved and there is no row value. One SQLite lookup per call, so this
   * is for single-climb surfaces (the play drawer), never per list row.
   */
  localFallback?: boolean;
};

/**
 * The grade this climber last gave a climb at this angle, or nothing when they
 * never graded it. Drives the "your grade wins" rule on climb rows and the play
 * drawer header (#4796, #4828).
 *
 * Reads the pre-grouped `logbookByClimbAngle` index that `BoardProvider` builds
 * once per logbook change, so a row costs one `Map.get` plus a scan of its own
 * handful of ticks — never `logbook.filter(...)`, which made the climbs list
 * O(rows × logbook) on every merge. Same index and same shape as the sibling
 * `useAscentStatus`.
 *
 * Angle is part of the key because grades are per-angle: a V9 you gave at 40°
 * says nothing about the same climb at 30°, and must not colour or sort it.
 *
 * Mirror is deliberately NOT part of the key. `logbookClimbAngleKey` carries no
 * `is_mirror`, and your opinion of how hard a climb is stays your opinion
 * whether you climbed it mirrored or not. (Ascent *status* still splits on
 * mirror — that is a different question about what you did, not how hard it is.)
 *
 * The grade comes back CLAMPED to the boulder scale, through the same shared
 * helper the server and the local SQLite mirror clamp with. Ticks written today
 * are already bounded, but a legacy or imported row can carry a difficulty off
 * the scale — and an unclamped display half would then show one grade while the
 * list filtered and sorted the row by another. That mismatch is the whole defect
 * #4828 exists to close, so the two halves read the same number or neither does.
 *
 * Sources, in order: the logbook once it has resolved this climb; else the
 * `myDifficulty` the search row carries; else (drawer only) the device's own
 * ticks table. The logbook is a network fetch that is never persisted, so
 * offline it never resolves — without the two fallbacks every surface showed
 * the crowd's grade while the on-device search filtered and sorted by the
 * climber's own.
 */
export function useMyGrade(climbUuid: string, angle: number, options: UseMyGradeOptions = {}): MyGrade {
  const { rowDifficulty, localFallback = false } = options;
  const logbook = useOptionalBoardLogbook();
  // Depend on the BOOLEAN, not the context object. `logbook` is the volatile
  // half of the board context — a new reference on every tick merge — and it is
  // only ever read here as a null check. `entries` already carries the real data
  // dependency, and for the many rows with no ticks at this angle it stays
  // `undefined` across a merge, so this keeps their memo from recomputing at all.
  const hasLogbook = logbook != null;
  const entries = logbook?.logbookByClimbAngle.get(logbookClimbAngleKey(climbUuid, angle));
  const isFetched = logbook?.fetchedLogbookClimbUuids.has(climbUuid) ?? false;
  // The setting is read HERE, at the one seam every display surface shares,
  // rather than at each of them. The query half reads the same resolution, and
  // the two must move together: a state where rows kept showing your grade
  // while the filter and sort reverted would put a V10 row behind a V0 filter —
  // precisely the defect #4828 is about. Reading one seam makes that impossible
  // to get wrong; reading three call sites would not.
  const personalGradesEnabled = usePersonalGradesActive();
  const boardName = useOptionalBoardActions()?.boardName ?? null;
  const logbookResolved = hasLogbook && isFetched;
  // Only asked for when nothing better exists: the logbook is unresolved and the
  // caller has no row value. Online the logbook lands and wins; offline this is
  // the only source the drawer has.
  const localGrade = useLocalMyGrade(
    climbUuid,
    boardName,
    angle,
    personalGradesEnabled && localFallback && !logbookResolved && rowDifficulty === undefined,
  );

  return useMemo<MyGrade>(() => {
    // Turned off: report the same "never graded it" every surface already
    // handles, so all of them fall back to the crowd's number together.
    if (!personalGradesEnabled) return NONE;
    // The logbook is the freshest source — it carries an optimistic tick the
    // moment it is saved — so it wins whenever it has resolved this climb.
    if (logbookResolved) {
      const latest = pickLatestGradedTick(entries);
      if (!latest || latest.difficulty == null) return NONE;
      return { status: 'set', difficultyId: clampToBoulderScale(latest.difficulty), climbedAt: latest.climbed_at };
    }
    // Next, the number the search row was filtered and sorted by. A null here
    // is a real answer — the search looked and found no graded tick.
    if (rowDifficulty !== undefined) {
      if (rowDifficulty == null) return NONE;
      return { status: 'set', difficultyId: clampToBoulderScale(rowDifficulty), climbedAt: null };
    }
    // Last, the device's own ticks table. `undefined` means it was not read
    // (offline downloads off, no handle, still loading): genuinely unknown.
    if (localGrade === undefined) return UNKNOWN;
    if (localGrade === null) return NONE;
    return { status: 'set', difficultyId: clampToBoulderScale(localGrade.difficulty), climbedAt: localGrade.climbedAt };
  }, [personalGradesEnabled, logbookResolved, entries, rowDifficulty, localGrade]);
}
