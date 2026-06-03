import { useCallback, useEffect, useMemo, useRef, type PropsWithChildren } from 'react';
import { View, ActivityIndicator, Platform, StyleSheet, type ViewStyle } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
  BottomSheetFlatList,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { parseBoardTypeFromDeviceName } from '@boardsesh/ble-protocol';
import type { DiscoveredDevice } from '../../lib/ble/types';
import { Text } from '../Text';
import { Button } from '../Button';
import { SheetHandle } from '../SheetHandle';
import { DeviceCard } from './DeviceCard';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';

type DevicePickerSheetProps = {
  devices: DiscoveredDevice[];
  onSelect: (deviceId: string) => void;
  onDismiss: () => void;
  isScanning: boolean;
};

function DevicePickerModalContainer({ children }: PropsWithChildren) {
  return <FullWindowOverlay>{children}</FullWindowOverlay>;
}

const modalContainerComponent = Platform.OS === 'ios' ? DevicePickerModalContainer : undefined;

export function DevicePickerSheet({ devices, onSelect, onDismiss, isScanning }: DevicePickerSheetProps) {
  const { t } = useTranslation('settings');
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);

  const snapPoints = useMemo(() => ['72%'], []);

  useEffect(() => {
    sheetRef.current?.present();
  }, []);

  const sortedDevices = useMemo(() => [...devices].sort((deviceA, deviceB) => deviceB.rssi - deviceA.rssi), [devices]);

  const renderBackdrop = useCallback(
    (backdropProps: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...backdropProps} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} />
    ),
    [],
  );

  const renderHandle = useCallback(() => <SheetHandle onClose={() => sheetRef.current?.dismiss()} />, []);

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

  const backgroundStyle: ViewStyle = {
    backgroundColor: systemColors.secondaryBackground as string,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  };

  const showScanningState = isScanning && devices.length === 0;
  const showEmptyState = !isScanning && devices.length === 0;

  return (
    <BottomSheetModal
      ref={sheetRef}
      name="ble-device-picker"
      index={0}
      stackBehavior="push"
      snapPoints={snapPoints}
      containerComponent={modalContainerComponent}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      onDismiss={onDismiss}
      handleComponent={renderHandle}
      backgroundStyle={backgroundStyle}
    >
      <BottomSheetView style={styles.header}>
        <Text variant="title3" color={systemColors.label}>
          {t('ble.selectBoard')}
        </Text>
        {devices.length > 0 && (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('ble.devicesFound', { count: devices.length })}
          </Text>
        )}
      </BottomSheetView>

      {showScanningState && (
        <View style={styles.scanningContainer}>
          <ActivityIndicator size="small" color={theme.brandColors.primary} />
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {t('ble.scanning')}
          </Text>
        </View>
      )}

      {showEmptyState && (
        <View style={styles.scanningContainer}>
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {t('ble.noDevicesFound')}
          </Text>
        </View>
      )}

      {devices.length > 0 && (
        <BottomSheetFlatList
          data={sortedDevices}
          keyExtractor={keyExtractor}
          renderItem={renderDeviceItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing[3] }]}>
        <Button title={t('ble.cancel')} onPress={onDismiss} variant="text" size="medium" />
      </View>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
    alignItems: 'center',
    gap: 4,
  },
  scanningContainer: {
    flex: 1,
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
    paddingTop: spacing[3],
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: iosSystemColors.separator,
  },
});
