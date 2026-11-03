import { buildBoardPath } from '@boardsesh/board-config';
import { drivesWithoutBluetooth } from './board-lighting';

/** The board fields a session path needs. Everything else on `UserBoard` is irrelevant here. */
export type SessionBoardPathSource = {
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  slug?: string | null;
  gymId?: number | null;
  hasLeds?: boolean;
  litByWallDevice?: boolean;
};

/**
 * The board path a party session broadcasts to its members.
 *
 * A gym-linked board or a board without LEDs has to keep its shared identity:
 * `/b/{slug}/{angle}`. Handed the positional tuple instead, a joiner goes down
 * `resolveBoardForSession`'s tuple branch, which mints that climber their own
 * private board row bound to a different board-presence id — so the second
 * climber's turn never reaches the first climber's feed, or the gym's kiosk.
 *
 * Under Bluetooth this never showed: both phones re-converged on the same row
 * through the serial/config resolve the moment they connected to the box. On a
 * wall with no light kit there is no such event, so the path is the only thing
 * holding the two climbers on one feed.
 *
 * `gymId != null` marks a shared gym wall; a wall driven without Bluetooth (no
 * light kit, or lit by a wall device, `drivesWithoutBluetooth`) also keeps a
 * personal wall's identity when friends join it. For a wall device that is the
 * whole point: it follows this board's feed, so a joiner on a minted copy would
 * put climbs up on a feed nothing reads. `isPublic` defaults to true
 * even on the private rows joiners mint for themselves. An empty slug would
 * emit `/b//40`, which `parseNamedBoardPath` reads as the slug `"40"`.
 *
 * Every site that sets a session's board path must go through here, or the first
 * angle change (which rebuilds the path) silently reverts a named session to the
 * tuple and separates everyone who joins after it.
 */
export function buildSessionBoardPath(board: SessionBoardPathSource, angleOverride?: number): string {
  const angle = angleOverride ?? board.angle;
  if ((board.gymId != null || drivesWithoutBluetooth(board)) && board.slug) return `/b/${board.slug}/${angle}`;
  return buildBoardPath(board.boardType, board.layoutId, board.sizeId, board.setIds, angle);
}
