// Shared, renderer-agnostic create-climb logic for web + React Native.
// Pure React + board-config/board-constants/shared-schema: no DOM, no
// react-native, no react-query, no MUI. Hold-state machines (Aurora +
// MoonBoard) + save-decision helpers; platform apps own rendering,
// persistence, GraphQL transport, and navigation.

export { useCreateClimb } from './use-create-climb';
export { useMoonBoardCreateClimb } from './use-moonboard-create-climb';
export {
  EDIT_WINDOW_MS,
  computeCanUpdate,
  computeEditLocked,
  buildInitialHoldsMap,
  type SavedClimbSnapshot,
} from './helpers';
