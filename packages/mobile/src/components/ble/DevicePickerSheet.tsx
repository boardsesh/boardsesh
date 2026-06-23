import { useCallback, useEffect, useMemo, useRef, type PropsWithChildren } from 'react';
import { View, ActivityIndicator, Platform, StyleSheet } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetView,
  BottomSheetFlatList,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { SheetBackdrop } from '../SheetBackdrop';
import { FullWindowOverlay } from 'react-native-screens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { parseSerialNumber } from '@boardsesh/ble-protocol';
import type { DiscoveredDevice } from '../../lib/ble/types';
import type { ResolvedBoardEntry } from '../../lib/ble/resolve-serials';
import type { BleBoardConfig } from '../../lib/ble/board-config-match';
import { Text } from '../Text';
import { Button } from '../Button';
import { DeviceCard } from './DeviceCard';
import { GlassSheetBackground } from '../GlassSheetBackground';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';

type DevicePickerSheetProps = {
  devices: DiscoveredDevice[];
  onSelect: (deviceId: string) => void;
  onDismiss: () => void;
  isScanning: boolean;
  resolvedBoards: ReadonlyMap<string, ResolvedBoardEntry>;
  currentBoardConfig?: BleBoardConfig;
};

function DevicePickerModalContainer({ children }: PropsWithChildren) {
  return <FullWindowOverlay>{children}</FullWindowOverlay>;
}

const modalContainerComponent = Platform.OS === 'ios' ? DevicePickerModalContainer : undefined;

export function DevicePickerSheet({
  devices,
  onSelect,
  onDismiss,
  isScanning,
  resolvedBoards,
  currentBoardConfig,
}: DevicePickerSheetProps) {
  const { t } = useTranslation('settings');
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);

  const snapPoints = useMemo(() => ['72%'], []);

  useEffect(() => {
    sheetRef.current?.present();
  }, []);

  const sortedDevices = useMemo(() => [...devices].sort((deviceA, deviceB) => deviceB.rssi - deviceA.rssi), [devices]);

  // Pre-compute once per devices update; name is stable for a given device
  // throughout a scan session so parsing per renderItem invocation is wasteful.
  const deviceSerials = useMemo(
    () => new Map(devices.map((device) => [device.deviceId, parseSerialNumber(device.name)])),
    [devices],
  );

  const renderBackdrop = useCallback(
    (backdropProps: BottomSheetBackdropProps) => (
      <SheetBackdrop {...backdropProps} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} />
    ),
    [],
  );

  const renderDeviceItem = useCallback(
    ({ item: discoveredDevice }: { item: DiscoveredDevice }) => {
      // Look the row's entry up here so each DeviceCard receives only its own
      // resolution result: rows whose entry is unchanged (most of them when a
      // new serial resolves) keep referentially identical props and their
      // React.memo skips the re-render. renderItem itself legitimately changes
      // identity with the map — that's what propagates new resolutions.
      const serialNumber = deviceSerials.get(discoveredDevice.deviceId);
      const resolvedEntry = serialNumber ? resolvedBoards.get(serialNumber) : undefined;
      return (
        <DeviceCard
          device={discoveredDevice}
          onSelect={onSelect}
          resolvedEntry={resolvedEntry}
          currentBoardConfig={currentBoardConfig}
        />
      );
    },
    [currentBoardConfig, deviceSerials, onSelect, resolvedBoards],
  );

  const keyExtractor = useCallback((item: DiscoveredDevice) => item.deviceId, []);

  const { systemColors } = theme;

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
      handleIndicatorStyle={styles.indicator}
      backgroundComponent={GlassSheetBackground}
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
  indicator: {
    backgroundColor: iosSystemColors.separator,
    width: 36,
    height: 5,
    borderRadius: 3,
  },
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
