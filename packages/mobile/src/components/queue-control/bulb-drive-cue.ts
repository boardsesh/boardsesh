import type { BoardConnectionState } from '../ble/use-board-connection-state';
import type { DriveLightingMode } from '../play-drawer/drive-mode-store';
import type { WallControlModel } from '../play-drawer/wall-control';
import { showsWallHoldLook } from './board-control-indicator-state';

/**
 * How a MiniPlayer bulb shows this phone's drive, the Live Activity's pattern
 * (owner decision 2026-11-02), so the climber on the Climbs tab can see how
 * much longer the wall keeps lighting their picks:
 *
 * - `drain` — Put on board's timed drive: the amber bulb with no halo, ringed
 *   by an amber arc that drains to nothing at the drive's end and fills again
 *   each time a climb lights (`WallWindowRing`). The ring is the clock: no
 *   digits, as on the Lock Screen.
 * - `disc` — an open-ended drive on a bulb that shows the lit climb: the
 *   amber disc (the wall button's live fill, #7113). It has no end to drain.
 * - `whole` — an open-ended drive on a bulb whose climb is not the lit one
 *   (the last pick's Put on board bulb): a full amber ring that never drains.
 *   A disc there would say the pick is lit.
 * - `null` — this phone isn't driving the wall.
 */
export type BulbDriveCue = 'drain' | 'disc' | 'whole' | null;

type BulbDriveCueInput = {
  /** The drive store's word for what the wall does with a pick (`useDriveLightingMode`). */
  mode: DriveLightingMode;
  /**
   * This phone drives the wall over its own link, on a board with lights.
   * A crewmate's board, a dropped link or a wall with no lights draws no cue.
   */
  drivesTheWall: boolean;
  /** The bulb stands for the lit climb (the bar's usual bulb), not an unlit pick. */
  showsLitClimb: boolean;
};

/**
 * Whether this phone drives the wall over its own Bluetooth link, on a board
 * with lights: the only case a bar bulb draws a drive cue. The bar's usual
 * bulb reaches the same answer through `resolveWallBulbLook`.
 */
export function phoneDrivesTheWall({
  inAppBoardConnection,
  localConnected,
  ledless,
}: Pick<BoardConnectionState, 'inAppBoardConnection' | 'localConnected' | 'ledless'>): boolean {
  // A live link writes real LEDs, on a wall-device board too, so only the
  // wall-hold look (no link) rules a drive cue out.
  return inAppBoardConnection === 'connectedByMe' && localConnected && !showsWallHoldLook({ ledless, localConnected });
}

export function resolveBulbDriveCue({ mode, drivesTheWall, showsLitClimb }: BulbDriveCueInput): BulbDriveCue {
  if (!drivesTheWall) return null;
  if (mode === 'window') return 'drain';
  if (mode === 'driving') return showsLitClimb ? 'disc' : 'whole';
  // Arming: the climb isn't up yet, so nothing is driving.
  return null;
}

/**
 * The same for the open Duo's bulb standing in for the pane player's board
 * control (#7000): it draws that control's model, whose timed drive is
 * `lightWindow` and whose live drive is `look: 'driving'`.
 */
export function resolvePaneBulbDriveCue(model: Pick<WallControlModel, 'look' | 'lightWindow'>): BulbDriveCue {
  if (model.lightWindow) return 'drain';
  return model.look === 'driving' ? 'disc' : null;
}

/**
 * The halo under a bulb showing this cue. A draining ring is the bulb's edge,
 * as on the Live Activity, with nothing under it, so the arc meets the bar
 * itself: over the lit bulb's 14% amber halo the light scheme's amber falls
 * to 2.7:1 on the held Material bar, under the 3:1 a graphic needs.
 */
export function bulbHaloFor(cue: BulbDriveCue, haloColor: string | undefined): string | undefined {
  return cue === 'drain' ? undefined : haloColor;
}
