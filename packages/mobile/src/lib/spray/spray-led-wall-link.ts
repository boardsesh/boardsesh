import type { PlayDrawerLightbulbPressAction } from '../../components/play-drawer/lightbulb-control';

export type PlayerWallLinkInput = {
  /** The climb on screen is on the spray wall this phone drives, and its LED setup is on here. */
  sprayLedWall: boolean;
  /** What the bulb would do (`useLightbulbControl().pressAction`). */
  pressAction: PlayDrawerLightbulbPressAction;
  /** This phone holds a Bluetooth link. */
  radioConnected: boolean;
  /** This phone holds the wall with no Bluetooth link. */
  wallHeldLocally: boolean;
  /** A session peer holds the board. */
  holderIsAuthoritative: boolean;
  /** The player has a preview it can relay to that peer. */
  canRelay: boolean;
};

export type PlayerWallLink = {
  /** What the player's wall control does on a press. */
  pressAction: PlayDrawerLightbulbPressAction;
  /** This phone holds the link that lights the wall. */
  phoneLinked: boolean;
  /** That link is a LAN hold on a spray wall's LED controller, not a radio. */
  sprayLedHold: boolean;
};

/**
 * The player's read of the link to the wall. A spray wall with LEDs set up on
 * this phone is driven by taking the wall, but it lights up the way a Bluetooth
 * board does, so the wall control treats that hold as the link: Take the wall
 * reads as a connect (Put on board), Release the wall as a disconnect, and a
 * crewmate's hold is relayed to rather than taken. Every other board passes
 * through untouched.
 */
export function resolvePlayerWallLink({
  sprayLedWall,
  pressAction,
  radioConnected,
  wallHeldLocally,
  holderIsAuthoritative,
  canRelay,
}: PlayerWallLinkInput): PlayerWallLink {
  if (!sprayLedWall) return { pressAction, phoneLinked: radioConnected, sprayLedHold: false };
  const sprayLedHold = wallHeldLocally && !radioConnected;
  return {
    pressAction: ledPressAction(pressAction, holderIsAuthoritative, canRelay),
    phoneLinked: radioConnected || sprayLedHold,
    sprayLedHold,
  };
}

function ledPressAction(
  pressAction: PlayDrawerLightbulbPressAction,
  holderIsAuthoritative: boolean,
  canRelay: boolean,
): PlayDrawerLightbulbPressAction {
  if (pressAction === 'releaseWall') return 'disconnect';
  if (pressAction !== 'takeWall') return pressAction;
  if (holderIsAuthoritative) return canRelay ? 'relay' : 'noop';
  return 'connect';
}
