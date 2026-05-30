import { useCallback, useMemo } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { parseBoardTypeFromDeviceName } from '@boardsesh/ble-protocol';
import type { DiscoveredDevice } from '../../lib/ble/types';
import { Text } from '../Text';
import { Button } from '../Button';
import { DeviceCard } from './DeviceCard';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';

type DevicePickerSheetProps = {
  visible: boolean;
  devices: DiscoveredDevice[];
  onSelect: (deviceId: string) => void;
  onDismiss: () => void;
  isScanning: boolean;
};

export function DevicePickerSheet({ visible, devices, onSelect, onDismiss, isScanning }: DevicePickerSheetProps) {
  const { t } = useTranslation('settings');
  const theme = useTheme();

  const sortedDevices = useMemo(() => [...devices].sort((deviceA, deviceB) => deviceB.rssi - deviceA.rssi), [devices]);

  const renderDeviceItem = useCallback(
    ({ item }: { item: DiscoveredDevice }) => {
      const boardType = parseBoardTypeFromDeviceName(item.name);
      const boardLabel = boardType ? boardType.charAt(0).toUpperCase() + boardType.slice(1) : undefined;

      return <DeviceCard device={item} onSelect={onSelect} boardType={boardLabel} />;
    },
    [onSelect],
  );

  const keyExtractor = useCallback((item: DiscoveredDevice) => item.deviceId, []);

  const { systemColors } = theme;

  const showScanningState = isScanning && devices.length === 0;
  const showEmptyState = !isScanning && devices.length === 0;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      presentationStyle="overFullScreen"
      onRequestClose={onDismiss}
    >
      <View style={styles.modalRoot}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('settings.ble.cancel')}
          style={styles.backdrop}
          onPress={onDismiss}
        />

        <View style={[styles.sheet, { backgroundColor: systemColors.secondaryBackground as string }]}>
          <View style={styles.indicator} />

          <View style={styles.header}>
            <Text variant="title3" color={systemColors.label}>
              {t('settings.ble.selectBoard')}
            </Text>
            {devices.length > 0 && (
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {t('settings.ble.devicesFound', { count: devices.length })}
              </Text>
            )}
          </View>

          {showScanningState && (
            <View style={styles.scanningContainer}>
              <ActivityIndicator size="small" color={theme.brandColors.primary} />
              <Text variant="subheadline" color={systemColors.secondaryLabel}>
                {t('settings.ble.scanning')}
              </Text>
            </View>
          )}

          {showEmptyState && (
            <View style={styles.scanningContainer}>
              <Text variant="subheadline" color={systemColors.secondaryLabel}>
                {t('settings.ble.noDevicesFound')}
              </Text>
            </View>
          )}

          {devices.length > 0 && (
            <FlatList
              data={sortedDevices}
              keyExtractor={keyExtractor}
              renderItem={renderDeviceItem}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
            />
          )}

          <View style={styles.footer}>
            <Button title={t('settings.ble.cancel')} onPress={onDismiss} variant="text" size="medium" />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  sheet: {
    minHeight: '45%',
    maxHeight: '70%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    overflow: 'hidden',
  },
  indicator: {
    alignSelf: 'center',
    backgroundColor: iosSystemColors.separator,
    width: 36,
    height: 5,
    borderRadius: 3,
    marginTop: spacing[2],
    marginBottom: spacing[3],
  },
  header: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
    alignItems: 'center',
    gap: 4,
  },
  scanningContainer: {
    flex: 1,
    minHeight: 180,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
    paddingVertical: spacing[10],
  },
  listContent: {
    paddingHorizontal: spacing[2],
    paddingBottom: spacing[4],
    gap: spacing[1],
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    alignItems: 'center',
  },
});
