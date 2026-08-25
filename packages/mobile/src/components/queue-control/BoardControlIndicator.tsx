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
// On a board with no LED light kit the same control takes and releases the wall
// instead (pin glyph, brand tone — never the lit-LED amber), and long-press is
// suppressed: every action in the controls sheet writes the radio.
//
// Long-press is a power-user shortcut into the BleControlSheet (Re-light / Turn
// off / Disconnect), gated on a real BLE link. State is read from the single
// `useBoardConnectionState` source, so the bar can never disagree with the drawer
// bulb; the Live Activity keeps reading the narrower BLE-only value.

import { useCallback } from 'react';
import { Pressable, StyleSheet, type AccessibilityActionEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { useBleControlSheet } from '../../providers/ble-control-sheet-provider';
import { useBoardConnectionState } from '../ble/use-board-connection-state';
import { useLightbulbControl } from '../ble/use-lightbulb-control';
import { hapticMedium } from '../../lib/haptics';
import { glassSize } from '../../theme/layout';
import { getBoardControlIndicatorVisual } from './board-control-indicator-state';
import { useAccessoryClimbTap } from './use-accessory-climb-tap';

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
};

export function BoardControlIndicator({
  size = glassSize.inline,
  iconSize = 22,
  enableLongPress = false,
}: BoardControlIndicatorProps) {
  const { t } = useTranslation('settings');
  const { systemColors, brandColors } = useTheme();
  const { inAppBoardConnection, localConnected, ledless, holderDisplayName, bluetooth } = useBoardConnectionState();
  const { open: openBoardControls } = useBleControlSheet();
  // Shared connect/disconnect path so undo-arming and the press semantics match
  // the drawer + toolbar lightbulbs: connectedByMe → disconnect, disconnected →
  // connect. (Connect outcome telemetry is emitted inside bluetooth.connect().)
  const { onPress: lightbulbPress } = useLightbulbControl();
  const { openPlay } = useAccessoryClimbTap();

  const handlePress = useCallback(() => {
    // A teammate drives the wall → open the read-only "Now on the wall" view.
    if (inAppBoardConnection === 'heldByPeer') {
      openPlay();
      return;
    }
    // connectedByMe → disconnect (or release, on a wall with no lights);
    // disconnected → connect (or take). The destructive Disconnect's
    // confirmation moved to the long-press controls sheet.
    lightbulbPress();
  }, [inAppBoardConnection, openPlay, lightbulbPress]);

  const handleLongPress = useCallback(() => {
    // Gated on the BLE-only `localConnected`, NOT the widened in-app value: the
    // sheet's Re-light / Turn off / Disconnect actions all write the radio, and
    // there is no controller behind a virtual hold to write to.
    if (!localConnected) return;
    hapticMedium();
    openBoardControls();
  }, [localConnected, openBoardControls]);

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'longpress') handleLongPress();
    },
    [handleLongPress],
  );

  // No board bound yet → nothing to indicate or connect to.
  if (!bluetooth) return null;

  const visual = getBoardControlIndicatorVisual({
    boardConnection: inAppBoardConnection,
    connectedColor: brandColors.warning,
    peerColor: systemColors.secondaryLabel,
    disconnectedColor: systemColors.secondaryLabel,
    ledless,
    wallHeldColor: brandColors.primary,
  });

  const heldByMe = inAppBoardConnection === 'connectedByMe';
  const accessibilityLabel = heldByMe
    ? t(ledless ? 'ble.barControl.wallHeldLabel' : 'ble.barControl.connectedLabel')
    : inAppBoardConnection === 'heldByPeer'
      ? holderDisplayName
        ? t('ble.barControl.peerLabel', { name: holderDisplayName })
        : t('ble.barControl.peerLabelAnonymous')
      : t(ledless ? 'ble.barControl.wallOpenLabel' : 'ble.barControl.disconnectedLabel');

  const accessibilityHint = heldByMe
    ? t(ledless ? 'ble.barControl.wallHeldHint' : 'ble.barControl.connectedHint')
    : inAppBoardConnection === 'heldByPeer'
      ? t('ble.barControl.peerHint')
      : t(ledless ? 'ble.barControl.wallOpenHint' : 'ble.barControl.disconnectedHint');

  // Surface the long-press shortcut to assistive tech without overriding the
  // default activate (so a VoiceOver/TalkBack double-tap still fires the tap).
  // Gated on the BLE-only `localConnected` for the same reason handleLongPress
  // is: announcing a "Board controls" action that opens nothing is worse than
  // not announcing it at all.
  const accessibilityActions =
    enableLongPress && localConnected ? [{ name: 'longpress', label: t('ble.holdForControls') }] : undefined;

  return (
    <Pressable
      onPress={handlePress}
      onLongPress={enableLongPress ? handleLongPress : undefined}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: heldByMe }}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={accessibilityActions ? handleAccessibilityAction : undefined}
      hitSlop={8}
      style={({ pressed }) => [
        styles.container,
        { width: size, height: size, borderRadius: size / 2 },
        visual.haloColor ? { backgroundColor: visual.haloColor, shadowColor: visual.iconColor as string } : null,
        visual.haloColor ? styles.connected : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Icon name={visual.iconName} size={iconSize} color={visual.iconColor} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Soft warm glow, matching the in-drawer lightbulb's connected halo + shadow.
  connected: {
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 2,
  },
  pressed: {
    opacity: 0.6,
    transform: [{ scale: 0.92 }],
  },
});
