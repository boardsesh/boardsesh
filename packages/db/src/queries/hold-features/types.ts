/**
 * Types for the generated per-hold feature layer (see
 * `packages/db/src/schema/app/hold-features.ts` and
 * `packages/db/scripts/refresh-hold-features.ts`). Pure data — no DB, no I/O — so
 * every function here is unit-testable in isolation.
 */

/** One placement's identity + raw geometry, as loaded from board_placements ⋈ board_holes. */
export interface PlacementGeom {
  /** board_placements.id; MoonBoard resolves its frame cell through layout + hole first. */
  placementId: number;
  /** board_placements.hole_id — the physical hole. */
  holeId: number | null;
  /** board_placements.set_id — hold set membership. */
  setId: number | null;
  /** board_holes.x on the board grid. */
  x: number;
  /** board_holes.y on the board grid. */
  y: number;
  /** True for kickboard holes (KB-named / kickboard set) — the footwork region. */
  isKickboard: boolean;
}

/** Angle-independent geometry features for one placement, all normalized to the board. */
export interface GeometryFeatures {
  /** Horizontal position in [0,1] within the board's hole bounding box. */
  normX: number;
  /** Vertical position in [0,1] within the board's hole bounding box. */
  normY: number;
  /** Min distance to the bounding-box edge, in [0,0.5], normalized by box size. */
  edgeDist: number;
  /** Distance to the nearest other placement, normalized by the box diagonal. */
  neighborDist: number;
  /** Geometry-derived pull direction toward the board centroid, degrees (0=up,90=right,180=down,270=left). */
  pullDirection: number;
}

/** One graded climb reduced to the placements it uses in each role, plus its label. */
export interface ClimbHoldObservation {
  /** The climb's grade on the shared difficulty scale (the regression target). */
  label: number;
  /** Sample weight (e.g. sqrt of ascensionist count) so busy climbs count more. */
  weight: number;
  /** Placement ids used as hand holds (STARTING/HAND/FINISH). */
  handPlacementIds: number[];
  /** Placement ids used as foot holds (FOOT). */
  footPlacementIds: number[];
}

/** De-confounded per-hold difficulty contribution, split by the role the hold plays. */
export interface HoldDifficulty {
  /** Contribution to grade (Δ grade points from the board mean) when used as a hand hold; null below minSamples. */
  hand: number | null;
  /** Contribution to grade when used as a foot hold; null below minSamples. */
  foot: number | null;
  /** Number of graded climbs using this placement as a hand hold. */
  handSampleCount: number;
  /** Number of graded climbs using this placement as a foot hold. */
  footSampleCount: number;
}

export interface RidgeOptions {
  /** Ridge penalty λ; higher shrinks sparse holds harder toward 0. */
  lambda: number;
  /** Coordinate-descent sweeps (Gauss–Seidel on the ridge normal equations). */
  iterations: number;
  /** Below this per-role sample count, the contribution is left null (too thin). */
  minSamples: number;
}

export const DEFAULT_RIDGE_OPTIONS: Readonly<RidgeOptions> = {
  lambda: 5,
  iterations: 30,
  minSamples: 5,
};
