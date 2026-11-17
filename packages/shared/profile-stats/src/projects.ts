import { parseTickTime } from './format-tick-time';

// Home's "Back to your projects" shelf (#7691): the climbs a climber has tried
// and never sent. Same rule as the Projects smart playlist on the server
// (`projectClimbsSubquery`): one entry per board and climb, across every angle,
// and gone as soon as any tick on it is a flash or a send. The shelf orders by
// the latest try, where the playlist orders by tries, because the shelf is for
// what the climber was on lately.

/** One logged tick, attempts included. */
export type ProjectTickEntry = {
  climbUuid: string;
  boardType: string;
  status: 'flash' | 'send' | 'attempt';
  /** Tries the tick records. Missing or below one counts as one. */
  attemptCount: number | null;
  climbedAt: string;
};

export type ClimbProject<T extends ProjectTickEntry> = {
  /** The latest tick on the climb: its angle, grade and board open the climb where it was last tried. */
  latest: T;
  /** Every try on the climb, at every angle. */
  tries: number;
  lastTriedMs: number;
};

/** The climber's projects, the latest tried first. */
export function deriveProjects<T extends ProjectTickEntry>(entries: readonly T[]): ClimbProject<T>[] {
  const byClimb = new Map<string, ClimbProject<T> & { sent: boolean }>();
  for (const entry of entries) {
    const key = `${entry.boardType}\u0000${entry.climbUuid}`;
    const parsedMs = parseTickTime(entry.climbedAt).valueOf();
    // An unreadable date still counts its tries, but never reads as the latest.
    const climbedMs = Number.isNaN(parsedMs) ? 0 : parsedMs;
    const tries = Math.max(1, entry.attemptCount ?? 1);
    const sent = entry.status === 'flash' || entry.status === 'send';
    const existing = byClimb.get(key);
    if (!existing) {
      byClimb.set(key, { latest: entry, tries, lastTriedMs: climbedMs, sent });
      continue;
    }
    existing.tries += tries;
    existing.sent ||= sent;
    if (climbedMs > existing.lastTriedMs) {
      existing.latest = entry;
      existing.lastTriedMs = climbedMs;
    }
  }
  const projects: ClimbProject<T>[] = [];
  for (const { sent, ...project } of byClimb.values()) if (!sent) projects.push(project);
  // Ties break on board and climb, as the server's list does, so the order is stable.
  return projects.sort(
    (left, right) =>
      right.lastTriedMs - left.lastTriedMs ||
      left.latest.boardType.localeCompare(right.latest.boardType) ||
      left.latest.climbUuid.localeCompare(right.latest.climbUuid),
  );
}
