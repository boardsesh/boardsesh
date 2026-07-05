// Bottom sheet for pairing a Rogue Fitness workout timer to a board. Scans for
// nearby Rogue/Echo timers (via a throwaway RogueTimerController — pairing only
// *records the timer's name*, it doesn't hold a connection) and returns the
// picked timer's advertised name so the board form can store it.
//
// Kept separate from the board DevicePickerSheet: that one renders board art and
// resolves climbing-board serials, none of which apply to a plain UART timer.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { BottomSheetModal, BottomSheetView, BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { DiscoveredDevice } from '../../lib/ble/types';
import { RogueTimerController } from '../../lib/ble/rogue-timer-ble';
import { useManagedSheet } from '../../providers/sheet-presentation-provider';
import { androidSafeSnapPoints } from '../sheet-snap-points';
import { Text } from '../Text';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { hapticLight } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';

type TimerPairingSheetProps = {
  onSelect: (timerName: string) => void;
  onDismiss: () => void;
};

function classifyRssi(rssi: number): { bars: number; color: string } {
  if (rssi > -60) return { bars: 3, color: iosSystemColors.systemGreen };
  if (rssi > -80) return { bars: 2, color: iosSystemColors.systemYellow };
  return { bars: 1, color: iosSystemColors.systemRed };
}

const TimerRow = memo(function TimerRow({
  device,
  onSelect,
}: {
  device: DiscoveredDevice;
  onSelect: (timerName: string) => void;
}) {
  const { systemColors } = useTheme();
  const { bars, color } = classifyRssi(device.rssi);
  const name = device.name ?? '';

  const handlePress = useCallback(() => {
    hapticLight();
    onSelect(name);
  }, [name, onSelect]);

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={name}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? systemColors.fill : systemColors.secondaryBackground },
      ]}
    >
      <Icon name="clock" size={22} color={systemColors.secondaryLabel} />
      <View style={styles.rowText}>
        <Text variant="body" color={systemColors.label} numberOfLines={1}>
          {name}
        </Text>
      </View>
      <View style={styles.rssi}>
        {[8, 13, 18].map((height, index) => (
          <View
            key={index}
            style={[styles.rssiBar, { height, backgroundColor: index < bars ? color : systemColors.fill }]}
          />
        ))}
      </View>
    </Pressable>
  );
});

export function TimerPairingSheet({ onSelect, onDismiss }: TimerPairingSheetProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);

  const snapPoints = useMemo(() => androidSafeSnapPoints(['60%']), []);
  const managed = useManagedSheet({ open: true, sheetRef, onClose: onDismiss });

  const controllerRef = useRef<RogueTimerController | null>(null);
  if (controllerRef.current === null) controllerRef.current = new RogueTimerController();

  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [isScanning, setIsScanning] = useState(true);

  // Scan for the sheet's lifetime; the host mounts it only while pairing.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    setIsScanning(true);
    const stopScan = controller.scanForTimers(setDevices, () => setIsScanning(false));
    return () => {
      stopScan();
    };
  }, []);

  const sortedDevices = useMemo(() => [...devices].sort((deviceA, deviceB) => deviceB.rssi - deviceA.rssi), [devices]);

  const renderItem = useCallback(
    ({ item }: { item: DiscoveredDevice }) => <TimerRow device={item} onSelect={onSelect} />,
    [onSelect],
  );
  const keyExtractor = useCallback((item: DiscoveredDevice) => item.deviceId, []);

  const showScanning = isScanning && devices.length === 0;
  const showEmpty = !isScanning && devices.length === 0;

  return (
    <BottomSheetModal
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      enablePanDownToClose
      onChange={managed.onChange}
      onFullyDismissed={managed.onFullyDismissed}
      handleIndicatorStyle={styles.indicator}
    >
      <BottomSheetView style={styles.header}>
        <Text variant="title3" color={systemColors.label}>
          {t('mobile.timerPair.title')}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.headerSubtitle}>
          {t('mobile.timerPair.subtitle')}
        </Text>
      </BottomSheetView>

      {showScanning && (
        <View style={styles.centerState}>
          <ActivityIndicator size="small" color={brandColors.primary} />
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {t('mobile.timerPair.scanning')}
          </Text>
        </View>
      )}

      {showEmpty && (
        <View style={styles.centerState}>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.emptyText}>
            {t('mobile.timerPair.empty')}
          </Text>
        </View>
      )}

      {devices.length > 0 && (
        <BottomSheetFlatList
          data={sortedDevices}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing[3] }]}>
        <Button title={t('mobile.timerPair.cancel')} onPress={onDismiss} variant="text" size="medium" role="cancel" />
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
  headerSubtitle: {
    textAlign: 'center',
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
    paddingVertical: spacing[10],
    paddingHorizontal: spacing[6],
  },
  emptyText: {
    textAlign: 'center',
  },
  listContent: {
    paddingHorizontal: spacing[2],
    paddingBottom: spacing[4],
    gap: spacing[1],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderRadius: borderRadius.lg,
    gap: spacing[3],
  },
  rowText: {
    flex: 1,
  },
  rssi: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    height: 18,
  },
  rssiBar: {
    width: 4,
    borderRadius: 1,
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: iosSystemColors.separator,
  },
});
