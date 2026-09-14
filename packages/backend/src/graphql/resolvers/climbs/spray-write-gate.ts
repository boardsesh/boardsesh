import { GraphQLError } from 'graphql';

/**
 * Refuse a climb write against the `spray` partition.
 *
 * `spray` is a real `BoardName` as of SW-03 (#5436), so `BoardNameSchema` and
 * `isValidBoardName` accept it — but SW-03 ships the TYPES only: there are no
 * spray catalogue rows, no walls, and nothing that says who owns one. Without
 * this gate the generic Aurora path in `saveClimb` / `updateClimb` writes the
 * row anyway: `populateDenormalizedColumns` matches zero `board_placements`
 * rows for a spray layout and returns rather than throwing, so any authenticated
 * caller could publish listed `board_climbs` rows into the spray partition at a
 * `layoutId` of their choosing. SW-04's per-wall layout sequence would then hand
 * those same ids to real walls, and a climber's new wall would open carrying
 * someone else's climbs.
 *
 * Removed by SW-05 (#5438), which adds the spray branch to `saveClimb` together
 * with wall ownership, the setter grade and the per-wall duplicate check. Until
 * then the honest answer is "not yet", not a silent write.
 */
export function assertClimbWriteBoardIsNotSpray(boardType: string): void {
  if (boardType !== 'spray') return;
  throw new GraphQLError('Climbs cannot be created or edited on a spray wall yet.', {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}
