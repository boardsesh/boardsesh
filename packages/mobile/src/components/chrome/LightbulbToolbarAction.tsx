import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { useLightbulbControl } from '../ble/use-lightbulb-control';
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
  const { bluetooth, lit, localConnected, onPress } = useLightbulbControl({ source: 'lightbulb_toolbar' });

  const handlePress = useCallback(() => {
    hapticLight();
    onPress();
  }, [onPress]);

  if (!bluetooth) return null;

  return (
    <GlassToolbarAction
      onPress={handlePress}
      // The label reflects what tapping does (keyed on this device's link), not
      // the fill — the bulb can read lit because a peer holds the wall.
      accessibilityLabel={localConnected ? tCommon('lightControl.disconnect') : tSettings('ble.connectBoard')}
    >
      <Icon
        name={lit ? 'lightbulb.fill' : 'lightbulb'}
        size={23}
        color={lit ? brandColors.warning : systemColors.label}
      />
    </GlassToolbarAction>
  );
}
