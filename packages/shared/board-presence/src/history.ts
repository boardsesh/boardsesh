import type { BoardPresenceClimb } from '@boardsesh/shared-schema';

/** Imported sequences describe ingestion, never native LED/clear ordering. */
export function isImportedBoardClimb(climb: Pick<BoardPresenceClimb, 'source'>): boolean {
  return climb.source === 'kilter' || climb.source === 'aurora';
}

/** Only the explicit native value or legacy missing provenance can order native writes. */
export function isNativeBoardClimb(climb: Pick<BoardPresenceClimb, 'source'>): boolean {
  return climb.source == null || climb.source === 'boardsesh';
}

/** Wire provenance is a GraphQL String; future/invalid sources must fail closed. */
export function isSupportedBoardClimb(climb: Pick<BoardPresenceClimb, 'source'>): boolean {
  return isNativeBoardClimb(climb) || isImportedBoardClimb(climb);
}

export const BOARD_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** First millisecond after an entry falls outside the inclusive seven-day window. */
export function boardHistoryExpiresAt(sentAt: string): number | null {
  if (typeof sentAt !== 'string') return null;
  const normalized = sortableTimestamp(sentAt);
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp + BOARD_HISTORY_WINDOW_MS + 1 : null;
}

/** Filter display history only; current-climb and sequence state can outlive this window. */
export function filterRecentBoardHistory(climbs: BoardPresenceClimb[], nowMs: number): BoardPresenceClimb[] {
  const recent = climbs.filter((climb) => {
    const expiresAt = boardHistoryExpiresAt(climb.sentAt);
    return expiresAt !== null && nowMs < expiresAt;
  });
  return recent.length === climbs.length ? climbs : recent;
}

/** Normalize legacy naive UTC timestamps without losing upstream microseconds. */
function sortableTimestamp(timestamp: string): string {
  const isoTimestamp = timestamp.replace(' ', 'T');
  const utc = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z?$/.exec(isoTimestamp);
  if (utc) return `${utc[1]}.${(utc[2] ?? '').padEnd(6, '0')}Z`;
  const milliseconds = Date.parse(timestamp);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString().replace('Z', '000Z') : '';
}

/** Compare actual display times, including upstream microseconds, without arrival sequence. */
export function compareBoardDisplayTimes(left: string, right: string): number {
  return sortableTimestamp(left).localeCompare(sortableTimestamp(right));
}

/** Arrival sequence is a tie-breaker, never the time an imported climb was displayed. */
export function compareBoardHistoryEntries(left: BoardPresenceClimb, right: BoardPresenceClimb): number {
  return compareBoardDisplayTimes(right.sentAt, left.sentAt) || right.seq - left.seq;
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
  const byKey = new Map(existing.filter(isSupportedBoardClimb).map((climb) => [boardHistoryEntryKey(climb), climb]));
  for (const climb of incoming.filter(isSupportedBoardClimb)) {
    const key = boardHistoryEntryKey(climb);
    if (!byKey.has(key)) byKey.set(key, climb);
  }
  const merged = [...byKey.values()].sort(compareBoardHistoryEntries).slice(0, limit);
  return merged.length === existing.length && merged.every((climb, index) => climb === existing[index])
    ? existing
    : merged;
}
