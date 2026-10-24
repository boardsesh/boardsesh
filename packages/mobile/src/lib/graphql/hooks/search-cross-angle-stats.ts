import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { getBoardCapabilities } from '@boardsesh/board-config';

/**
 * The `crossAngleStats` a climb search actually sends, given the input and the
 * `cross-angle-stats` flag. On an angle-bound board (Woods) the climber decides:
 * the "Other angles" switch sets `input.crossAngleStats` through
 * `toClimbSearchInput`, and the flag is ignored there, so the list always
 * matches the switch the climber can see. Everywhere else the flag can also
 * turn it on. Always a boolean, so the server never has to guess what an
 * absent value meant.
 *
 * `useInfiniteSearchClimbs` applies it to every list it runs, and the screens
 * that page the same list outside that hook (a setter page's play-drawer track)
 * apply it too. They must send what the list sent, or the order
 * the player walks is not the order on screen.
 */
export function resolveSearchCrossAngleStats(
  input: Pick<ClimbSearchInput, 'boardName' | 'crossAngleStats'>,
  crossAngleStatsFlagOn: boolean,
): boolean {
  const crossAngleStatsRequested = input.crossAngleStats === true;
  return getBoardCapabilities(input.boardName).angleBoundClimbs
    ? crossAngleStatsRequested
    : crossAngleStatsRequested || crossAngleStatsFlagOn;
}
