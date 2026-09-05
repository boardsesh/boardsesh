// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

import type { BoardArtGeometry, BoardArtGeometryQuery, OutlineCountsTable, WallLightness } from './types';
import { boardArtGeometryKey } from './types';
import { BOARD_ART_GEOMETRY_SHARDS, WALL_LIGHTNESS, loadOutlineCounts } from './generated/shards';

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
 */

const shardCache = new Map<string, BoardArtGeometry | null>();

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
  const geometry = shard ? shard() : null;
  shardCache.set(key, geometry);
  return geometry;
}

/**
 * How bright one board config's wall is, for `veilOpacityFor`. Eager: the whole
 * table is 51 rows of two numbers, and the veil decision is made before any
 * shard is needed.
 */
export function getWallLightness(query: BoardArtGeometryQuery): WallLightness | null {
  return WALL_LIGHTNESS[boardArtGeometryKey(query)] ?? null;
}

/** Every shard key the package ships, sorted. */
export function listBoardArtGeometryKeys(): string[] {
  return Object.keys(BOARD_ART_GEOMETRY_SHARDS).sort();
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
}
