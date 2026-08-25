import type { OpaqueColorValue } from 'react-native';
import type { IconName } from '../icon-map';
import type { BoardConnection } from '../play-drawer/lightbulb-control';

export type BoardControlIndicatorVisual = {
  iconName: IconName;
  iconColor: string | OpaqueColorValue;
  /**
   * Circular halo behind the glyph. Only the "you have control" state glows —
   * the peer and disconnected states are intentionally flat so the bar never
   * tells a climber their Prev/Next drive the wall when a teammate holds it.
   */
  haloColor?: string;
};

type BoardControlIndicatorVisualInput = {
  boardConnection: BoardConnection;
  /** Warm "wall is lit / you're driving" tone (brandColors.warning). */
  connectedColor: string;
  /** Neutral tone for a teammate-driven wall (systemColors.secondaryLabel). */
  peerColor: string | OpaqueColorValue;
  /** Neutral tone for "tap to connect" (systemColors.secondaryLabel). */
  disconnectedColor: string | OpaqueColorValue;
  /**
   * The board has no LED light kit. A filled lightbulb with a warm halo on a
   * wall that has no bulbs is a false statement, so the held/open states switch
   * to a pin — shape-distinct from both the bulb and the person glyph.
   */
  ledless?: boolean;
  /**
   * Tone for "you have the wall" on a board with no lights (brandColors.primary).
   * Deliberately NOT the warm `connectedColor`: amber means the LEDs are on, and
   * it must stay exclusive to a real write.
   */
  wallHeldColor?: string;
};

/**
 * Maps the board-connection tri-state to the accessory bar's leading control
 * visual. Mirrors the in-drawer lightbulb vocabulary (`getBleLightbulbVisualState`)
 * so the bar and the bulb can never disagree, and carries each state by SHAPE
 * (filled bulb / person / outline bulb) as well as colour, so it reads without
 * relying on hue (colour-blind / Differentiate Without Color).
 */
export function getBoardControlIndicatorVisual({
  boardConnection,
  connectedColor,
  peerColor,
  disconnectedColor,
  ledless = false,
  wallHeldColor,
}: BoardControlIndicatorVisualInput): BoardControlIndicatorVisual {
  if (ledless) {
    switch (boardConnection) {
      case 'connectedByMe': {
        // "You have the wall" — a pin, in the brand tone, never the lit-LED amber.
        const heldColor = wallHeldColor ?? connectedColor;
        return { iconName: 'pin.fill', iconColor: heldColor, haloColor: `${heldColor}24` };
      }
      case 'heldByPeer':
        return { iconName: 'person.fill', iconColor: peerColor };
      case 'disconnected':
        // The wall is open — tap to take it.
        return { iconName: 'pin', iconColor: disconnectedColor };
    }
  }
  switch (boardConnection) {
    case 'connectedByMe':
      // Warm filled bulb + halo, matching the lightbulb's connected look.
      return { iconName: 'lightbulb.fill', iconColor: connectedColor, haloColor: `${connectedColor}24` };
    case 'heldByPeer':
      // A teammate drives the wall — neutral person glyph, no glow.
      return { iconName: 'person.fill', iconColor: peerColor };
    case 'disconnected':
      // Tap to take control — neutral outline bulb, no glow.
      return { iconName: 'lightbulb', iconColor: disconnectedColor };
  }
}
