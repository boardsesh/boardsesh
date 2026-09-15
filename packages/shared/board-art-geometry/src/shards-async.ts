import type { BoardArtGeometry } from './types';

/**
 * The async shard map, on every platform that does not have one.
 *
 * Node, the backend and Metro-for-native all reach the shards through the
 * synchronous `require` index in `generated/shards.ts`, so there is nothing to
 * await and this is `null`. `shards-async.web.ts` is the other half of the pair:
 * Metro picks it for the browser build, where it re-exports the generated
 * `import()` map.
 *
 * Why this is a hand-written pair rather than another export on the generated
 * index: `generated/` is hashed whole into `BOARD_RENDER_VERSION`
 * (scripts/generate-board-render-version.ts), and that version is the cache-buster
 * on `immutable` board images. Adding an export to `generated/shards.ts` would
 * churn it — invalidating a year of CDN copies of every board image — for a
 * change that cannot move a pixel.
 */
export const BOARD_ART_GEOMETRY_SHARDS_ASYNC: Record<string, () => Promise<BoardArtGeometry>> | null = null;
