import { KILTER_PORTAL_HOST } from './types';
import { KilterApiError, responseRetryAfterMs } from './errors';

/**
 * REST client primitives for the Kilter push surface (the packaged
 * /api/v2/logs/bulk and /api/v2/climb-rating candidates, plus circuit routes). The auth header
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
  /**
   * Raw Boardsesh/Kilter Grips scale (1-5). Grips is natively 1-5
   * (catalog-sync.ts, user-sync.ts), not Aurora 1-3. Confirm the scale
   * against checked /api/v2/logs traffic when wiring up the POST.
   */
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
    throw new KilterApiError('rate_limited', `${path} rate-limited`, 429, responseRetryAfterMs(response));
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
// GET `/climbs/climbdetails/{productName}/edges` returned 404. The app
// instead POSTs to the literal `/climbs/climbdetails/productName/edges`;
// see fetchCatalogDelta below for its timestamp-filtered read contract.
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
const CATALOG_RETRY_AFTER_CAP_MS = 5 * 60 * 1000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// GET a catalog endpoint with a generous timeout and exponential backoff on
// 429. Returns the parsed JSON array. Non-429 errors propagate immediately.
// A caller's signal (a background job's shutdown or lost lease) cuts the
// request and any backoff short, and surfaces as itself, not as a timeout.
async function catalogGet<T>(
  path: string,
  accessToken: string,
  signal?: AbortSignal,
  query?: KilterCatalogDeltaQuery,
): Promise<T[]> {
  let attempt = 0;
  for (;;) {
    signal?.throwIfAborted();
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
      response = await fetch(`https://${KILTER_PORTAL_HOST}${path}`, {
        method: query ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          ...(query ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(query ? { body: JSON.stringify(query) } : {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new KilterApiError('timeout', `${path} timed out after ${CATALOG_TIMEOUT_MS}ms`);
      }
      throw new KilterApiError('network', `${path} request failed: ${(err as Error).message ?? err}`);
    }

    if (response.status === 429 && attempt < CATALOG_MAX_RETRIES) {
      // Honour Retry-After when present (seconds or an HTTP date), else
      // exponential backoff capped at 30s.
      const retryAfterMs = responseRetryAfterMs(response);
      if (retryAfterMs !== undefined && retryAfterMs > CATALOG_RETRY_AFTER_CAP_MS) {
        // Longer than this request may sleep: retrying inside the window would
        // only call Kilter again while it asked us not to. Hand the whole delay
        // to the runner, which parks the catalog slot and the donor for it.
        throw new KilterApiError(
          'rate_limited',
          `${path} rate limited for ${retryAfterMs}ms (Retry-After)`,
          429,
          retryAfterMs,
        );
      }
      const backoffMs =
        retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : Math.min(30_000, 1000 * 2 ** attempt);
      attempt += 1;
      await sleep(backoffMs, signal);
      continue;
    }

    await ensureOk(path, response);
    try {
      const rows = (await response.json()) as T[];
      signal?.throwIfAborted();
      return rows;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new KilterApiError('timeout', `${path} body timed out after ${CATALOG_TIMEOUT_MS}ms`);
      }
      throw new KilterApiError('unknown', `${path} returned an unreadable JSON response`);
    }
  }
}

/** All climbs for one product layout (the catalog read path). */
export function fetchLayoutClimbs(
  accessToken: string,
  productLayoutUuid: string,
  signal?: AbortSignal,
): Promise<KilterCatalogClimb[]> {
  return catalogGet<KilterCatalogClimb>(
    `/api/climbs/all/${encodeURIComponent(productLayoutUuid)}`,
    accessToken,
    signal,
  );
}

/** All (climb, angle) stats for one product layout. */
export function fetchLayoutClimbStats(
  accessToken: string,
  productLayoutUuid: string,
  signal?: AbortSignal,
): Promise<KilterCatalogStat[]> {
  return catalogGet<KilterCatalogStat>(
    `/api/climb-stat/all/${encodeURIComponent(productLayoutUuid)}`,
    accessToken,
    signal,
  );
}

/** UUIDs Kilter has deleted server-side, for deletion reconciliation. */
export function fetchDeletedClimbUuids(accessToken: string, signal?: AbortSignal): Promise<string[]> {
  return catalogGet<string>('/api/climbs/delteduuids', accessToken, signal);
}

/** The app's literal POST route: productName is a body field, not a path parameter. */
export type KilterCatalogDeltaQuery = {
  productName: string;
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
  limit: number;
  offset: number;
  excludeProductLayoutUuid: string | null;
  prioritizedProductLayoutUuid: string | null;
  /** UTC request-start watermark with the caller's overlap; null requests metadata bootstrap. */
  lastUpdatedAt: string | null;
};

export type KilterCatalogDeltaRow = Omit<KilterCatalogClimb, 'description' | 'isDeleted' | 'origin'> & {
  description?: string | null;
  isDeleted?: boolean;
  origin?: string | null;
  /** The climb's original angle; this is NOT the inline statistic's angle. */
  angle?: number;
  derivativeAngle?: number;
  ascentCount?: number;
  currentDifficultyId?: number | null;
  officialKilterDifficulty?: number;
  difficultyAverage?: number | null;
  qualityAverage?: number | null;
  faUsername?: string | null;
  faAt?: string | null;
};

export type KilterCatalogDeltaRecord = {
  climb: KilterCatalogClimb;
  stat: KilterCatalogStat | null;
  /** Complete response row for durable deferral and replay. */
  raw: KilterCatalogDeltaRow;
};

function deltaResponseError(rowIndex: number, field: string): never {
  throw new KilterApiError('unknown', `catalog delta row ${rowIndex}: invalid ${field}`);
}

function parseDeltaRow(raw: unknown, rowIndex: number): KilterCatalogDeltaRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) deltaResponseError(rowIndex, 'row');
  const fields = raw as Record<string, unknown>;
  for (const field of [
    'climbUuid',
    'climbConcat',
    'name',
    'productName',
    'productLayoutUuid',
    'createdAt',
    'updatedAt',
  ]) {
    if (typeof fields[field] !== 'string') deltaResponseError(rowIndex, field);
  }
  for (const field of ['edgeLeft', 'edgeRight', 'edgeBottom', 'edgeTop', 'frameCount', 'framesPace']) {
    if (typeof fields[field] !== 'number' || !Number.isFinite(fields[field])) deltaResponseError(rowIndex, field);
  }
  for (const field of ['allowMatch', 'isDraft', 'isListed']) {
    if (typeof fields[field] !== 'boolean') deltaResponseError(rowIndex, field);
  }
  for (const field of ['description', 'origin', 'username', 'userUuid', 'faUsername', 'faAt']) {
    if (fields[field] != null && typeof fields[field] !== 'string') deltaResponseError(rowIndex, field);
  }
  for (const field of [
    'accumulatedHoldSetValue',
    'angle',
    'currentDifficultyId',
    'difficultyAverage',
    'qualityAverage',
  ]) {
    if (fields[field] != null && (typeof fields[field] !== 'number' || !Number.isFinite(fields[field]))) {
      deltaResponseError(rowIndex, field);
    }
  }
  if (fields.isDeleted !== undefined && typeof fields.isDeleted !== 'boolean')
    deltaResponseError(rowIndex, 'isDeleted');
  const hasStat = fields.derivativeAngle !== undefined;
  if (hasStat) {
    if (!Number.isInteger(fields.derivativeAngle)) deltaResponseError(rowIndex, 'derivativeAngle');
    if (!Number.isSafeInteger(fields.ascentCount) || (fields.ascentCount as number) < 0) {
      deltaResponseError(rowIndex, 'ascentCount');
    }
    for (const field of ['currentDifficultyId', 'difficultyAverage', 'qualityAverage']) {
      if (fields[field] === undefined) deltaResponseError(rowIndex, field);
    }
  } else if (fields.ascentCount !== undefined) {
    deltaResponseError(rowIndex, 'derivativeAngle');
  }
  const row = raw as KilterCatalogDeltaRow;
  return {
    raw: row,
    climb: {
      ...row,
      description: row.description ?? '',
      userUuid: row.userUuid ?? null,
      username: row.username ?? null,
      accumulatedHoldSetValue: row.accumulatedHoldSetValue ?? null,
      isDeleted: row.isDeleted ?? false,
      origin: row.origin ?? null,
    },
    stat: hasStat
      ? {
          climbUuid: row.climbUuid,
          angle: row.derivativeAngle!,
          ascentCount: row.ascentCount!,
          currentDifficultyId: row.currentDifficultyId ?? null,
          difficultyAverage: row.difficultyAverage ?? null,
          qualityAverage: row.qualityAverage ?? null,
          faUsername: row.faUsername ?? null,
          faAt: row.faAt ?? null,
        }
      : null,
  };
}

/**
 * Consume the complete timestamp response. On 2026-11-08 a request with limit=1
 * returned 4,156 rows, including statistics-only changes to old climbs. Do not
 * slice to limit, page by offset, or derive a cursor from climb.updatedAt.
 * Call through the catalog's withToken helper to refresh rejected credentials.
 */
export async function fetchCatalogDelta(
  accessToken: string,
  query: KilterCatalogDeltaQuery,
  signal?: AbortSignal,
): Promise<KilterCatalogDeltaRecord[]> {
  const rows: unknown = await catalogGet<unknown>(
    '/api/climbs/climbdetails/productName/edges',
    accessToken,
    signal,
    query,
  );
  signal?.throwIfAborted();
  if (!Array.isArray(rows)) throw new KilterApiError('unknown', 'catalog delta response must be an array');
  return rows.map(parseDeltaRow);
}
