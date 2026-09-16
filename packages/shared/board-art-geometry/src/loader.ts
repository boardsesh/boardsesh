import type {
  BoardArtGeometry,
  BoardArtGeometryKey,
  BoardArtGeometryQuery,
  OutlineCountsTable,
  WallLightness,
} from './types';
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
 *
 * One exception, and it is deliberate: a chunk whose download has failed
 * `MAX_SHARD_DOWNLOAD_ATTEMPTS` times is written as `null` so the answer becomes
 * final. See `MAX_SHARD_DOWNLOAD_ATTEMPTS`.
 */
const shardCache = new Map<string, BoardArtGeometry | null>();

/** In-flight `import()` calls, so N concurrent rows fetch one chunk, not N. */
const pendingShards = new Map<string, Promise<BoardArtGeometry | null>>();

/**
 * Geometry handed in at RUNTIME rather than shipped as a shard, consulted before
 * anything else (issue #5440).
 *
 * A spray wall is photographed by its owner and its holds arrive from the
 * server, so there is no build-time shard for it and there never can be: the
 * board did not exist when the tables were generated. The mobile spray registry
 * maps a wall's canonical holds into the version's photo and registers the
 * resulting silhouettes here, under the same `spray/<layoutId>-<sizeId>` key
 * `boardArtGeometryKey` produces for every other board. Existing consumers —
 * `use-native-climb-render.ts`, the backend's `board-geometry.ts` — then read a
 * wall's true hold shapes through the call they already make.
 *
 * Checked FIRST, and kept out of `shardCache`, for two reasons. A wall reset
 * replaces the whole table (new photo, new hold generation), and a re-register
 * has to take effect at once rather than sit behind an entry the shard cache has
 * already memoised. And nothing may overwrite a shipped shard by accident: a
 * runtime key colliding with a catalogue one would silently repaint a real
 * board, so registering is the caller's explicit act and
 * `unregisterRuntimeGeometry` puts the catalogue answer back.
 */
const runtimeGeometry = new Map<string, BoardArtGeometry>();

/**
 * Publish geometry for a config the shards do not cover, replacing whatever was
 * registered under the same key.
 *
 * Replacement is the point: a spray wall's version-2 holds must never be drawn
 * alongside version-1's leftovers.
 */
export function registerRuntimeGeometry(key: BoardArtGeometryKey, geometry: BoardArtGeometry): void {
  runtimeGeometry.set(key, geometry);
}

/** Withdraw runtime geometry, so the key falls back to the shards (for a wall: to nothing). */
export function unregisterRuntimeGeometry(key: BoardArtGeometryKey): void {
  runtimeGeometry.delete(key);
}

/** What is registered under a key right now, or `null`. */
export function getRuntimeGeometry(key: BoardArtGeometryKey): BoardArtGeometry | null {
  return runtimeGeometry.get(key) ?? null;
}

/**
 * How many times one key's chunk may be fetched before a persistent failure is
 * answered as "no art for this board".
 *
 * Without a cap, "the download failed" and "the download has not finished" are
 * the same observable state — `boardArtGeometryPending` stays `true` — so a
 * caller that re-renders on the pending flag and asks again gets an unbounded
 * import loop off one offline board. Three attempts covers the transient drop
 * this retry exists for; past that the ring fallback is the honest answer, and
 * it costs the silhouettes of one board until the page is reloaded.
 */
const MAX_SHARD_DOWNLOAD_ATTEMPTS = 3;

/** Failed `import()` count per key, cleared as soon as one succeeds. */
const shardFailureCounts = new Map<string, number>();

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
  // Runtime geometry outranks everything, including a memoised `null` — see
  // `runtimeGeometry`.
  const runtime = runtimeGeometry.get(key);
  if (runtime) return runtime;

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
  // Registered runtime geometry is already in hand, so nothing is in flight.
  if (runtimeGeometry.has(key)) return false;
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
 * transient network error should cost the silhouettes, not the board. After
 * `MAX_SHARD_DOWNLOAD_ATTEMPTS` failures that `null` becomes the cached answer,
 * so a caller polling on `boardArtGeometryPending` cannot loop forever.
 */
export async function prefetchBoardArtGeometry(query: BoardArtGeometryQuery): Promise<BoardArtGeometry | null> {
  const key = boardArtGeometryKey(query);
  const runtime = runtimeGeometry.get(key);
  if (runtime) return runtime;

  const cached = shardCache.get(key);
  if (cached !== undefined) return cached;

  const inFlight = pendingShards.get(key);
  if (inFlight) return inFlight;

  const asyncShard = BOARD_ART_GEOMETRY_SHARDS_ASYNC?.[key];
  if (!asyncShard) return loadBoardArtGeometry(query);

  const loading = asyncShard()
    .then((geometry) => {
      shardFailureCounts.delete(key);
      shardCache.set(key, geometry);
      return geometry;
    })
    .catch(() => {
      const failures = (shardFailureCounts.get(key) ?? 0) + 1;
      // Not cached while retries remain: a failed download is not evidence the
      // shard is absent, and the next board view should be free to try again.
      // Once they run out it IS cached, as `null` — that stops
      // `boardArtGeometryPending` reporting the key as still in flight, which is
      // what a caller re-asking on every render is reading. The tally has done
      // its job by then, and that cached `null` short-circuits every later call
      // before this handler, so drop the count rather than hold it for the rest
      // of the session.
      if (failures >= MAX_SHARD_DOWNLOAD_ATTEMPTS) {
        shardCache.set(key, null);
        shardFailureCounts.delete(key);
      } else {
        shardFailureCounts.set(key, failures);
      }
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

/**
 * Drop the memoised shards AND every runtime registration. Tests only; the
 * tables behind a catalogue key never change at runtime, and a wall's
 * registration is withdrawn by name (`unregisterRuntimeGeometry`) in production.
 */
export function clearBoardArtGeometryCache(): void {
  shardCache.clear();
  pendingShards.clear();
  runtimeGeometry.clear();
}
