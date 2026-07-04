import { useCallback, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
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
  onClose: () => void;
};

// Secondary BLE controls (Re-light / Turn off all lights / Disconnect) revealed
// by long-pressing the lightbulb — keeps the destructive Disconnect behind a
// labelled menu.
function BleControlSheet({ visible, onReassert, onClearLights, onDisconnect, onClose }: BleControlSheetProps) {
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

  const snapPoints = useMemo(() => ['32%'], []);

  return (
    <ModalSheet visible={visible} snapPoints={snapPoints} onClose={onClose} enablePanDownToClose>
      <View style={styles.content}>
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
