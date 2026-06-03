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

// ---------------------------------------------------------------------------
// Catalog read surface (Flow A)
//
// Verified live 2026-06-02 against a real Kilter account. The documented
// `/climbs/climbdetails/{productName}/edges` paging does NOT exist (404).
// The real catalog read is per-product-layout and unpaginated:
//   GET /api/climbs/all/{productLayoutUuid}        → full climb array
//   GET /api/climb-stat/all/{productLayoutUuid}    → full stat array
//   GET /api/climbs/delteduuids                    → deleted uuid array (sic)
// `productLayoutUuid` is a small integer-as-string ("27"), sourced from the
// PowerSync `product_layouts` reference table. Responses are camelCase.
// ---------------------------------------------------------------------------

// A single climb row from /climbs/all/{plu}. snake_case board_* mapping is
// done in sync/catalog-sync.ts; these are the verbatim wire fields.
export type KilterCatalogClimb = {
  climbUuid: string;
  climbConcat: string;
  name: string;
  description: string;
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
  frameCount: number;
  framesPace: number;
  userUuid: string | null;
  username: string | null;
  productName: string;
  productLayoutUuid: string;
  allowMatch: boolean;
  isDraft: boolean;
  isListed: boolean;
  isDeleted: boolean;
  accumulatedHoldSetValue: number | null;
  origin: string | null;
  createdAt: string;
  updatedAt: string;
};

// A single (climb, angle) stat row from /climb-stat/all/{plu}.
export type KilterCatalogStat = {
  climbUuid: string;
  angle: number;
  ascentCount: number;
  currentDifficultyId: number | null;
  difficultyAverage: number | null;
  qualityAverage: number | null;
  faUsername: string | null;
  faAt: string | null;
};

// Per-layout catalog responses are large (the biggest layout returns
// ~180k climbs / tens of MB), so the 30s push timeout is far too short.
const CATALOG_TIMEOUT_MS = 240_000;
const CATALOG_MAX_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// GET a catalog endpoint with a generous timeout and exponential backoff on
// 429. Returns the parsed JSON array. Non-429 errors propagate immediately.
async function catalogGet<T>(path: string, accessToken: string): Promise<T[]> {
  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`https://${KILTER_PORTAL_HOST}${path}`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new KilterApiError('timeout', `${path} timed out after ${CATALOG_TIMEOUT_MS}ms`);
      }
      throw new KilterApiError('network', `${path} request failed: ${(err as Error).message ?? err}`);
    }

    if (response.status === 429 && attempt < CATALOG_MAX_RETRIES) {
      // Honour Retry-After when present, else exponential backoff capped at 30s.
      const retryAfter = Number(response.headers.get('retry-after'));
      const backoffMs =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 1000 * 2 ** attempt);
      attempt += 1;
      await sleep(backoffMs);
      continue;
    }

    await ensureOk(path, response);
    return (await response.json()) as T[];
  }
}

/** All climbs for one product layout (the catalog read path). */
export function fetchLayoutClimbs(accessToken: string, productLayoutUuid: string): Promise<KilterCatalogClimb[]> {
  return catalogGet<KilterCatalogClimb>(`/api/climbs/all/${encodeURIComponent(productLayoutUuid)}`, accessToken);
}

/** All (climb, angle) stats for one product layout. */
export function fetchLayoutClimbStats(accessToken: string, productLayoutUuid: string): Promise<KilterCatalogStat[]> {
  return catalogGet<KilterCatalogStat>(`/api/climb-stat/all/${encodeURIComponent(productLayoutUuid)}`, accessToken);
}

/** UUIDs Kilter has deleted server-side, for deletion reconciliation. */
export function fetchDeletedClimbUuids(accessToken: string): Promise<string[]> {
  return catalogGet<string>('/api/climbs/delteduuids', accessToken);
}
