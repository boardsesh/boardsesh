import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { announceQueued } from '../../lib/announce-queued';
import { trackWallControlTapped, type WallControlSurface } from '../../lib/analytics-wall-control';
import { trackBoardControlsOpened } from '../../lib/analytics-board-connect';
import { hapticMedium, hapticWarning } from '../../lib/haptics';
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
 * After a tap-disconnect, how long further taps are dropped. The provider marks
 * the link down before the adapter's disconnect finishes, so the second tap of
 * a double tap would otherwise read Connect board and start a connect (the
 * picker, or a 15 s scan) mid-disconnect.
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
  const latest = useRef({ model, runners });
  latest.current = { model, runners };
  // A tap-disconnect in flight: when it started, and whether the drop still owes its announcement.
  const disconnectTappedAtRef = useRef<number | null>(null);
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
    // The second tap of a double tap on You have the board: the link already
    // reads down, but the adapter is still letting go. Drop it.
    const tappedAt = disconnectTappedAtRef.current;
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
        disconnectTappedAtRef.current = Date.now();
        announceDropRef.current = true;
        hapticWarning();
        run.disconnect();
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
