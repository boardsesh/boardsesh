import { PressableSurface } from '../PressableSurface';
// Bottom sheet for pairing a Rogue Fitness workout timer to a board. Scans for
// nearby Rogue/Echo timers (via a throwaway RogueTimerController — pairing only
// *records the timer's name*, it doesn't hold a connection) and returns the
// picked timer's advertised name so the host (Settings › Timers or the board
// form) can store it.
//
// Kept separate from the board DevicePickerSheet: that one renders board art and
// resolves climbing-board serials, none of which apply to a plain UART timer.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, ActivityIndicator, StyleSheet, type ColorValue } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { SCAN_TIMEOUT_MS } from '@boardsesh/ble-protocol/scan-constants';
import type { DiscoveredDevice } from '../../lib/ble/types';
import { RogueTimerController } from '../../lib/ble/rogue-timer-ble';
import { waitForBlePoweredOn } from '../../lib/ble/availability';
import { readBluetoothUnavailableReason } from '../../lib/ble/bluetooth-unavailable';
import { bluetoothBlockedBody } from '../../lib/ble/bluetooth-unavailable-alert';
import { requestBleRuntimePermissionStatus } from '../../lib/ble/use-ble-permissions';
import { canOpenAppSettings, openAppSettings } from '../../lib/open-app-settings';
import { useOptionalRogueTimer } from '../../providers/rogue-timer-context';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { hapticLight } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';

const SNAP_POINTS = MEDIUM_LARGE_SNAP_POINTS;

/**
 * Why the sheet can't look for timers: Bluetooth blocked for the app (only the
 * Settings app can fix it), an Android permission dialog answered no, or the
 * radio off (or missing, as on a simulator).
 */
type TimerScanBlock = 'blocked' | 'permissionDenied' | 'bluetoothOff';

// How long past the scan's own window the sheet waits for it to say it stopped.
const QUIET_STOP_SLACK_MS = 3_000;

/**
 * What stands between the sheet and a scan, asked before starting one.
 * `scanForTimers` checks the same two things but just returns when either is
 * missing, with no callback, so the sheet would spin on "Looking…" forever.
 */
async function readTimerScanBlock(): Promise<TimerScanBlock | null> {
  const permission = await requestBleRuntimePermissionStatus();
  if (permission === 'blocked') return 'blocked';
  if (permission === 'denied') return 'permissionDenied';
  if (permission === 'granted' && (await waitForBlePoweredOn())) return null;
  // iOS reports a refused Bluetooth permission here, as the radio's
  // Unauthorized state, not from the permission request.
  return (await readBluetoothUnavailableReason()) === 'unauthorized' ? 'blocked' : 'bluetoothOff';
}

/**
 * Why a scan ended without its stop callback. It does that on a scan error,
 * most often the radio switched off or Bluetooth taken away mid-scan. Null when
 * the radio reads fine: the sheet just shows what it found.
 */
async function readTimerScanBlockAfterQuietStop(): Promise<TimerScanBlock | null> {
  const reason = await readBluetoothUnavailableReason();
  if (reason === 'unauthorized') return 'blocked';
  if (reason === 'powered_off') return 'bluetoothOff';
  return null;
}

type TimerPairingSheetProps = {
  onSelect: (timerName: string) => void;
  onDismiss: () => void;
};

function classifyRssi(rssi: number, weakColor: ColorValue): { bars: number; color: ColorValue } {
  if (rssi > -60) return { bars: 3, color: iosSystemColors.systemGreen };
  if (rssi > -80) return { bars: 2, color: iosSystemColors.systemYellow };
  return { bars: 1, color: weakColor };
}

const TimerRow = memo(function TimerRow({
  device,
  onSelect,
}: {
  device: DiscoveredDevice;
  onSelect: (timerName: string) => void;
}) {
  const { systemColors } = useTheme();
  const { bars, color } = classifyRssi(device.rssi, systemColors.error);
  const name = device.name ?? '';

  const handlePress = useCallback(() => {
    hapticLight();
    onSelect(name);
  }, [name, onSelect]);

  return (
    <PressableSurface
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
    </PressableSurface>
  );
});

export function TimerPairingSheet({ onSelect, onDismiss }: TimerPairingSheetProps) {
  const { t } = useTranslation('boards');
  const { t: tSettings } = useTranslation('settings');
  const { systemColors, brandColors } = useTheme();

  const controllerRef = useRef<RogueTimerController | null>(null);
  if (controllerRef.current === null) controllerRef.current = new RogueTimerController();

  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [isScanning, setIsScanning] = useState(true);
  const [scanBlock, setScanBlock] = useState<TimerScanBlock | null>(null);

  // The radio has one scan slot, and the Rogue provider's reconnect scan uses it
  // too. Inside the provider the scan waits its turn; outside it (a story, a
  // test) nothing else scans, so it starts at once.
  const schedulePairingScan = useOptionalRogueTimer()?.schedulePairingScan;

  // Scan for the sheet's lifetime; the host mounts it only while pairing. Every
  // way the scan ends (a block found first, its own stop, a quiet stop) ends the
  // spinner and hands the scan slot back, so a held reconnect can run.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    setIsScanning(true);
    setScanBlock(null);
    const startScan = (releaseSlot: () => void) => {
      let stopped = false;
      let stopTimerScan: (() => void) | null = null;
      let quietStopTimeout: ReturnType<typeof setTimeout> | null = null;
      const finish = (block: TimerScanBlock | null) => {
        if (stopped) return;
        stopped = true;
        if (quietStopTimeout) clearTimeout(quietStopTimeout);
        stopTimerScan?.();
        setScanBlock(block);
        setIsScanning(false);
        releaseSlot();
      };
      void readTimerScanBlock()
        .then((block) => {
          if (stopped) return;
          if (block) {
            finish(block);
            return;
          }
          stopTimerScan = controller.scanForTimers(setDevices, () => finish(null));
          quietStopTimeout = setTimeout(() => {
            void readTimerScanBlockAfterQuietStop().then(finish);
          }, SCAN_TIMEOUT_MS + QUIET_STOP_SLACK_MS);
        })
        .catch(() => finish('bluetoothOff'));
      return () => {
        stopped = true;
        if (quietStopTimeout) clearTimeout(quietStopTimeout);
        stopTimerScan?.();
      };
    };
    const stopScan = schedulePairingScan ? schedulePairingScan(startScan) : startScan(() => {});
    return () => {
      stopScan();
    };
  }, [schedulePairingScan]);

  const handleOpenSettings = useCallback(() => {
    void openAppSettings();
  }, []);

  const sortedDevices = useMemo(() => [...devices].sort((deviceA, deviceB) => deviceB.rssi - deviceA.rssi), [devices]);

  const renderItem = useCallback(
    ({ item }: { item: DiscoveredDevice }) => <TimerRow device={item} onSelect={onSelect} />,
    [onSelect],
  );
  const keyExtractor = useCallback((item: DiscoveredDevice) => item.deviceId, []);

  const showScanning = isScanning && devices.length === 0;
  // Timers found before the radio went off can still be picked: pairing only
  // records the name.
  const showBlock = !isScanning && devices.length === 0 ? scanBlock : null;
  const showEmpty = !isScanning && devices.length === 0 && scanBlock === null;

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

      {showBlock === 'blocked' && (
        <View style={styles.centerState}>
          <Icon name="bluetooth" size={40} color={systemColors.tertiaryLabel} />
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centered}>
            {tSettings('ble.blockedTitle')}
          </Text>
          <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.centered}>
            {bluetoothBlockedBody(tSettings)}
          </Text>
          {canOpenAppSettings() && (
            <Button title={tSettings('ble.openSettings')} onPress={handleOpenSettings} variant="tonal" size="medium" />
          )}
        </View>
      )}

      {(showBlock === 'permissionDenied' || showBlock === 'bluetoothOff') && (
        <View style={styles.centerState}>
          <Icon name="bluetooth" size={40} color={systemColors.tertiaryLabel} />
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centered}>
            {showBlock === 'permissionDenied'
              ? t('mobile.timerPair.permissionDenied')
              : t('mobile.bluetooth.unavailable')}
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
