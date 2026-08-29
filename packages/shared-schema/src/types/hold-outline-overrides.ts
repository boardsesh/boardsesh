/** One placement's silhouette: a flat, implicitly-closed `[x0, y0, x1, y1, ...]` ring in radius units. */
export type PlacementOutline = {
  placementId: number;
  outline: number[];
};

/** A hand-corrected hold silhouette, replacing what the tracer produced for one placement. */
export type HoldOutlineOverride = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  placementId: number;
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

/** The deployed shard's traced silhouettes, plus the live corrections that supersede them. */
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
  outline: number[];
  note?: string | null;
};

export type DeleteHoldOutlineOverrideInput = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  placementId: number;
};
