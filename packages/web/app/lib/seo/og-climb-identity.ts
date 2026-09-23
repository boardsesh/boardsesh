import { getGradeLabel } from '@boardsesh/db/queries';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import type { OgClimbCardIdentity } from '@/app/components/board-renderer/util';
import type { BoardName } from '@/app/lib/types';

/**
 * The climb identity an OG share card draws.
 *
 * One builder because two places need the identical value: `generateMetadata`
 * puts it in the card URL, and the SSR warmer fetches that URL to prime the
 * backend's byte cache. The identity is part of the URL and therefore part of
 * the cache key, so a warmer that built it even slightly differently would warm
 * a card nobody is about to ask for and leave the real one cold.
 *
 * Lives here rather than beside the URL builder so the board-renderer util
 * module keeps the export surface its many test mocks already stub.
 */
export function buildOgClimbCardIdentity(
  climb: { name?: string | null; difficulty?: string | null; setter_username?: string | null },
  boardName: BoardName,
  canonicalAngle: number,
  angleStats: readonly { angle: number; display_difficulty: number | null }[] = [],
): OgClimbCardIdentity {
  // The grade has to come from the angle the card names. `climb.difficulty` is
  // the grade at the REQUESTED angle, and the card is keyed on the canonical
  // one — so on a climb whose canonical angle is not the one being viewed, the
  // card would pair "40°" with the grade from 20°. Worse, the card is immutable
  // and shared, so whichever page a crawler reached first would decide which
  // grade every share of that climb shows.
  const canonicalStats = angleStats.find((stats) => stats.angle === canonicalAngle);
  const canonicalGrade =
    canonicalStats?.display_difficulty === null || canonicalStats?.display_difficulty === undefined
      ? undefined
      : getGradeLabel(Math.round(canonicalStats.display_difficulty));

  return {
    name: resolveClimbDisplayName(climb.name, boardName),
    grade: canonicalGrade ?? climb.difficulty,
    setter: climb.setter_username,
    angle: canonicalAngle,
  };
}
