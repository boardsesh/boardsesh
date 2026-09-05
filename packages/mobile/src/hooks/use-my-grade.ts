import { useMemo } from 'react';
import { logbookClimbAngleKey, useOptionalBoardLogbook } from '@boardsesh/board-react';
import { pickLatestGradedTick } from '@boardsesh/logbook';

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
 */
export function useMyGrade(climbUuid: string, angle: number): MyGrade {
  const logbook = useOptionalBoardLogbook();
  const entries = logbook?.logbookByClimbAngle.get(logbookClimbAngleKey(climbUuid, angle));
  const isFetched = logbook?.fetchedLogbookClimbUuids.has(climbUuid) ?? false;

  return useMemo<MyGrade>(() => {
    // Outside a BoardProvider, or before this climb's ticks have been fetched,
    // we genuinely do not know.
    if (!logbook || !isFetched) return UNKNOWN;
    const latest = pickLatestGradedTick(entries);
    if (!latest || latest.difficulty == null) return NONE;
    return { status: 'set', difficultyId: latest.difficulty, climbedAt: latest.climbed_at };
  }, [logbook, isFetched, entries]);
}
