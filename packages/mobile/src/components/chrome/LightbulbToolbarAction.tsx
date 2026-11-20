import { useCallback, useMemo } from 'react';
import {
  LONG_PRESS_ACTION_NAME,
  namedAccessibilityActions,
  onNamedAccessibilityAction,
} from '../../lib/named-accessibility-action';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { useLightbulbControl } from '../ble/use-lightbulb-control';
import { useBleControlSheet } from '../../providers/ble-control-sheet-provider';
import { hapticLight } from '../../lib/haptics';
import { useBulbDriveTap } from '../queue-control/bar-bulb-tap';
import { phoneDrivesTheWall } from '../queue-control/bulb-drive-cue';
import { Icon } from '../Icon';
import { GlassToolbarAction, toolbarGlyphSize, useToolbarActionSize } from './GlassActionToolbar';

/**
 * The lightbulb toolbar button that connects / disconnects the physical board's
 * LEDs over Bluetooth. Self-contained: reads the optional Bluetooth context and
 * renders nothing when BLE is unavailable (no board selected yet). The
 * connection is app-wide, so connecting here lights the wall once a climb is in
 * view. Used by both the Climbs and Discover chromes.
 *
 * Shares `useLightbulbControl` with the play-drawer bulb, so the fill follows the
 * same lit state (this device, or a session peer driving the wall) and the tap
 * runs the same connect/disconnect path.
 */
export function LightbulbToolbarAction() {
  const { systemColors, brandColors } = useTheme();
  const { t: tSettings } = useTranslation('settings');
  const actionSize = useToolbarActionSize();
  const { available, lit, localConnected, onLongPress, handlePress, accessibilityLabel, accessibilityHint } =
    useToolbarLightbulb();

  // Offered only where the long press itself is wired (connected, handler present).
  const canOpenControls = localConnected && !!onLongPress;
  const longPressActions = useMemo(
    () =>
      canOpenControls ? namedAccessibilityActions(LONG_PRESS_ACTION_NAME, tSettings('ble.boardControls')) : undefined,
    [canOpenControls, tSettings],
  );
  const onLongPressAction = useMemo(
    () =>
      canOpenControls && onLongPress ? onNamedAccessibilityAction(LONG_PRESS_ACTION_NAME, onLongPress) : undefined,
    [canOpenControls, onLongPress],
  );

  if (!available) return null;

  return (
    <GlassToolbarAction
      onPress={handlePress}
      // Short press connects/disconnects; long press (connected) opens the
      // controls sheet — same as the drawer + accessory-bar lightbulbs.
      onLongPress={localConnected ? onLongPress : undefined}
      accessibilityActions={longPressActions}
      onAccessibilityAction={onLongPressAction}
      // The label reflects what tapping ACTUALLY does, not the fill — the bulb
      // can read lit because a peer holds the wall. Keyed on the resolved press
      // action rather than this device's link: while a session peer drives the
      // board there is no connect to promise, and this surface has no displayed
      // climb to relay, so the tap settles instead. While this phone drives the
      // wall it says "Stop driving", and the hint what follows.
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
    >
      <Icon
        maxFontSizeMultiplier={1}
        name={lit ? 'lightbulb.fill' : 'lightbulb'}
        size={toolbarGlyphSize(23, actionSize)}
        color={lit ? brandColors.warning : systemColors.label}
      />
    </GlassToolbarAction>
  );
}

/**
 * The toolbar bulb's state, label and tap, shared by the glass capsule above
 * and the native bar item (`use-root-bar-items.tsx`), so both say and do the
 * same thing. The long press stays with the capsule: a native bar item has none.
 *
 * While this phone drives the wall a tap stops driving and keeps the link, as
 * every bulb does (owner, 2026-11-03; `useBulbDriveTap`), and the bulb says
 * "Stop driving". With no drive it connects or hangs up, as before.
 */
export function useToolbarLightbulb() {
  const { t: tSettings } = useTranslation('settings');
  const { open: openControls } = useBleControlSheet();
  const {
    available,
    lit,
    localConnected,
    ledless,
    inAppBoardConnection,
    onPress,
    onLongPress,
    accessibilityLabel: actionLabel,
    drivingAccessibilityLabel,
  } = useLightbulbControl({ surface: 'toolbar', onOpenControls: openControls });
  const { driving, takeTap } = useBulbDriveTap({
    drivesTheWall: phoneDrivesTheWall({ inAppBoardConnection, localConnected, ledless }),
    linked: localConnected,
    control: 'toolbar',
  });

  const handlePress = useCallback(() => {
    // A stop buzzes on its own; a dropped tap (just after a stop) does nothing.
    if (takeTap()) return;
    hapticLight();
    onPress();
  }, [takeTap, onPress]);

  const accessibilityLabel = driving ? drivingAccessibilityLabel : actionLabel;

  const accessibilityHint = driving ? tSettings('ble.barControl.stopDrivingHint') : undefined;

  return {
    available,
    lit,
    localConnected,
    onLongPress,
    handlePress,
    accessibilityLabel,
    accessibilityHint,
  };
}
