import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { useLightbulbControl } from '../ble/use-lightbulb-control';
import { getBleLightbulbLabelKind } from '../ble/ble-lightbulb-button-state';
import { useBleControlSheet } from '../../providers/ble-control-sheet-provider';
import { hapticLight } from '../../lib/haptics';
import { Icon } from '../Icon';
import { GlassToolbarAction } from './GlassActionToolbar';

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
  const { t: tCommon } = useTranslation('common');
  const { t: tSettings } = useTranslation('settings');
  const { open: openControls } = useBleControlSheet();
  const { bluetooth, lit, localConnected, onPress, onLongPress, pressAction, holderIsAuthoritative } =
    useLightbulbControl({ onOpenControls: openControls });
  const labelKind = getBleLightbulbLabelKind(pressAction, holderIsAuthoritative);

  const handlePress = useCallback(() => {
    hapticLight();
    onPress();
  }, [onPress]);

  if (!bluetooth) return null;

  return (
    <GlassToolbarAction
      onPress={handlePress}
      // Short press connects/disconnects; long press (connected) opens the
      // controls sheet — same as the drawer + accessory-bar lightbulbs.
      onLongPress={localConnected ? onLongPress : undefined}
      // The label reflects what tapping ACTUALLY does, not the fill — the bulb
      // can read lit because a peer holds the wall. Keyed on the resolved press
      // action rather than this device's link: while a session peer drives the
      // board there is no connect to promise, and this surface has no displayed
      // climb to relay, so the tap settles instead.
      accessibilityLabel={
        labelKind === 'disconnect'
          ? tCommon('lightControl.disconnect')
          : labelKind === 'peerDriving'
            ? tSettings('ble.peerDrivingBoard')
            : tSettings('ble.connectBoard')
      }
    >
      <Icon
        name={lit ? 'lightbulb.fill' : 'lightbulb'}
        size={23}
        color={lit ? brandColors.warning : systemColors.label}
      />
    </GlassToolbarAction>
  );
}
