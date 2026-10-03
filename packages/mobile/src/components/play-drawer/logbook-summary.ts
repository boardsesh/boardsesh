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

/** Sends and attempt rows at one angle — the two counts the collapsed summary leads with. */
export type AngleTickCounts = {
  sends: number;
  attempts: number;
};

/**
 * Count a climb's sends and attempt rows at `angle` from its logbook entries
 * (already filtered to that climb). Same definitions as the denormalised
 * `userAscents` / `userAttempts` on the climb row — a flash is a send, and an
 * attempt is one logged row, not its tries — so the summary reads the same
 * whichever source answers. The climb row's counts are a snapshot from when the
 * list was fetched; these follow the logbook, so a tick logged from the drawer
 * shows up on the collapsed header straight away.
 */
export function deriveAngleTickCounts(entries: readonly LogbookEntry[], angle: number): AngleTickCounts {
  let sends = 0;
  let attempts = 0;
  for (const entry of entries) {
    if (entry.angle !== angle) continue;
    if (entry.status === 'flash' || entry.status === 'send') sends += 1;
    else if (entry.status === 'attempt') attempts += 1;
  }
  return { sends, attempts };
}
