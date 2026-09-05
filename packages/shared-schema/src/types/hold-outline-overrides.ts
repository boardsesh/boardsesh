// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * What a stored ring traces.
 *
 * `SILHOUETTE` is the hold's outer boundary — the shape the tracer produces and
 * the renderer lights. `LED_INNER` is the inner boundary of the same hold's LED
 * base plate: the lit ring region is the silhouette MINUS that polygon, so a
 * `LED_INNER` ring stores no part of the outer edge and is only meaningful
 * alongside the silhouette it sits inside.
 */
export type HoldOutlineKind = 'SILHOUETTE' | 'LED_INNER';

/** One placement's silhouette: a flat, implicitly-closed `[x0, y0, x1, y1, ...]` ring in radius units. */
export type PlacementOutline = {
  placementId: number;
  outline: number[];
};

/** A hand-drawn hold outline, replacing or annotating what the tracer produced for one placement. */
export type HoldOutlineOverride = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  placementId: number;
  kind: HoldOutlineKind;
  outline: number[];
  note?: string | null;
  authorId?: string | null;
  authorDisplayName?: string | null;
  updatedAt: string;
};

/**
 * A board config, identified the way a geometry shard is. Set ids are absent on
 * purpose — every shard is traced with every set of its layout and size mounted.
 */
export type HoldOutlineConfigInput = {
  boardName: string;
  layoutId: number;
  sizeId: number;
};

/** The deployed shard's traced silhouettes, plus the live overrides that supersede or annotate them. */
export type BoardHoldOutlines = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  shardOutlines: PlacementOutline[];
  overrides: HoldOutlineOverride[];
};

export type UpsertHoldOutlineOverrideInput = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  placementId: number;
  kind?: HoldOutlineKind | null;
  outline: number[];
  note?: string | null;
};

export type DeleteHoldOutlineOverrideInput = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  placementId: number;
  kind?: HoldOutlineKind | null;
};
