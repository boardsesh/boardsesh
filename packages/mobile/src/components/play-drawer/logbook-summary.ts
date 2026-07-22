import { deriveAngleLifetimeStats, type LogbookEntry } from '@boardsesh/profile-stats';

/**
 * Which OTHER angles (not the board's current one) the climber has sent or only
 * tried, for the collapsed Logbook summary's cross-angle clause. `sentAngles`
 * are angles with at least one send; `triedAngles` are angles with logged
 * attempts but no send. Both ascending — a send outranks a try, so an angle
 * never appears in both lists.
 */
export type OtherAngleActivity = {
  sentAngles: number[];
  triedAngles: number[];
};

/**
 * Partition a climb's logbook entries (already filtered to that climb) into the
 * angles sent vs. only-tried, excluding `currentAngle` (the board's angle, whose
 * counts the summary already shows). Reuses profile-stats' per-angle lifetime
 * roll-up, so a send at any angle counts as sent there.
 */
export function deriveOtherAngleActivity(entries: readonly LogbookEntry[], currentAngle: number): OtherAngleActivity {
  const sentAngles: number[] = [];
  const triedAngles: number[] = [];
  // deriveAngleLifetimeStats returns ascending by angle, so both lists inherit
  // that order without a re-sort.
  for (const stats of deriveAngleLifetimeStats(entries)) {
    if (stats.angle === currentAngle) continue;
    if (stats.sendCount > 0) sentAngles.push(stats.angle);
    else if (stats.totalTries > 0) triedAngles.push(stats.angle);
  }
  return { sentAngles, triedAngles };
}
