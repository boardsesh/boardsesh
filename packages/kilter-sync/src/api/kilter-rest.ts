import { KILTER_PORTAL_HOST } from './types';
import { KilterApiError } from './errors';

/**
 * REST client primitives for the Kilter push surface (/api/logs/bulk,
 * /api/climb-rating, /api/circuits, /api/circuit-climbs). The auth header
 * is the same Keycloak access token that authenticates the PowerSync
 * stream.
 *
 * Only the typed payload shapes and the shared `authedFetch` / `ensureOk`
 * helpers live here. The actual POST flows haven't been wire-verified
 * against a real Kilter account yet — push-back is gated behind
 * KILTER_SYNC_PUSH_ENABLED in `sync/push-back.ts` and stays dormant until
 * we capture real upstream traffic.
 */

const REQUEST_TIMEOUT_MS = 30_000;

export type LogPushItem = {
  /**
   * Boardsesh tick UUID. Round-trips through Kilter's response so we can
   * back-fill kilter_id on the matching row without keeping a side-table
   * of pending pushes.
   */
  clientReference: string;
  climbUuid: string;
  angle: number;
  /**
   * `true` for flash/send, `false` for attempts. Whether Kilter uses a
   * single endpoint with this flag vs. a separate /api/attempts/ endpoint
   * is one of the open questions in §7 of the design doc.
   */
  topped: boolean;
  attemptCount: number;
  quality?: number;
  difficulty?: number;
  isMirror: boolean;
  comment?: string;
  /** ISO 8601 UTC */
  climbedAt: string;
};

export type LogPushResult = {
  clientReference: string;
  /** The UUID Kilter assigns. Written back as boardsesh_ticks.kilter_id. */
  logUuid: string;
};

export type RatingPushItem = {
  clientReference: string;
  climbUuid: string;
  angle: number;
  rating?: number;
  difficultyGradeId?: number;
  comment?: string;
};

export type RatingPushResult = {
  clientReference: string;
  climbRatingUuid: string;
};

export type CircuitPushItem = {
  clientReference: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  climbs: Array<{
    climbUuid: string;
    angle: number | null;
    position: number;
  }>;
};

export type CircuitPushResult = {
  clientReference: string;
  circuitUuid: string;
};

async function authedFetch(path: string, accessToken: string, init: RequestInit): Promise<Response> {
  const url = `https://${KILTER_PORTAL_HOST}${path}`;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  try {
    return await fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new KilterApiError('timeout', `${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw new KilterApiError('network', `${path} request failed: ${(err as Error).message ?? err}`);
  }
}

async function ensureOk(path: string, response: Response): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  if (response.status === 401) {
    throw new KilterApiError('unauthorized', `${path} returned 401 — access token rejected`, 401);
  }
  if (response.status === 429) {
    throw new KilterApiError('rate_limited', `${path} rate-limited`, 429);
  }
  throw new KilterApiError('http', `${path} returned ${response.status}: ${text.slice(0, 200)}`, response.status);
}

/**
 * Re-exported so callers in user-sync don't have to import from ./errors
 * directly — keeps the API surface tidy.
 */
export { authedFetch, ensureOk };
