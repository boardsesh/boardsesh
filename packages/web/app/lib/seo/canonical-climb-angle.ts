import { getRoutableBoardAngles } from '@boardsesh/board-config';
import type { BoardName } from '@/app/lib/types';

type CanonicalAngleStats = {
  angle: number;
  ascensionist_count: string | number;
};

type SelectCanonicalClimbAngleArgs = {
  boardName: BoardName;
  catalogAngle?: number | null;
  angleStats: readonly CanonicalAngleStats[];
};

/**
 * Fallback when a climb has no eligible angle stats and no catalogue angle.
 *
 * Not Kilter muscle memory: the last resort below this is `routableAngles[0]`,
 * which is 0° on most boards but **-5° on Grasshopper** — canonicalising a
 * stats-less climb onto the slab setting would be actively wrong. 40° sits
 * inside every board's routable range and is a sane middle of the wall, so it
 * is the board-stable choice for all of them.
 */
const STATLESS_FALLBACK_ANGLE = 40;

/**
 * One Set per board, built once.
 *
 * `selectCanonicalClimbAngle` runs in `generateMetadata` and again in the page
 * body on every climb-view render; rebuilding a 92-entry Set each time is pure
 * waste on the busiest route on the site. Keyed by board because Grasshopper's
 * routable set differs from every other board's.
 */
const routableAngleSetsByBoard = new Map<BoardName, ReadonlySet<number>>();

function routableAngleSetFor(boardName: BoardName): ReadonlySet<number> {
  const cached = routableAngleSetsByBoard.get(boardName);
  if (cached) return cached;

  const built: ReadonlySet<number> = new Set(getRoutableBoardAngles(boardName));
  routableAngleSetsByBoard.set(boardName, built);
  return built;
}

function ascentCount(stats: CanonicalAngleStats): number {
  const parsedCount = Number(stats.ascensionist_count);
  return Number.isFinite(parsedCount) ? parsedCount : 0;
}

/**
 * Choose the one angle that represents a climb in metadata and the sitemap.
 * The ordering mirrors the sitemap's DISTINCT ON order: most ascents, then the
 * catalog angle, then the lowest angle. The fallback is board-stable so a climb
 * with no stats does not self-canonicalise at every valid angle.
 */
export function selectCanonicalClimbAngle({
  boardName,
  catalogAngle,
  angleStats,
}: SelectCanonicalClimbAngleArgs): number {
  const routableAngles = getRoutableBoardAngles(boardName);
  const routableAngleSet = routableAngleSetFor(boardName);
  const eligibleStats = angleStats.filter((stats) => routableAngleSet.has(stats.angle));

  eligibleStats.sort((leftStats, rightStats) => {
    const countDifference = ascentCount(rightStats) - ascentCount(leftStats);
    if (countDifference !== 0) return countDifference;

    const leftMatchesCatalog = leftStats.angle === catalogAngle;
    const rightMatchesCatalog = rightStats.angle === catalogAngle;
    if (leftMatchesCatalog !== rightMatchesCatalog) return leftMatchesCatalog ? -1 : 1;

    return leftStats.angle - rightStats.angle;
  });

  const chosenStats = eligibleStats[0];
  if (chosenStats) return chosenStats.angle;
  if (catalogAngle != null && routableAngleSet.has(catalogAngle)) return catalogAngle;
  if (routableAngleSet.has(STATLESS_FALLBACK_ANGLE)) return STATLESS_FALLBACK_ANGLE;
  return routableAngles[0] ?? STATLESS_FALLBACK_ANGLE;
}
