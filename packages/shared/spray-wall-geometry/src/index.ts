/**
 * `@boardsesh/spray-wall-geometry` — the maths a spray wall needs to survive
 * being photographed twice: the per-version homography that puts two photos in
 * one coordinate frame, and the matcher that decides which holds are still
 * there after a reset.
 *
 * Pure TypeScript, no dependencies. The backend runs the matcher for real
 * (`proposeSprayWallReset`, SW-12) and the app runs the same code for a preview,
 * which is the whole point of it living here.
 *
 * The frame, the gates and why a moved hold is removed + added are written up in
 * `docs/spray-walls.md`, "Canonical coordinates and matching".
 */
export {
  IDENTITY_HOMOGRAPHY,
  type Homography,
  type Quad,
  type ReferenceSize,
  boundingSize,
  homographyFromAnchors,
  invert,
  isSolvableAnchorQuad,
  isValidAnchorQuad,
  mapPoint,
  mapRadius,
  mapRing,
  quadDoubleArea,
} from './homography';
export { INFEASIBLE, type Assignment, solveAssignment } from './hungarian';
export {
  DEFAULT_DISTANCE_GATE,
  DEFAULT_IOU_GATE,
  DEFAULT_MATCH_WEIGHTS,
  DEFAULT_MOVE_RADII,
  type AliveHold,
  type KeptHold,
  type MatchGates,
  type MatchOptions,
  type MatchResult,
  type MatchWeights,
  type MoveSuggestion,
  type SuggestMovesOptions,
  type WallCircle,
  circleIou,
  colourDistance,
  matchHolds,
  pairCost,
  suggestMoves,
} from './match';
