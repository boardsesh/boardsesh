import { createHash } from 'node:crypto';
import { KILTER_PORTAL_HOST } from './types';
import { KilterApiError } from './errors';

export type KilterWallSelection = { gymUuid: string; productLayoutUuid: string; wallUuid: string };
export type KilterLiveDisplay = {
  climbUuid: string;
  angle: number;
  displayedAt: string;
  occurrenceKey: string;
  displayName: string | null;
};

export class KilterLiveError extends KilterApiError {
  constructor(
    status: number,
    readonly retryAfterMs = 0,
  ) {
    super(
      status === 429 ? 'rate_limited' : status === 401 ? 'unauthorized' : 'http',
      `Kilter live history returned HTTP ${status}`,
      status,
    );
  }
}

/** UTC with six fractional digits: stable identity and chronological sorting. */
export function normalizeKilterDisplayTime(timestamp: unknown): string | null {
  if (typeof timestamp !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(timestamp);
  if (!match) return null;
  const fraction = (match[3] ?? '').padEnd(6, '0');
  const zone = match[4].length === 3 ? `${match[4]}:00` : match[4];
  const instant = new Date(`${match[1]}T${match[2]}.${fraction.slice(0, 3)}${zone}`);
  if (!Number.isFinite(instant.getTime())) return null;
  return instant.toISOString().replace(/\.(\d{3})Z$/, `.$1${fraction.slice(3)}Z`);
}

export function parseKilterLiveHistory(response: unknown, selection: KilterWallSelection): KilterLiveDisplay[] {
  if (!Array.isArray(response)) throw new KilterApiError('unknown', 'Kilter live history is not an array');
  const displays = new Map<string, KilterLiveDisplay>();
  for (const entry of response as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const fields = entry as Record<string, unknown>;
    if (fields.isDeleted === true || fields.recentlyDisplayedReported === true) continue;
    if (typeof fields.climbUuid !== 'string' || !fields.climbUuid.trim()) continue;
    const displayedAt = normalizeKilterDisplayTime(fields.recentlyDisplayedAt);
    const angle = fields.derivativeAngle ?? fields.angle;
    if (!displayedAt || typeof angle !== 'number' || !Number.isInteger(angle) || angle < 0 || angle > 90) continue;
    const upstreamId = fields.recentlyDisplayedClimbId;
    const identity =
      typeof upstreamId === 'number' && Number.isSafeInteger(upstreamId) && upstreamId >= 0
        ? ['id', upstreamId]
        : ['climb', fields.climbUuid, angle];
    const occurrenceKey = createHash('sha256')
      .update(
        JSON.stringify([selection.gymUuid, selection.productLayoutUuid, selection.wallUuid, identity, displayedAt]),
      )
      .digest('hex');
    displays.set(occurrenceKey, {
      climbUuid: fields.climbUuid,
      angle,
      displayedAt,
      occurrenceKey,
      displayName:
        typeof fields.liveBoardUsername === 'string' ? fields.liveBoardUsername.trim().slice(0, 200) || null : null,
    });
  }
  return [...displays.values()].sort((left, right) => left.displayedAt.localeCompare(right.displayedAt));
}

export async function fetchKilterLiveHistory(
  accessToken: string,
  selection: KilterWallSelection,
  signal?: AbortSignal,
): Promise<KilterLiveDisplay[]> {
  const response = await fetch(`https://${KILTER_PORTAL_HOST}/api/recently-displayed-climbs/climbs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      gymUuid: selection.gymUuid,
      productLayoutUuid: selection.productLayoutUuid,
      wallUuid: selection.wallUuid,
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (response.status !== 200) {
    const retryAfter = response.headers.get('retry-after');
    const delay =
      retryAfter === null
        ? 0
        : /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - Date.now();
    throw new KilterLiveError(response.status, Number.isFinite(delay) ? Math.max(0, delay) : 0);
  }
  return parseKilterLiveHistory(await response.json(), selection);
}
