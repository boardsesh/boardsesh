import { useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../ModalSheet';
import { ListRow } from '../ListRow';
import { Separator } from '../Separator';
import { SwitchRow } from '../SwitchRow';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

type BleControlSheetProps = {
  visible: boolean;
  /** Re-push the current climb to the wall (same as a lightbulb tap). */
  onReassert: () => void;
  /** Clear every LED on the wall, keeping the connection alive. */
  onClearLights: () => void;
  /** Drop the BLE connection. */
  onDisconnect: () => void;
  autoDisconnectEnabled: boolean;
  autoDisconnectTimeoutLabel: string;
  onToggleAutoDisconnect: (enabled: boolean) => void;
  /** Show the MoonBoard "light hold above" row — only when the connected
   * board is a MoonBoard. */
  showLightAdjacentHolds: boolean;
  lightAdjacentHoldsEnabled: boolean;
  onToggleLightAdjacentHolds: (enabled: boolean) => void;
  lightOnSwipe: boolean;
  onToggleLightOnSwipe: (enabled: boolean) => void;
  lightOnClimbTap: boolean;
  onToggleLightOnClimbTap: (enabled: boolean) => void;
  onClose: () => void;
};

// Secondary BLE controls (Re-light / Turn off all lights / Disconnect) revealed
// by long-pressing the lightbulb — keeps the destructive Disconnect behind a
// labelled menu.
function BleControlSheet({
  visible,
  onReassert,
  onClearLights,
  onDisconnect,
  autoDisconnectEnabled,
  autoDisconnectTimeoutLabel,
  onToggleAutoDisconnect,
  showLightAdjacentHolds,
  lightAdjacentHoldsEnabled,
  onToggleLightAdjacentHolds,
  lightOnSwipe,
  onToggleLightOnSwipe,
  lightOnClimbTap,
  onToggleLightOnClimbTap,
  onClose,
}: BleControlSheetProps) {
  const { t: tSettings } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  const { brandColors, systemColors } = useTheme();

  const handleReassert = useCallback(() => {
    onReassert();
    onClose();
  }, [onReassert, onClose]);

  const handleClearLights = useCallback(() => {
    onClearLights();
    onClose();
  }, [onClearLights, onClose]);

  const handleDisconnect = useCallback(() => {
    onDisconnect();
    onClose();
  }, [onDisconnect, onClose]);

  return (
    // Size to content rather than a fixed snap point: with the auto-disconnect
    // row added, a fixed '32%' clips the bottom Disconnect action on smaller
    // screens and at larger accessibility text sizes.
    <ModalSheet visible={visible} enableDynamicSizing onClose={onClose} enablePanDownToClose>
      <View style={styles.content}>
        {/* The app's native SwitchRow (SwiftUI Toggle / Compose Switch) instead of
            raw RN Switches, which render system green on iOS: HIG Color asks for
            one tint across every control. */}
        <SwitchRow
          label={tSettings('ble.autoDisconnect.toggleTitle')}
          description={tSettings('ble.autoDisconnect.toggleSubtitle', { timeout: autoDisconnectTimeoutLabel })}
          wrapDescription
          value={autoDisconnectEnabled}
          onValueChange={onToggleAutoDisconnect}
        />
        {showLightAdjacentHolds && (
          <SwitchRow
            label={tCommon('lightControl.lightAdjacentHolds')}
            description={tCommon('lightControl.lightAdjacentHoldsHelp')}
            wrapDescription
            value={lightAdjacentHoldsEnabled}
            onValueChange={onToggleLightAdjacentHolds}
          />
        )}
        <SwitchRow
          label={tSettings('ble.lighting.onSwipeLabel')}
          description={tSettings('ble.lighting.onSwipeDescription')}
          wrapDescription
          value={lightOnSwipe}
          onValueChange={onToggleLightOnSwipe}
        />
        <SwitchRow
          label={tSettings('ble.lighting.onTapLabel')}
          description={tSettings('ble.lighting.onTapDescription')}
          wrapDescription
          value={lightOnClimbTap}
          onValueChange={onToggleLightOnClimbTap}
        />
        <Separator />
        <ListRow
          title={tSettings('ble.relightBoard')}
          leading={<Icon name="lightbulb.fill" size={22} color={brandColors.warning} />}
          onPress={handleReassert}
          showSeparator
        />
        <ListRow
          title={tCommon('lightControl.turnOffAll')}
          leading={<Icon name="lightbulb.slash" size={22} color={systemColors.secondaryLabel} />}
          onPress={handleClearLights}
          showSeparator
        />
        <ListRow
          title={tCommon('lightControl.disconnect')}
          leading={<Icon name="bluetooth.off" size={22} color={systemColors.error} />}
          onPress={handleDisconnect}
          showSeparator={false}
        />
      </View>
    </ModalSheet>
  );
}

export { BleControlSheet };

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing[2],
  },
});
