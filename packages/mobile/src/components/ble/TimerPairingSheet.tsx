// Bottom sheet for pairing a Rogue Fitness workout timer to a board. Scans for
// nearby Rogue/Echo timers (via a throwaway RogueTimerController — pairing only
// *records the timer's name*, it doesn't hold a connection) and returns the
// picked timer's advertised name so the board form can store it.
//
// Kept separate from the board DevicePickerSheet: that one renders board art and
// resolves climbing-board serials, none of which apply to a plain UART timer.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { DiscoveredDevice } from '../../lib/ble/types';
import { RogueTimerController } from '../../lib/ble/rogue-timer-ble';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { hapticLight } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';

const SNAP_POINTS = MEDIUM_LARGE_SNAP_POINTS;

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

  // ModalSheet hands the native sheet one flex child and pads the body for the
  // window bottom inset, so the list never sits under the home indicator.
  return (
    <ModalSheet
      visible
      snapPoints={SNAP_POINTS}
      onClose={onDismiss}
      header={<SheetTopBar title={t('mobile.timerPair.title')} leading={{ kind: 'cancel', onPress: onDismiss }} />}
    >
      {/* A full sentence: too long for the bar's one-line subtitle. */}
      <View style={styles.intro}>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.centered}>
          {t('mobile.timerPair.subtitle')}
        </Text>
      </View>

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
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centered}>
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
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  intro: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
  },
  centered: {
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
  listContent: {
    paddingTop: spacing[2],
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
});
