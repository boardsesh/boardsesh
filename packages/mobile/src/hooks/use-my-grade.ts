import { useMemo } from 'react';
import { logbookClimbAngleKey, useOptionalBoardLogbook } from '@boardsesh/board-react';
import { clampToBoulderScale, pickLatestGradedTick } from '@boardsesh/logbook';
import { usePersonalGradesActive } from './use-personal-grades';

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
  | { status: 'set'; difficultyId: number; climbedAt: string };

const UNKNOWN: MyGrade = { status: 'unknown' };
const NONE: MyGrade = { status: 'none' };

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
 */
export function useMyGrade(climbUuid: string, angle: number): MyGrade {
  const logbook = useOptionalBoardLogbook();
  const entries = logbook?.logbookByClimbAngle.get(logbookClimbAngleKey(climbUuid, angle));
  const isFetched = logbook?.fetchedLogbookClimbUuids.has(climbUuid) ?? false;
  // The setting is read HERE, at the one seam every display surface shares,
  // rather than at each of them. The query half reads the same resolution, and
  // the two must move together: a state where rows kept showing your grade
  // while the filter and sort reverted would put a V10 row behind a V0 filter —
  // precisely the defect #4828 is about. Reading one seam makes that impossible
  // to get wrong; reading three call sites would not.
  const personalGradesEnabled = usePersonalGradesActive();

  return useMemo<MyGrade>(() => {
    // Turned off: report the same "never graded it" every surface already
    // handles, so all of them fall back to the crowd's number together.
    if (!personalGradesEnabled) return NONE;
    // Outside a BoardProvider, or before this climb's ticks have been fetched,
    // we genuinely do not know.
    if (!logbook || !isFetched) return UNKNOWN;
    const latest = pickLatestGradedTick(entries);
    if (!latest || latest.difficulty == null) return NONE;
    return { status: 'set', difficultyId: clampToBoulderScale(latest.difficulty), climbedAt: latest.climbed_at };
  }, [personalGradesEnabled, logbook, isFetched, entries]);
}
