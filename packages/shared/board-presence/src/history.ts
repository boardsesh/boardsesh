import type { BoardPresenceClimb } from '@boardsesh/shared-schema';

/** Normalize legacy naive UTC timestamps without losing upstream microseconds. */
function sortableTimestamp(timestamp: string): string {
  const isoTimestamp = timestamp.replace(' ', 'T');
  const utc = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z?$/.exec(isoTimestamp);
  if (utc) return `${utc[1]}.${(utc[2] ?? '').padEnd(6, '0')}Z`;
  const milliseconds = Date.parse(timestamp);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString().replace('Z', '000Z') : '';
}

/** Arrival sequence is a tie-breaker, never the time an imported climb was displayed. */
export function compareBoardHistoryEntries(left: BoardPresenceClimb, right: BoardPresenceClimb): number {
  return sortableTimestamp(right.sentAt).localeCompare(sortableTimestamp(left.sentAt)) || right.seq - left.seq;
}

export function boardHistoryEntryKey(climb: BoardPresenceClimb): string {
  return `${climb.climbUuid}:${climb.seq}`;
}

/** Existing entries win overlapping backfills; callers control the window size. */
export function mergeBoardHistory(
  existing: BoardPresenceClimb[],
  incoming: BoardPresenceClimb[],
  limit = Infinity,
): BoardPresenceClimb[] {
  const byKey = new Map(existing.map((climb) => [boardHistoryEntryKey(climb), climb]));
  for (const climb of incoming) {
    const key = boardHistoryEntryKey(climb);
    if (!byKey.has(key)) byKey.set(key, climb);
  }
  const merged = [...byKey.values()].sort(compareBoardHistoryEntries).slice(0, limit);
  return merged.length === existing.length && merged.every((climb, index) => climb === existing[index])
    ? existing
    : merged;
}
