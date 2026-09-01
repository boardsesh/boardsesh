import { useCallback } from 'react';
import { View, StyleSheet, Switch } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../ModalSheet';
import { ListRow } from '../ListRow';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
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
        <ListRow
          title={tSettings('ble.autoDisconnect.toggleTitle')}
          subtitle={tSettings('ble.autoDisconnect.toggleSubtitle', { timeout: autoDisconnectTimeoutLabel })}
          leading={<Icon name="clock" size={22} color={systemColors.secondaryLabel} />}
          trailing={
            <Switch
              value={autoDisconnectEnabled}
              pointerEvents="none"
              accessibilityLabel={tSettings('ble.autoDisconnect.toggleAccessibility')}
            />
          }
          onPress={() => onToggleAutoDisconnect(!autoDisconnectEnabled)}
          accessibilityLabel={tSettings('ble.autoDisconnect.toggleAccessibility')}
          showSeparator
        />
        {showLightAdjacentHolds && (
          <ListRow
            title={tCommon('lightControl.lightAdjacentHolds')}
            subtitle={tCommon('lightControl.lightAdjacentHoldsHelp')}
            leading={<Icon name="lightbulb" size={22} color={systemColors.secondaryLabel} />}
            trailing={
              <Switch
                value={lightAdjacentHoldsEnabled}
                pointerEvents="none"
                accessibilityLabel={tCommon('lightControl.lightAdjacentHolds')}
              />
            }
            onPress={() => onToggleLightAdjacentHolds(!lightAdjacentHoldsEnabled)}
            accessibilityLabel={tCommon('lightControl.lightAdjacentHolds')}
            showSeparator
          />
        )}
        <ListRow
          title={tSettings('ble.lighting.onSwipeLabel')}
          subtitle={tSettings('ble.lighting.onSwipeDescription')}
          leading={<Icon name="lightbulb.fill" size={22} color={systemColors.secondaryLabel} />}
          trailing={
            <Switch
              value={lightOnSwipe}
              pointerEvents="none"
              accessibilityLabel={tSettings('ble.lighting.onSwipeLabel')}
            />
          }
          onPress={() => onToggleLightOnSwipe(!lightOnSwipe)}
          accessibilityLabel={tSettings('ble.lighting.onSwipeLabel')}
          showSeparator
        />
        <ListRow
          title={tSettings('ble.lighting.onTapLabel')}
          subtitle={tSettings('ble.lighting.onTapDescription')}
          leading={<Icon name="lightbulb.fill" size={22} color={systemColors.secondaryLabel} />}
          trailing={
            <Switch
              value={lightOnClimbTap}
              pointerEvents="none"
              accessibilityLabel={tSettings('ble.lighting.onTapLabel')}
            />
          }
          onPress={() => onToggleLightOnClimbTap(!lightOnClimbTap)}
          accessibilityLabel={tSettings('ble.lighting.onTapLabel')}
          showSeparator
        />
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
          leading={<Icon name="bluetooth.off" size={22} color={iosSystemColors.systemRed} />}
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
