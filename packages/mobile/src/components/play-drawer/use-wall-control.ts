import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { announceQueued } from '../../lib/announce-queued';
import { trackWallControlTapped, type WallControlSurface } from '../../lib/analytics-wall-control';
import { trackBoardControlsOpened } from '../../lib/analytics-board-connect';
import { hapticLight, hapticMedium, hapticWarning } from '../../lib/haptics';
import { stopDrivingForLink } from './drive-mode-store';
import { useWallControlShown } from './use-wall-control-shown';
import type { WallControlModel } from './wall-control';

/** What the player runs for each tap action. The handler decides which, from the model. */
export type WallControlRunners = {
  /** Connect, put the preview up, or re-light the climb on screen. */
  light: () => void;
  /** The bulb's own path: relay to a crewmate, take or release a wall with no lights. */
  toggle: () => void;
  /** Let go of the board, as the board sheet's Disconnect does. */
  disconnect: () => void;
  /** The player's board sheet (Re-light, Turn off all lights, Disconnect). */
  openSheet: () => void;
  /**
   * On the wall per presence with no link (QA #147): connect, then light the
   * climb on screen explicitly, the climber's own climb re-asserted (through
   * the #4979 hold) or a preview put up. Never left to the auto-send.
   */
  lightAgain: () => void;
  /**
   * The climb on screen is on another board at this gym (#7076): move there (a
   * crew session moves too), connect, and light it. A preview is put up first.
   */
  moveToBoard: () => void;
};

export type UseWallControlOptions = {
  model: WallControlModel;
  runners: WallControlRunners;
  /** For Wall Control Shown: the climb on screen. */
  climbUuid: string | null;
  /** For Wall Control Shown: the player is open. */
  playerOpen: boolean;
  /** For Wall Control Shown: a view of the control that asks is on screen. */
  visible: boolean;
  /** This phone holds the Bluetooth link: a tap-disconnect is announced when it drops. */
  linked: boolean;
};

/**
 * After a tap that changes what the next tap does, how long further taps are
 * dropped. After a disconnect: the provider marks the link down before the
 * adapter's disconnect finishes, so the second tap of a double tap would
 * otherwise read Put on board and start a connect (the picker, or a 15 s scan)
 * mid-disconnect. After a stop: the second tap would land on Disconnect board,
 * and a crew's board has no Undo.
 */
export const DISCONNECT_TAP_GUARD_MS = 600;

export type WallControlHandlers = {
  press: (control: WallControlSurface) => void;
  longPress: (control: WallControlSurface) => void;
};

/**
 * The one handler behind every view of the board control (#7000). A tap runs
 * the model's `tapAction` and logs Wall Control Tapped; a hold opens the board
 * sheet while this phone holds the link and logs Board Controls Opened; Wall
 * Control Shown counts the control that asks. Each fires once, whichever view
 * the climber used.
 *
 * The handlers keep their identity across renders (they read the latest model
 * through a ref), so a memoised bar doesn't re-render for them.
 */
export function useWallControl({
  model,
  runners,
  climbUuid,
  playerOpen,
  visible,
  linked,
}: UseWallControlOptions): WallControlHandlers {
  const { t: tSettings } = useTranslation('settings');
  const { t } = useTranslation('session');
  const stoppedDrivingLabel = t('playView.wallControl.stoppedDriving');
  const latest = useRef({ model, runners, stoppedDrivingLabel });
  latest.current = { model, runners, stoppedDrivingLabel };
  // The last tap-disconnect or stop (when, for the double-tap guard), and whether a drop still owes its announcement.
  const guardedTapAtRef = useRef<number | null>(null);
  const announceDropRef = useRef(false);

  useWallControlShown({ state: model.state, climbUuid, playerOpen, visible });

  // "Board disconnected" when the link actually drops, not at the tap: a
  // disconnect that fails leaves the climber connected and says nothing.
  const wasLinkedRef = useRef(linked);
  useEffect(() => {
    const dropped = wasLinkedRef.current && !linked;
    wasLinkedRef.current = linked;
    if (!dropped || !announceDropRef.current) return;
    announceDropRef.current = false;
    announceQueued(tSettings('ble.barControl.disconnectedLabel'));
  }, [linked, tSettings]);

  const press = useCallback((control: WallControlSurface) => {
    const { model: current, runners: run } = latest.current;
    // A connect in flight: the spinner says so, and a second tap waits.
    if (current.pending) return;
    // The second tap of a double tap on Disconnect board (the link already
    // reads down, but the adapter is still letting go) or on You are driving
    // the wall (it now reads Disconnect board). Drop it.
    const tappedAt = guardedTapAtRef.current;
    if (tappedAt !== null && Date.now() - tappedAt < DISCONNECT_TAP_GUARD_MS) return;
    trackWallControlTapped({ state: current.state, action: current.tapAction, control });
    if (current.state === 'on_wall_unlinked' && current.tapAction !== 'noop') {
      hapticMedium();
      run.lightAgain();
      return;
    }
    switch (current.tapAction) {
      case 'disconnect':
        // Letting go of the board is the one tap that ends something, so it
        // buzzes like a warning; a screen reader hears it once the link drops.
        // It forgets the board on purpose, as the board sheet's Disconnect
        // does: it frees the board for the next climber.
        guardedTapAtRef.current = Date.now();
        announceDropRef.current = true;
        hapticWarning();
        run.disconnect();
        return;
      case 'stop_driving':
        // Stop driving and keep the link: swipes go back to previews. A light
        // buzz, since nothing was let go; the next tap disconnects.
        guardedTapAtRef.current = Date.now();
        hapticLight();
        stopDrivingForLink();
        announceQueued(latest.current.stoppedDrivingLabel);
        return;
      case 'connect':
      case 'put_on_wall':
      case 'relight':
        hapticMedium();
        run.light();
        return;
      case 'relay':
      case 'take_wall':
      case 'release_wall':
        hapticMedium();
        run.toggle();
        return;
      case 'move_to_board':
        hapticMedium();
        run.moveToBoard();
        return;
      case 'noop':
        return;
    }
  }, []);

  const longPress = useCallback((control: WallControlSurface) => {
    const { model: current, runners: run } = latest.current;
    if (current.longPress !== 'sheet') return;
    hapticMedium();
    trackBoardControlsOpened({ surface: 'play_drawer', source: control });
    run.openSheet();
  }, []);

  return { press, longPress };
}
