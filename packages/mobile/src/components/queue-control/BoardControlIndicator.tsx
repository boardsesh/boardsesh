import { PressableSurface } from '../PressableSurface';
// The accessory bar's leading board-control element. It is both the connection
// STATUS (so a climber can tell at a glance whether they're driving the wall —
// the user-testing gap) and the connect CONTROL, mirroring the in-drawer
// lightbulb so the two surfaces share one vocabulary and one connect path.
//
// Tap, per connection state — in line with the drawer + toolbar lightbulbs:
//   disconnected   → connect (relight the remembered board; shared connect path)
//   connectedByMe  → disconnect (shared path). The destructive Disconnect's
//                    confirmation lives in the long-press controls sheet now.
//   heldByPeer     → open the read-only "Now on the wall" view (a teammate drives)
//
// While this phone drives the wall (any drive the bulb shows, below) a tap
// stops driving and keeps the link instead, as the player's frosted button and
// the Lock Screen bulb do (owner, 2026-11-03; `bar-bulb-tap.ts`). It says
// "Stop driving" then.
//
// On a board with no LED light kit the same control takes and releases the wall
// instead (pin glyph, brand tone — never the lit-LED amber), and long-press is
// suppressed: every action in the controls sheet writes the radio.
//
// Long-press is a power-user shortcut into the BleControlSheet (Re-light / Turn
// off / Disconnect), gated on a real BLE link. State is read from the single
// `useBoardConnectionState` source, so the bar can never disagree with the drawer
// bulb; the Live Activity keeps reading the narrower BLE-only value.
//
// While this phone drives the wall the bulb says so, as the Live Activity's
// bulb does (owner decision 2026-11-02, `BulbDriveCue`): Put on board's timed
// drive rings it with an amber arc that drains to the drive's end and fills
// again with each lit climb; an open-ended drive fills it amber. Its value
// says "Driving the wall", with no number, so the bar never re-renders on a tick.

import { useCallback } from 'react';
import { Platform, StyleSheet, type AccessibilityActionEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { useBleControlSheet } from '../../providers/ble-control-sheet-provider';
import { useBoardConnectionState } from '../ble/use-board-connection-state';
import { useLightbulbControl } from '../ble/use-lightbulb-control';
import { readBarBulbTap, useBarBulbStopDriving } from './bar-bulb-tap';
import { hapticMedium } from '../../lib/haptics';
import { glassSize } from '../../theme/layout';
import {
  drivingBulbColors,
  getBoardConnectionLabel,
  getBoardControlIndicatorVisual,
  showsWallHoldLook,
} from './board-control-indicator-state';
import { resolveWallBulbLook } from '../play-drawer/wall-control';
import { useDriveLightingMode } from '../play-drawer/drive-mode-store';
import { WallWindowRing } from '../play-drawer/WallWindowRing';
import { useDifferentiateWithoutColor } from '../../hooks/use-differentiate-without-color';
import { useAccessoryClimbTap } from './use-accessory-climb-tap';
import { bulbHaloFor, phoneDrivesTheWall, resolveBulbDriveCue } from './bulb-drive-cue';
import type { AccessoryPlacement } from '../../lib/analytics-board-connect';

type BoardControlIndicatorProps = {
  /** Container (tap target) size; defaults to the 44pt control floor. */
  size?: number;
  /** Glyph size. */
  iconSize?: number;
  /**
   * Enable the long-press → controls-sheet shortcut. JS bar only — left off on
   * the iOS 26 native accessory platter to avoid colliding with UIKit's own
   * press/highlight gestures.
   */
  enableLongPress?: boolean;
  /**
   * Draw the glyph filled in every state, like the solid controls in Apple Music's
   * platter (the iOS 26 accessory). The outline comes back while Differentiate
   * Without Color is on, so "off" still differs from "on" by shape.
   */
  solidGlyphs?: boolean;
  /** The accessory platter's placement, when this bulb sits on the platter (analytics). */
  placement?: AccessoryPlacement;
};

export function BoardControlIndicator({
  size = glassSize.inline,
  iconSize = 22,
  enableLongPress = false,
  solidGlyphs = false,
  placement,
}: BoardControlIndicatorProps) {
  const { t } = useTranslation('settings');
  const { systemColors, brandColors, colorScheme } = useTheme();
  const { inAppBoardConnection, localConnected, ledless, holderDisplayName, bluetooth } = useBoardConnectionState();
  // Driving the wall (#7113): a tap on any climb lights it, so the bulb takes
  // the wall button's live fill. The board control's own rule
  // (`resolveWallBulbLook`), fed this phone's link and the drive.
  // Put on board's timed drive too (2.7): it is a drive like any other, and
  // every tap lights until it ends.
  const lightingMode = useDriveLightingMode();
  const drivingLive = lightingMode === 'driving' || lightingMode === 'window';
  const { open: openBoardControls } = useBleControlSheet();
  const differentiateWithoutColor = useDifferentiateWithoutColor();
  // Shared connect/disconnect path so undo-arming and the press semantics match
  // the drawer + toolbar lightbulbs: connectedByMe → disconnect, disconnected →
  // connect. (Connect outcome telemetry is emitted inside bluetooth.connect().)
  const { onPress: lightbulbPress } = useLightbulbControl({ surface: 'board_control_indicator', placement });
  const { openPlay } = useAccessoryClimbTap();
  const stopDriving = useBarBulbStopDriving(localConnected, 'mini_bar');
  // This phone drives the wall over its own link, on a board with lights: the
  // only time the bulb draws a drive (`resolveBulbDriveCue` below).
  const drivesTheWall = phoneDrivesTheWall({ inAppBoardConnection, localConnected, ledless });

  const handlePress = useCallback(() => {
    // Any drive the bulb shows → stop driving, keeping the link.
    const tap = readBarBulbTap(drivesTheWall);
    if (tap === 'stop_driving') {
      stopDriving();
      return;
    }
    // A teammate drives the wall → open the read-only "Now on the wall" view.
    if (inAppBoardConnection === 'heldByPeer') {
      openPlay();
      return;
    }
    // A double tap's second tap after a stop, or a stop aimed at a timed
    // drive that ran out under the thumb: never a hang-up or a reconnect.
    if (tap === 'held') return;
    // connectedByMe → disconnect (or release, on a wall with no lights);
    // disconnected → connect (or take). The destructive Disconnect's
    // confirmation moved to the long-press controls sheet.
    lightbulbPress();
  }, [drivesTheWall, stopDriving, inAppBoardConnection, openPlay, lightbulbPress]);

  const handleLongPress = useCallback(() => {
    // Gated on the BLE-only `localConnected`, NOT the widened in-app value: the
    // sheet's Re-light / Turn off / Disconnect actions all write the radio, and
    // there is no controller behind a virtual hold to write to.
    if (!localConnected) return;
    hapticMedium();
    openBoardControls({ surface: 'board_control_indicator', placement });
  }, [localConnected, openBoardControls, placement]);

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'longpress') handleLongPress();
    },
    [handleLongPress],
  );

  // No board bound yet → nothing to indicate or connect to.
  if (!bluetooth) return null;

  const heldByMe = inAppBoardConnection === 'connectedByMe';
  // The pin and the wall words only without a live link: this phone's link to a
  // wall-device board's LEDs reads lit, Connected, as any LED board's.
  const wallHoldLook = showsWallHoldLook({ ledless, localConnected });
  const bulbLook = resolveWallBulbLook(
    heldByMe && !wallHoldLook ? 'lit' : null,
    heldByMe && localConnected,
    true,
    drivingLive,
  );
  // The bar's usual bulb stands for the lit climb, so an open-ended drive is the disc.
  const driveCue = resolveBulbDriveCue({
    mode: lightingMode,
    drivesTheWall: bulbLook === 'driving',
    showsLitClimb: true,
  });

  const visual = getBoardControlIndicatorVisual({
    boardConnection: inAppBoardConnection,
    connectedColor: brandColors.warning,
    peerColor: systemColors.secondaryLabel,
    disconnectedColor: systemColors.secondaryLabel,
    ledless,
    localConnected,
    wallHeldColor: brandColors.primary,
    solidGlyphs: solidGlyphs && differentiateWithoutColor !== 'on',
    // A timed drive is ringed instead: the amber disc would hide the arc.
    driving: driveCue === 'disc' ? drivingBulbColors(brandColors, colorScheme) : null,
  });

  const haloColor = bulbHaloFor(driveCue, visual.haloColor);

  // While driving the label says what a tap does, as the Live Activity's bulb
  // does; "Driving the wall" stays the value.
  const accessibilityLabel = driveCue
    ? t('ble.barControl.stopDrivingLabel')
    : getBoardConnectionLabel(t, {
        boardConnection: inAppBoardConnection,
        ledless,
        localConnected,
        holderDisplayName,
      });

  const accessibilityHint = driveCue
    ? t('ble.barControl.stopDrivingHint')
    : heldByMe
      ? t(wallHoldLook ? 'ble.barControl.wallHeldHint' : 'ble.barControl.connectedHint')
      : inAppBoardConnection === 'heldByPeer'
        ? t('ble.barControl.peerHint')
        : t(wallHoldLook ? 'ble.barControl.wallOpenHint' : 'ble.barControl.disconnectedHint');

  // Surface the long-press shortcut to assistive tech without overriding the
  // default activate (so a VoiceOver/TalkBack double-tap still fires the tap).
  // Gated on the BLE-only `localConnected` for the same reason handleLongPress
  // is: announcing a "Board controls" action that opens nothing is worse than
  // not announcing it at all.
  const accessibilityActions =
    enableLongPress && localConnected ? [{ name: 'longpress', label: t('ble.holdForControls') }] : undefined;

  return (
    <PressableSurface
      onPress={handlePress}
      onLongPress={enableLongPress ? handleLongPress : undefined}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityValue={driveCue ? { text: t('ble.barControl.drivingValue') } : undefined}
      accessibilityState={{ selected: heldByMe }}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={accessibilityActions ? handleAccessibilityAction : undefined}
      hitSlop={8}
      style={({ pressed }) => [
        styles.container,
        { width: size, height: size, borderRadius: size / 2 },
        haloColor ? { backgroundColor: haloColor, shadowColor: visual.iconColor as string } : null,
        haloColor ? styles.connected : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Icon maxFontSizeMultiplier={1} name={visual.iconName} size={iconSize} color={visual.iconColor} />
      {driveCue === 'drain' ? <WallWindowRing size={size} /> : null}
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // iOS-only elevation: Android's native shadow on this fully-rounded view renders as a hexagon, not a circle.
  connected: {
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: Platform.OS === 'ios' ? 2 : 0,
  },
  pressed: {
    opacity: 0.6,
    transform: [{ scale: 0.92 }],
  },
});
