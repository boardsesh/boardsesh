// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

import type { BoardName } from '@boardsesh/shared-schema';

/**
 * The shard contract (issue #2202).
 *
 * FROZEN. A Rust renderer reads these tables through the same field names, so a
 * field cannot change meaning, change units, or grow a sentinel without that
 * renderer changing with it. Anything genuinely new goes in a new field.
 */

/** Which board a shard belongs to. Set ids are deliberately absent — see `BoardArtGeometryKey`. */
export type BoardArtGeometryQuery = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
};

/**
 * `"<boardName>/<layoutId>-<sizeId>"` — the shard key and the `wallLightness`
 * row key.
 *
 * There is no set-id component on purpose, and the tracer makes that exact
 * rather than merely adequate: each placement is traced against the ONE art
 * layer that draws it, partitioned only over the other placements on that same
 * layer, so nothing about a hold's silhouette depends on which other sets are
 * mounted. Mount three sets or nineteen and the holds you get back are the ones
 * this table already holds. A per-subset table would be combinatorial (Decoy 2-1
 * alone mounts 19 layers) for a difference that provably does not exist.
 */
export type BoardArtGeometryKey = string;

/**
 * One layout+size's traced art, in units of the placement's own radius.
 *
 * Radius units rather than board pixels because the same shard is drawn at
 * every surface size, and because a board's pixels are not another's: MoonBoard
 * authors its art in a 650 px box against 1080 for most of the catalogue, so an
 * absolute board-pixel figure bites 1.66x harder there.
 */
export type BoardArtGeometry = {
  /**
   * `placementId` -> flat `[x0, y0, x1, y1, ...]` polygon, closed implicitly
   * (the last point joins the first), in units of that placement's radius `r`
   * relative to its centre: `(x - cx) / r`, `(y - cy) / r`. Rounded to 4
   * decimals, which is 0.005 board px at the catalogue's smallest radius.
   *
   * A placement with no traceable art of its own is ABSENT. That is not an edge
   * case — MoonBoard's placements are a synthetic 11x18 grid and most cells
   * genuinely carry no hold — so a consumer must fall back to a ring at the
   * placement radius rather than treating the gap as an error.
   */
  outlines: Record<number, number[]>;
  /**
   * `placementId` -> mean OkLab lightness (0..1) of the board art inside the
   * traced silhouette, alpha-weighted so a transparent gap counts as play field
   * rather than as black art.
   *
   * Only placements that HAVE an outline appear. There is no `-1` sentinel: the
   * spike shipped one and a `?? target` read straight past it, painting 94 of
   * MoonBoard's 198 holds as if their art were black.
   */
  silhouetteLightness: Record<number, number>;
  /**
   * `placementId` -> `[dx, dy]` in radius units from the placement centre to the
   * centroid of the bright LED blob the board art already paints.
   *
   * Present ONLY for placements the art paints bright at the LED location, which
   * is the case a renderer has to cover: Grasshopper paints 234 of its 332 LED
   * locations bright and the rest dark, so an unlit hold looks lit and a lit one
   * looks dead unless the renderer takes the dot over. The board's own LED
   * offset is folded in — on MoonBoard the LED sits half a row below the hold —
   * so `[dx, dy]` is always measured from the placement centre and needs no
   * second table.
   *
   * The MoonBoard fold is a guarantee for future art, not a path any shard
   * uses: no shipped MoonBoard shard has a bright pixel there, so every
   * MoonBoard `ledBright` table is empty.
   */
  ledBright: Record<number, [number, number]>;
  /**
   * `placementId` -> flat ring of the INNER boundary of the hold's LED base
   * plate, in the same radius units and the same implicitly-closed form as
   * `outlines`. The lit region is the silhouette MINUS this polygon: the ring of
   * plate visible around the hold proper, which is the part that actually glows.
   *
   * OPTIONAL, and absent from most shards. Nothing extracts this from the art
   * yet — every entry is hand-annotated through `hold_outline_overrides`
   * (`kind = 'led_inner'`), so a shard carries the table only once someone has
   * drawn one, and a placement appears in it only if someone drew that one. An
   * automatic extractor can fill the same field later with no consumer change.
   *
   * The frozen contract's sanctioned extension path is a NEW optional field, and
   * this is one: a renderer that has never heard of `ledInner` reads exactly what
   * it read before. Consumers must treat an absent table and an absent placement
   * identically — light the whole silhouette.
   */
  ledInner?: Record<number, number[]>;
};

/**
 * How bright one layout+size's wall is, over the annulus a selector ring is
 * drawn in (0.85r..1.15r) — what a mark has to compete with.
 */
export type WallLightness = {
  /**
   * Mean OkLab lightness over the placements that have a reading at all.
   * Placements whose annulus holds no art are excluded, not averaged in as 0:
   * averaging them measures how EMPTY a board is rather than how bright, which
   * dragged both MoonBoards to 0.30/0.34 and turned their veil off entirely.
   */
  mean: number;
  /** Share of the board's placements that carry an annulus reading at all, 0..1. */
  coverage: number;
};

export type WallLightnessTable = Record<BoardArtGeometryKey, WallLightness>;

/** Traced outlines against total placements, per shard — the gate-4 pins. */
export type OutlineCounts = {
  traced: number;
  placements: number;
};

export type OutlineCountsTable = Record<BoardArtGeometryKey, OutlineCounts>;

/** The shard key for a board config. Set ids are ignored — see `BoardArtGeometryKey`. */
export function boardArtGeometryKey({ boardName, layoutId, sizeId }: BoardArtGeometryQuery): BoardArtGeometryKey {
  return `${boardName}/${layoutId}-${sizeId}`;
}
