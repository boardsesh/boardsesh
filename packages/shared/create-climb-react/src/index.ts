// Shared, renderer-agnostic create-climb logic for web + React Native.
// Pure React + board-constants/shared-schema: no DOM, no react-native, no
// react-query, no MUI. Hold-state machine + save-decision helpers; platform
// apps own rendering, persistence, GraphQL transport, and navigation.

export { useCreateClimb } from './use-create-climb';
export {
  EDIT_WINDOW_MS,
  computeCanUpdate,
  computeEditLocked,
  buildInitialHoldsMap,
  type SavedClimbSnapshot,
} from './helpers';
