import { drivingAtPick, getDriveMode, useDriveModePhase } from './drive-mode-store';

/**
 * Whether a change of climb lights the wall right now: only while this phone
 * drives it (#7113), from a swipe on the wall button, Put on board or Light
 * automatically (`alwaysDrive`), in a crew too. Outside a drive every change of
 * climb is a preview, and a press on the frosted button ends the drive, so a
 * stop needs no rule of its own. The MiniPlayer's ⏮ and ⏭ and the unlit pane
 * read it.
 */
export function useDrivingWall(): boolean {
  return useDriveModePhase() === 'live';
}

/**
 * A live drive on this phone's link, read at the tap (#7113): the same rule as
 * `useDrivingWall`, for the list taps (`usePlaylistActivation`, a board-history
 * row, a row with nothing to draw) that read it at the tap so their handlers
 * keep one identity. A keep-lighting window past its end is not one, even
 * before the watcher has ended it (#7038).
 */
export function isDrivingWall(): boolean {
  return drivingAtPick(getDriveMode()?.phase === 'live');
}
