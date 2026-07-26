export { searchClimbs } from './search-climbs';
export { countClimbs } from './count-climbs';
export { getClimbByUuid } from './get-climb';
export { matchClimbByFrames } from './match-climb-by-frames';
export { resolveClimbCatalogPresence, type ClimbCatalogPresence } from './climb-catalog-presence';
// Re-export shared types for backward compatibility
export type {
  ClimbSearchParams,
  ClimbSearchInputLike,
  BoardRouteParams as ParsedBoardRouteParameters,
} from '@boardsesh/db/queries';
export { mapSearchInputToParams } from '@boardsesh/db/queries';
