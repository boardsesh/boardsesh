export type AscentStatusValue = 'flash' | 'send' | 'attempt';

export type NormalizeAscentStatusInput = {
  status?: AscentStatusValue | null;
  isAscent?: boolean | null;
  tries?: number | null;
};

const STATUS_PRIORITY: AscentStatusValue[] = ['flash', 'send', 'attempt'];

export function normalizeAscentStatus({
  status,
  isAscent = false,
  tries,
}: NormalizeAscentStatusInput): AscentStatusValue {
  if (status === 'flash' || status === 'send' || status === 'attempt') {
    return status;
  }

  if (isAscent) {
    return tries === 1 ? 'flash' : 'send';
  }

  return 'attempt';
}

export function pickHighestAscentStatus(statuses: Iterable<AscentStatusValue>): AscentStatusValue | null {
  const candidates = new Set(statuses);

  for (const status of STATUS_PRIORITY) {
    if (candidates.has(status)) {
      return status;
    }
  }

  return null;
}

/** A logbook tick, narrowed to the fields the ascent-status helpers read. */
export type AscentLogEntry = {
  climb_uuid: string;
  angle: number;
  status?: AscentStatusValue | null;
  is_ascent?: boolean | null;
  tries?: number | null;
};

/**
 * Count of send/flash ticks for a climb at a given angle — drives the toolbar's
 * "already logged" state and its success burst (a fresh send bumps the count).
 * Shares `normalizeAscentStatus` with the climb-row status glyph so the toolbar
 * and the list marker agree.
 */
export function countSentAscents(entries: readonly AscentLogEntry[], climbUuid: string, angle: number): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.climb_uuid !== climbUuid || entry.angle !== angle) continue;
    const status = normalizeAscentStatus({ status: entry.status, isAscent: entry.is_ascent, tries: entry.tries });
    if (status === 'send' || status === 'flash') count += 1;
  }
  return count;
}
