// Shared, renderer-agnostic create-climb logic for web + React Native.
// Pure React + board-constants/shared-schema: no DOM, no react-native, no
// react-query, no MUI. Hold-state machine + save-decision helpers; platform
// apps own rendering, persistence, GraphQL transport, and navigation.

export { useCreateClimb } from './use-create-climb';
export {
  EDIT_WINDOW_MS,
  computeCanUpdate,
  computeEditLocked,
  canEditClimb,
  buildInitialFrames,
  type SavedClimbSnapshot,
  type EditableClimb,
  type CanEditClimbInput,
} from './helpers';
export { applyHoldState, MAX_HOLDS_PER_CAPPED_ROLE } from './hold-paint';
export {
  applyHoldPlacements,
  buildLostHoldGhosts,
  findLostHoldIds,
  isGhostCovered,
  lostHoldPlacements,
  rankReplacementCandidates,
  FALLBACK_REPLACEMENT_CANDIDATES,
  MAX_REPLACEMENT_CANDIDATES,
  NEARBY_RADIUS_MULTIPLIER,
  type HoldCircle,
  type HoldPlacement,
  type LostHoldGeometry,
  type LostHoldGhost,
  type ReplacementCandidate,
} from './lost-holds';
