import { createHash } from 'node:crypto';
import { logger } from '../../utils/logger';
import { CNC_KICKER_SET_IDS, type CncBoardTuple } from './catalog';
import type { CncOrderOptions } from '@boardsesh/db/schema';

/**
 * HTTP client for the pack generator.
 *
 * The generator owns every millimetre of geometry. Boardsesh never recomputes
 * a panel, a seam or a keep-out — it asks. That keeps one implementation of the
 * maths (with the golden tests next to it, in the private repo) instead of a
 * TypeScript copy that drifts, and it is why this module fails closed: a
 * configuration we cannot get a layout for is a configuration we refuse to
 * sell, rather than one we guess at.
 *
 * Two endpoints, both bearer-authenticated over Railway private networking:
 * `POST /layout` for the editor's panel preview and `POST /artwork/validate`
 * for the authoritative artwork verdict.
 */

/** The generator is unreachable, slow, misconfigured, or answered with something unusable. */
export class CncWorkerUnavailableError extends Error {
  constructor(
    message: string,
    /** What actually went wrong, for the log. Never surfaced to the buyer. */
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CncWorkerUnavailableError';
  }
}

/**
 * The generator understood the request and rejected it — a seam through a hole,
 * artwork off its panel, a panel wider than the sheet.
 *
 * Distinct from unavailable on purpose: this one is the buyer's to fix, and the
 * `code` is one of the shared error codes the generator and the configurator
 * both know (`SEAM_TOO_CLOSE_TO_HOLE`, `PANEL_EXCEEDS_SHEET`,
 * `KICKER_NOT_AVAILABLE_FOR_SIZE`, `ARTWORK_COLLISION`, `NOT_IMPLEMENTED`).
 */
export class CncWorkerValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'CncWorkerValidationError';
  }
}

/**
 * A submitted manufacturing option could not be translated into the
 * generator's request shape — not a finite number, not a `<length>x<width>`
 * sheet stock string, or anything else that means the value itself is
 * malformed rather than merely unavailable.
 *
 * Distinct from `CncWorkerUnavailableError` on purpose: nothing left the
 * process, so this is not an outage. The resolvers classify it the same way
 * as `CncWorkerValidationError` — `CNC_INVALID_CONFIG`, the buyer's to fix.
 */
export class CncConfigMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CncConfigMappingError';
  }
}

/**
 * Wall clock budget for one generator call.
 *
 * The layout call sits in front of a keystroke-driven configurator, so a slow
 * generator has to become an error the UI can show rather than a request that
 * hangs until the browser gives up. Five seconds is far above the generator's
 * own budget for a layout (tens of milliseconds of numpy) and low enough that a
 * dead service is obvious.
 */
const WORKER_TIMEOUT_MS = 5_000;

/**
 * Layout responses are pure functions of the request, so the same tuple asked
 * for twice inside a minute is the same answer. Sixty seconds is long enough to
 * absorb a configurator session's repeated calls (every option flip re-asks)
 * and short enough that a generator deploy takes effect on its own.
 */
const CACHE_TTL_MS = 60_000;

/**
 * Cache ceiling. Each entry is a layout response of roughly 40 KB with holes,
 * so 200 caps this at about 8 MB — small next to the backend's heap, and far
 * more distinct configurations than the catalogue can actually produce.
 */
const CACHE_MAX_ENTRIES = 200;

type CacheEntry = { value: unknown; expiresAt: number };

/**
 * Insertion-ordered LRU over a plain Map.
 *
 * A Map iterates in insertion order, so the first key is the least recently
 * used once every read re-inserts its entry. That is the whole eviction policy
 * — worth 15 lines rather than a dependency for one cache.
 */
const responseCache = new Map<string, CacheEntry>();

function readCache(key: string, now: number): CacheEntry | undefined {
  const entry = responseCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    responseCache.delete(key);
    return undefined;
  }
  // Re-insert so this key moves to the young end of the iteration order.
  responseCache.delete(key);
  responseCache.set(key, entry);
  // The entry itself, not `entry.value`: a cached `undefined` would otherwise
  // be indistinguishable from a miss.
  return entry;
}

function writeCache(key: string, value: unknown, now: number): void {
  responseCache.delete(key);
  responseCache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  while (responseCache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey === undefined) break;
    responseCache.delete(oldestKey);
  }
}

/** Drop every cached response. Tests use this; nothing in production does. */
export function clearCncWorkerCache(): void {
  responseCache.clear();
}

/**
 * Serialise with object keys sorted at every depth.
 *
 * `JSON.stringify` preserves insertion order, so two requests that differ only
 * in which order the options object was built would hash differently and miss
 * the cache for no reason. Arrays keep their order — set ids and artwork are
 * sequences, not sets.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
}

function cacheKey(path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${path}\n${canonicalJson(body)}`)
    .digest('hex');
}

// ============================================
// Request shapes (the generator's snake_case contract)
// ============================================

/**
 * The board tuple as the generator names it. snake_case throughout: this is a
 * Python service with pydantic models, and translating at the boundary here is
 * cheaper than making the generator speak two naming conventions.
 */
export type CncWorkerBoardRef = {
  board_name: string;
  layout_id: number;
  size_id: number;
  set_ids: number[];
};

export type CncWorkerSheet = {
  length_mm: number;
  width_mm: number;
  thickness_mm: number;
};

export type CncWorkerKicker = {
  mat_clearance_mm: number;
};

export type CncWorkerManufacturing = {
  sheet: CncWorkerSheet;
  grid_pitch_mm: number;
  tnut_hole_diameter_mm: number;
  led_hole_diameter_mm: number;
  stud_clearance_offset_mm: number;
  /** Present only when the configuration includes kicker sets. */
  kicker?: CncWorkerKicker;
};

export type CncWorkerLayoutRequest = {
  board: CncWorkerBoardRef;
  manufacturing: CncWorkerManufacturing;
};

export type CncWorkerArtworkKind = 'text' | 'svg';

export type CncWorkerPlacement = {
  panel_index: number;
  x_mm: number;
  y_mm: number;
  width_mm: number;
  rotation_deg: number;
};

export type CncWorkerArtworkItem = {
  kind: CncWorkerArtworkKind;
  /** Set for `text` items; null for `svg`. */
  text: string | null;
  /**
   * Which bundled face to outline `text` with. Null lets the generator apply
   * its own default rather than us inventing a face name — and it is always
   * null for an `svg`, which carries its own geometry.
   */
  font: string | null;
  /** Asset id the generator fetches from the backend; null for `text`. */
  asset_ref: string | null;
  mode: string;
  placement: CncWorkerPlacement;
};

// ============================================
// Catalogue options -> generator request
// ============================================

/** Read one option as a finite number, or throw — the catalogue guarantees the value exists. */
function numericOption(options: CncOrderOptions, key: string): number {
  const value = options[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CncConfigMappingError(`Manufacturing option "${key}" is not a number`);
  }
  return parsed;
}

/**
 * Split a `sheetStock` value like "2440x1220" into millimetres.
 *
 * The catalogue stores sheet stock as one enumerated string because that is
 * what a buyer picks off a supplier's list; the generator wants two numbers.
 */
function parseSheetStock(sheetStock: unknown): { lengthMm: number; widthMm: number } {
  const parts = String(sheetStock).split('x');
  const lengthMm = Number(parts[0]);
  const widthMm = Number(parts[1]);
  if (parts.length !== 2 || !Number.isFinite(lengthMm) || !Number.isFinite(widthMm)) {
    throw new CncConfigMappingError(`Manufacturing option "sheetStock" is not <length>x<width>: ${String(sheetStock)}`);
  }
  return { lengthMm, widthMm };
}

export type ToLayoutRequestInput = {
  /**
   * The wall being built. A `CncCatalogEntry` satisfies this, and that is what
   * the resolvers pass — but only the tuple is read, so the generation job can
   * pass a PAID ORDER's own stored tuple instead. That matters when a
   * catalogue entry is retired: the buyer is still owed the pack they paid
   * for, and re-resolving through today's catalogue would refuse to build it.
   */
  entry: CncBoardTuple;
  /** Options already normalised by `validateCatalogOptions` — every key present. */
  options: CncOrderOptions;
  /** Set ids already parsed by `parseSetIds`. Order preserved. */
  setIds: number[];
};

/**
 * Translate a validated Boardsesh configuration into the generator's
 * `LayoutRequest`.
 *
 * Only manufacturing inputs that change geometry cross this boundary. The
 * output options (`dxfFlavour`, `paper`) and the engrave gates ride the
 * generation job instead — they change what is written, never where a hole
 * goes, so including them here would fragment the layout cache for nothing.
 *
 * The catalogue's canonical `sizeId` is what is sent, not whichever LED-kit
 * alias the caller asked with: the alias walls are physically identical, so
 * they must resolve to one layout (and one cache entry).
 */
export function toLayoutRequest({ entry, options, setIds }: ToLayoutRequestInput): CncWorkerLayoutRequest {
  const { lengthMm, widthMm } = parseSheetStock(options.sheetStock);
  // Including either kicker set is what tells the generator to emit the two
  // extra panels. `validateSetIds` has already ruled out the half-kicker case.
  const hasKicker = setIds.some((setId) => CNC_KICKER_SET_IDS.includes(setId));

  return {
    board: {
      board_name: entry.boardName,
      layout_id: entry.layoutId,
      size_id: entry.sizeId,
      set_ids: setIds,
    },
    manufacturing: {
      sheet: {
        length_mm: lengthMm,
        width_mm: widthMm,
        thickness_mm: numericOption(options, 'panelThicknessMm'),
      },
      grid_pitch_mm: numericOption(options, 'gridPitchMm'),
      tnut_hole_diameter_mm: numericOption(options, 'tnutHoleDiameterMm'),
      led_hole_diameter_mm: numericOption(options, 'ledHoleDiameterMm'),
      stud_clearance_offset_mm: numericOption(options, 'studClearanceOffsetMm'),
      // Omitted rather than sent as null for a wall with no kicker: the
      // generator's pydantic model treats a present kicker block as "build
      // one", and a 10 ft wall has no kicker sets to build from.
      ...(hasKicker ? { kicker: { mat_clearance_mm: numericOption(options, 'kickerMatClearanceMm') } } : {}),
    },
  };
}

/** One artwork item as the resolvers receive it, before translation. */
export type CncArtworkRequestItem = {
  assetId?: string | null;
  text?: string | null;
  /** Already checked against `CNC_ARTWORK_FONTS` by the caller. */
  font?: string | null;
  mode: string;
  placement: {
    panelIndex: number;
    xMm: number;
    yMm: number;
    widthMm: number;
    rotationDeg: number;
  };
};

/**
 * Translate artwork items into the generator's shape.
 *
 * `kind` is derived rather than asked for: an item with an asset is an uploaded
 * SVG, anything else is a routed label. Validation upstream guarantees exactly
 * one of the two is set, so there is no third case to encode — and the asset is
 * what the test leads with, because that is the branch whose payload the
 * generator has to go and fetch.
 *
 * `font` rides along only for a label. An SVG carries its own outlines, so a
 * face name on one would be a value the generator has nowhere to apply.
 */
export function toArtworkItems(items: readonly CncArtworkRequestItem[]): CncWorkerArtworkItem[] {
  return items.map((item) => ({
    kind: item.assetId != null ? 'svg' : 'text',
    text: item.text ?? null,
    font: item.assetId != null ? null : (item.font ?? null),
    asset_ref: item.assetId ?? null,
    mode: item.mode,
    placement: {
      panel_index: item.placement.panelIndex,
      x_mm: item.placement.xMm,
      y_mm: item.placement.yMm,
      width_mm: item.placement.widthMm,
      rotation_deg: item.placement.rotationDeg,
    },
  }));
}

// ============================================
// Transport
// ============================================

/**
 * True when both the generator URL and its shared secret are set.
 *
 * Read at call time, not at module load: the backend boots in environments
 * (tests, a web-only dev stack) where the generator simply is not deployed, and
 * every caller has to be able to say "packs are off" rather than crash on
 * import.
 */
export function isWorkerConfigured(): boolean {
  return Boolean(process.env.CNC_WORKER_URL && process.env.CNC_WORKER_SECRET);
}

function workerBaseUrl(): string {
  const url = process.env.CNC_WORKER_URL;
  if (!url) throw new CncWorkerUnavailableError('CNC_WORKER_URL is not set');
  return url.replace(/\/+$/, '');
}

/** The 422 body the generator returns for a rejected configuration. */
type WorkerValidationBody = {
  code?: unknown;
  message?: unknown;
  detail?: unknown;
  details?: unknown;
};

function toValidationError(status: number, body: unknown): CncWorkerValidationError {
  const parsed = (typeof body === 'object' && body !== null ? body : {}) as WorkerValidationBody;
  const code = typeof parsed.code === 'string' ? parsed.code : 'CNC_INVALID_CONFIG';
  const message =
    typeof parsed.message === 'string'
      ? parsed.message
      : typeof parsed.detail === 'string'
        ? parsed.detail
        : `The pack generator rejected this configuration (HTTP ${status}).`;
  return new CncWorkerValidationError(code, message, parsed.details ?? parsed.detail ?? null);
}

/**
 * Parse a response body as JSON.
 *
 * A body read aborted by the same timeout that guards the request is reported
 * as `CncWorkerUnavailableError`, not folded into the generic "unreadable
 * body" case: the generator answered headers but then stalled streaming the
 * body, which is exactly the outage the timeout exists to catch.
 */
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (signal.aborted) {
      throw new CncWorkerUnavailableError('The pack generator did not respond in time', error);
    }
    return null;
  }
}

/**
 * POST to the generator and return its parsed body.
 *
 * The timeout is an explicit AbortController rather than `AbortSignal.timeout`
 * so the timer is a normal `setTimeout` — schedulable, cancellable, and visible
 * to fake timers in tests. It covers reading the response body as well as
 * receiving headers: a generator that answers instantly but then stalls
 * streaming the body must not hang past `WORKER_TIMEOUT_MS` either. The timer
 * is always cleared exactly once, in a `finally` around the whole call, so a
 * slow-but-finished request does not leave the event loop holding it.
 */
async function postToWorker(path: string, body: unknown): Promise<unknown> {
  if (!isWorkerConfigured()) {
    throw new CncWorkerUnavailableError('The pack generator is not configured');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(`${workerBaseUrl()}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.CNC_WORKER_SECRET}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      logger.warn('[cnc-worker] request failed', { path, aborted, error });
      throw new CncWorkerUnavailableError(
        aborted ? 'The pack generator did not respond in time' : 'The pack generator could not be reached',
        error,
      );
    }

    if (response.status === 422) {
      throw toValidationError(response.status, await readJson(response, controller.signal));
    }

    if (!response.ok) {
      // 401/403 means our secret is wrong or rotated — an outage from the
      // buyer's side, but an operator problem, so it is logged at error while
      // every other bad status is a warning.
      const isAuthFailure = response.status === 401 || response.status === 403;
      const detail = { path, status: response.status };
      if (isAuthFailure) {
        logger.error('[cnc-worker] rejected our credentials; check CNC_WORKER_SECRET', detail);
      } else {
        logger.warn('[cnc-worker] unexpected status', detail);
      }
      throw new CncWorkerUnavailableError(`The pack generator returned HTTP ${response.status}`);
    }

    const parsed = await readJson(response, controller.signal);
    if (parsed === null || typeof parsed !== 'object') {
      logger.warn('[cnc-worker] response body was not an object', { path });
      throw new CncWorkerUnavailableError('The pack generator returned an unreadable response');
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

export type FetchLayoutOptions = {
  /**
   * Include every hole position. Roughly 40 KB extra, so the editor asks for it
   * only when it is about to draw the drill pattern.
   */
  includeHoles?: boolean;
};

/**
 * Panel layout for a configuration.
 *
 * Cached, because this is what a configurator hammers: the buyer flips an
 * option, the preview re-asks, and the same handful of tuples come back over
 * and over. The cache key covers `includeHoles`, so the cheap and expensive
 * variants of one request never stand in for each other.
 */
export async function fetchLayout(
  request: CncWorkerLayoutRequest,
  { includeHoles = false }: FetchLayoutOptions = {},
): Promise<unknown> {
  const path = includeHoles ? '/layout?include=holes' : '/layout';
  const key = cacheKey(path, request);
  const now = Date.now();

  const cached = readCache(key, now);
  if (cached) return cached.value;

  const layout = await postToWorker(path, request);
  writeCache(key, layout, now);
  return layout;
}

/**
 * Whether a configuration's artwork fits.
 *
 * Cached on the same terms as the layout: the placement editor debounces
 * against this while the buyer drags, and a drag that returns to where it
 * started must not cost a second round trip.
 */
export async function validateArtwork(
  request: CncWorkerLayoutRequest,
  artwork: readonly CncWorkerArtworkItem[],
): Promise<unknown> {
  const path = '/artwork/validate';
  const body = { layout_request: request, artwork };
  const key = cacheKey(path, body);
  const now = Date.now();

  const cached = readCache(key, now);
  if (cached) return cached.value;

  const verdict = await postToWorker(path, body);
  writeCache(key, verdict, now);
  return verdict;
}
