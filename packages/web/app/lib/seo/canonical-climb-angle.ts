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
  const routableAngleSet = new Set<number>(routableAngles);
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
  if (routableAngleSet.has(40)) return 40;
  return routableAngles[0] ?? 40;
}
