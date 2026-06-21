// @boardsesh/board-presence-react — renderer-agnostic React for board presence.
//
// A `useReducer` wrapper around the pure `@boardsesh/board-presence` reducer
// plus a thin context provider. Pure React only: hooks / context, no react-dom,
// no next, no MUI (web); no react-native host components, no Expo APIs (mobile).
// All platform I/O (GraphQL subscription, fetches, mutations) is injected via
// `BoardPresenceClient`. `react` is a peerDependency.

export { useBoardPresence } from './use-board-presence';
export type {
  BoardPresenceActions,
  BoardPresenceCatchUpInfo,
  BoardPresenceCatchUpReason,
  BoardPresenceCurrentState,
  BoardPresenceFeedState,
  BoardPresenceReportResult,
  UseBoardPresenceResult,
} from './use-board-presence';

export {
  BoardPresenceProvider,
  useBoardPresenceActions,
  useBoardPresenceContext,
  useBoardPresenceCurrent,
  useBoardPresenceFeed,
  useBoardPresenceHasClimb,
  BoardPresenceActionsContext,
  BoardPresenceContext,
  BoardPresenceCurrentContext,
  BoardPresenceFeedContext,
  BoardPresenceHasClimbContext,
} from './board-presence-provider';

export { boardHistoryCursor } from './types';
export type { BoardHistoryCursor, BoardPresenceClient } from './types';
