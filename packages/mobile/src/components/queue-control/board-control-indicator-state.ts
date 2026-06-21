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
}: BoardControlIndicatorVisualInput): BoardControlIndicatorVisual {
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
