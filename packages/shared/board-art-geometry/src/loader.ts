import type { BoardArtGeometry, BoardArtGeometryQuery, OutlineCountsTable, WallLightness } from './types';
import { boardArtGeometryKey } from './types';
import { BOARD_ART_GEOMETRY_SHARDS, WALL_LIGHTNESS, loadOutlineCounts } from './generated/shards';
import { BOARD_ART_GEOMETRY_SHARDS_ASYNC } from './shards-async';

/**
 * Lazy per-config loader for the traced board art (issue #2202).
 *
 * The shards are one `.cjs` file per `(board, layout, size)`, required on first
 * ask and cached. Kilter alone has 16 of them; on Hermes (Android, no JIT)
 * evaluating the whole catalogue at once to draw one board is exactly the cost
 * the hole-placement shards were split up to avoid.
 *
 * The dual `require` / `createRequire` mechanism the shard index uses lives in
 * `generated/shards.ts`, copied from `@boardsesh/board-constants`'
 * `hole-placements.ts`: it is the only shape that resolves in Metro, webpack,
 * bare Node ESM and vitest at once.
 *
 * ## Web is asynchronous
 *
 * Metro's `require` is synchronous, so those literal `require` calls put all 51
 * shards in the bundle even though each thunk around them is lazy. That is
 * tolerable in a binary the user already installed; it is 4.4 MB of a browser
 * app's first load, for polygons of fifty boards the reader is not on. So the
 * web build resolves `./generated/shards` to `shards.web.ts`, which leaves
 * `BOARD_ART_GEOMETRY_SHARDS` empty and fills `BOARD_ART_GEOMETRY_SHARDS_ASYNC`
 * with `import()` thunks that Metro emits as one chunk per board.
 *
 * `loadBoardArtGeometry` therefore cannot be the whole story on web: it is
 * synchronous and it stays synchronous, because the backend's renderer
 * (`board-render.ts`, `board-geometry.ts`, `hold-outline-overrides.ts`) calls it
 * on the draw path. Web callers `await prefetchBoardArtGeometry` first and then
 * read the result back out of the same cache.
 */

/**
 * `null` means "the catalogue has no shard for this key" — a real answer the
 * renderer acts on by falling back to a ring. A key that is merely *not loaded
 * yet* must never be written here, or that fallback becomes permanent for the
 * session. Pending loads live in `pendingShards` instead.
 */
const shardCache = new Map<string, BoardArtGeometry | null>();

/** In-flight `import()` calls, so N concurrent rows fetch one chunk, not N. */
const pendingShards = new Map<string, Promise<BoardArtGeometry | null>>();

/**
 * The traced silhouettes, silhouette lightness and painted-LED offsets for one
 * board config, or `null` where the catalogue has no shard for it.
 *
 * `null` is a normal answer, not an error: a board whose art was missing when
 * the tables were generated has no shard, and the caller falls back to a ring at
 * the placement radius — the same fallback a traced board needs for the
 * placements inside it that carry no art.
 *
 * Set ids are not part of the key. Every shard is traced with every set of its
 * layout and size mounted; see `BoardArtGeometryKey`.
 */
export function loadBoardArtGeometry(query: BoardArtGeometryQuery): BoardArtGeometry | null {
  const key = boardArtGeometryKey(query);
  const cached = shardCache.get(key);
  if (cached !== undefined) return cached;

  const shard = BOARD_ART_GEOMETRY_SHARDS[key];
  if (shard) {
    const geometry = shard();
    shardCache.set(key, geometry);
    return geometry;
  }

  // No synchronous shard. On web that is the normal case for a key the async
  // map does cover — the chunk is still downloading, so answer "not yet" WITHOUT
  // caching, and let `prefetchBoardArtGeometry` fill the cache when it lands.
  if (BOARD_ART_GEOMETRY_SHARDS_ASYNC?.[key]) return null;

  // Genuinely absent from the catalogue. Cache it: this answer never changes.
  shardCache.set(key, null);
  return null;
}

/**
 * True when this config's art exists but has not arrived yet — i.e. web, chunk
 * still in flight.
 *
 * Callers that memoise something derived from the geometry need this to tell a
 * board the tracer skipped (cache it, the answer is final) from one that is
 * merely still downloading (do not cache it, or the ring fallback sticks for the
 * rest of the session). Always `false` where the shards are synchronous.
 */
export function boardArtGeometryPending(query: BoardArtGeometryQuery): boolean {
  const key = boardArtGeometryKey(query);
  if (shardCache.has(key)) return false;
  return Boolean(BOARD_ART_GEOMETRY_SHARDS_ASYNC?.[key]);
}

/**
 * Make `loadBoardArtGeometry(query)` able to answer, then resolve.
 *
 * A no-op everywhere the shards are synchronous (native, backend, vitest) — the
 * first `loadBoardArtGeometry` there does the work itself. On web it awaits the
 * config's chunk and fills the cache, so the caller can re-render and read the
 * art back synchronously.
 *
 * Never rejects. A chunk that fails to download resolves as `null`, which is the
 * same ring fallback the renderer already draws for an untraced board — a
 * transient network error should cost the silhouettes, not the board.
 */
export async function prefetchBoardArtGeometry(query: BoardArtGeometryQuery): Promise<BoardArtGeometry | null> {
  const key = boardArtGeometryKey(query);
  const cached = shardCache.get(key);
  if (cached !== undefined) return cached;

  const inFlight = pendingShards.get(key);
  if (inFlight) return inFlight;

  const asyncShard = BOARD_ART_GEOMETRY_SHARDS_ASYNC?.[key];
  if (!asyncShard) return loadBoardArtGeometry(query);

  const loading = asyncShard()
    .then((geometry) => {
      shardCache.set(key, geometry);
      return geometry;
    })
    .catch(() => {
      // Deliberately not cached: a failed download is not evidence the shard is
      // absent, and the next board view should be free to try again.
      return null;
    })
    .finally(() => {
      pendingShards.delete(key);
    });

  pendingShards.set(key, loading);
  return loading;
}

/**
 * How bright one board config's wall is, for `veilOpacityFor`. Eager: the whole
 * table is 51 rows of two numbers, and the veil decision is made before any
 * shard is needed.
 */
export function getWallLightness(query: BoardArtGeometryQuery): WallLightness | null {
  return WALL_LIGHTNESS[boardArtGeometryKey(query)] ?? null;
}

/**
 * Every shard key the package ships, sorted.
 *
 * Reads both maps because only one of them is populated on any given platform:
 * the synchronous one off web, the async one on it. Answering `[]` in a browser
 * would be a lie — the shards are all there, they are just a fetch away.
 */
export function listBoardArtGeometryKeys(): string[] {
  const keys = new Set([
    ...Object.keys(BOARD_ART_GEOMETRY_SHARDS),
    ...Object.keys(BOARD_ART_GEOMETRY_SHARDS_ASYNC ?? {}),
  ]);
  return [...keys].sort();
}

/**
 * Traced-vs-total placement counts per shard, as recorded by the run that wrote
 * the tables. Loaded on demand — it is a generation record the gates pin, not
 * something the renderer reads on the draw path.
 */
export function getOutlineCounts(): OutlineCountsTable {
  return loadOutlineCounts();
}

/** Drop the memoised shards. Tests only; the tables behind a key never change at runtime. */
export function clearBoardArtGeometryCache(): void {
  shardCache.clear();
  pendingShards.clear();
}
