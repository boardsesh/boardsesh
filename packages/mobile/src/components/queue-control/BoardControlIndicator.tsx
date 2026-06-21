// The accessory bar's leading board-control element. It is both the connection
// STATUS (so a climber can tell at a glance whether they're driving the wall —
// the user-testing gap) and the connect CONTROL, mirroring the in-drawer
// lightbulb so the two surfaces share one vocabulary and one connect path.
//
// Tap, per connection state:
//   disconnected   → connect (relight the remembered board; shared connect path)
//   connectedByMe  → open the labelled BleControlSheet (Re-light / Turn off /
//                    Disconnect) — destructive Disconnect stays behind a label,
//                    never a stray tap on this large surface
//   heldByPeer     → open the read-only "Now on the wall" view (a teammate drives)
//
// Long-press (JS bar only — never the iOS 26 UIKit platter, where a custom
// recognizer would fight system gestures) is a power-user shortcut into the same
// BleControlSheet. State is read from the single `useBoardConnectionState` source,
// so the bar can never disagree with the drawer bulb or the Live Activity.

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
  const { boardConnection, holderDisplayName, bluetooth } = useBoardConnectionState();
  const { open: openBoardControls } = useBleControlSheet();
  // Reuse the shared connect path so analytics + undo-arming match the lightbulb.
  // Only invoked from `disconnected` (where it connects); never from the
  // connected state, so it never disconnects on a stray tap.
  const { onPress: connectFromShared } = useLightbulbControl({ source: 'lightbulb_toolbar' });
  const { openPlay } = useAccessoryClimbTap();

  const handlePress = useCallback(() => {
    if (boardConnection === 'connectedByMe') {
      hapticMedium();
      openBoardControls();
      return;
    }
    if (boardConnection === 'heldByPeer') {
      openPlay();
      return;
    }
    connectFromShared();
  }, [boardConnection, openBoardControls, openPlay, connectFromShared]);

  const handleLongPress = useCallback(() => {
    // Only meaningful when this device holds the link — the sheet self-guards too.
    if (boardConnection !== 'connectedByMe') return;
    hapticMedium();
    openBoardControls();
  }, [boardConnection, openBoardControls]);

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'longpress') handleLongPress();
    },
    [handleLongPress],
  );

  // No board bound yet → nothing to indicate or connect to.
  if (!bluetooth) return null;

  const visual = getBoardControlIndicatorVisual({
    boardConnection,
    connectedColor: brandColors.warning,
    peerColor: systemColors.secondaryLabel,
    disconnectedColor: systemColors.secondaryLabel,
  });

  const accessibilityLabel =
    boardConnection === 'connectedByMe'
      ? t('ble.barControl.connectedLabel')
      : boardConnection === 'heldByPeer'
        ? holderDisplayName
          ? t('ble.barControl.peerLabel', { name: holderDisplayName })
          : t('ble.barControl.peerLabelAnonymous')
        : t('ble.barControl.disconnectedLabel');

  const accessibilityHint =
    boardConnection === 'connectedByMe'
      ? t('ble.barControl.connectedHint')
      : boardConnection === 'heldByPeer'
        ? t('ble.barControl.peerHint')
        : t('ble.barControl.disconnectedHint');

  // Surface the long-press shortcut to assistive tech without overriding the
  // default activate (so a VoiceOver/TalkBack double-tap still fires the tap).
  const accessibilityActions =
    enableLongPress && boardConnection === 'connectedByMe'
      ? [{ name: 'longpress', label: t('ble.holdForControls') }]
      : undefined;

  return (
    <Pressable
      onPress={handlePress}
      onLongPress={enableLongPress ? handleLongPress : undefined}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: boardConnection === 'connectedByMe' }}
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
