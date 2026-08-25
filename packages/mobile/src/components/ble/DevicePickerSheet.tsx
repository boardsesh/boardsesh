import { useCallback, useEffect, useMemo, useRef } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { BottomSheetModal, BottomSheetView, BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { parseSerialNumber } from '@boardsesh/ble-protocol';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import type { DiscoveredDevice } from '../../lib/ble/types';
import { SHEET_SETTLE_MS, useManagedSheet } from '../../providers/sheet-presentation-provider';
import { androidSafeSnapPoints } from '../sheet-snap-points';
import type { ResolvedBoardEntry } from '../../lib/ble/resolve-serials';
import type { BleBoardConfig } from '../../lib/ble/board-config-match';
import { noListedBoardMatchesSelectedType } from '../../lib/ble/picker-resolution-stats';
import { useAndroidScanLocationHint } from '../../lib/ble/use-android-scan-location-hint';
import { hapticSelection } from '../../lib/haptics';
import { Text } from '../Text';
import { Button } from '../Button';
import { DeviceCard } from './DeviceCard';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';

type DevicePickerSheetProps = {
  devices: DiscoveredDevice[];
  onSelect: (deviceId: string) => void;
  onDismiss: () => void;
  /**
   * Take the wall with no Bluetooth, for the "this wall has no lights" offer
   * after a scan that finds nothing. Omitted where no such action exists; the
   * offer is then not rendered. Passed in rather than read off BluetoothContext
   * because BluetoothProvider renders this sheet.
   */
  onNoLeds?: () => void;
  isScanning: boolean;
  resolvedBoards: ReadonlyMap<string, ResolvedBoardEntry>;
  currentBoardConfig?: BleBoardConfig;
};

export function DevicePickerSheet({
  devices,
  onSelect,
  onDismiss,
  isScanning,
  resolvedBoards,
  currentBoardConfig,
  onNoLeds,
}: DevicePickerSheetProps) {
  const { t } = useTranslation('settings');
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheetModal>(null);
  // The take fires after the dismissal has settled (below), by which point this
  // component is gone — so the timer has to be cancellable from a cleanup.
  const takeWallTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (takeWallTimeoutRef.current !== null) clearTimeout(takeWallTimeoutRef.current);
    },
    [],
  );

  const snapPoints = useMemo(() => androidSafeSnapPoints(['72%']), []);

  // The host mounts this sheet only while a picker session is active, so it is
  // always meant to be open. Present/dismiss route through the coordinator
  // (serialized, no overlapping native transitions); `onDismiss` clears the
  // host's picker state on a user pan-down / backdrop.
  const managed = useManagedSheet({ open: true, sheetRef, onClose: onDismiss });

  const sortedDevices = useMemo(() => [...devices].sort((deviceA, deviceB) => deviceB.rssi - deviceA.rssi), [devices]);

  // Pre-compute once per devices update; name is stable for a given device
  // throughout a scan session so parsing per renderItem invocation is wasteful.
  const deviceSerials = useMemo(
    () => new Map(devices.map((device) => [device.deviceId, parseSerialNumber(device.name)])),
    [devices],
  );

  // True when every listed board is a different type than the one the user
  // selected, so their board isn't here. Surfaces a hint so they don't tap the
  // wrong board (and hit the config-mismatch alert) or assume the picker is
  // broken. Same rule the resolution stats flag as `noneMatchedSelectedType`,
  // shared so UI and analytics can't drift.
  const noneMatchedSelectedType = useMemo(
    () => noListedBoardMatchesSelectedType(devices, resolvedBoards, currentBoardConfig),
    [currentBoardConfig, devices, resolvedBoards],
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

  // While our manifest declares `BLUETOOTH_SCAN` without `neverForLocation`, an
  // empty list on Android 12+ with location denied is the OS hiding scan
  // results, not a board problem — so replace the hardware troubleshooting with
  // copy that is actually actionable. See lib/ble/android-scan-location-gate.ts.
  const locationHint = useAndroidScanLocationHint(showEmptyState);
  const showLocationHint = locationHint.shouldOfferLocationGrant || locationHint.wasGranted;
  // Same idea, but for Android 11 and below: the permission is fine, the
  // system-wide Location toggle is off. See android-scan-location-gate.ts.
  const showLocationServicesHint = locationHint.shouldOfferLocationServicesEnable || locationHint.servicesWereEnabled;
  const { requestLocationPermission, promptEnableLocationServices } = locationHint;
  const handleGrantLocation = useCallback(() => {
    void requestLocationPermission();
  }, [requestLocationPermission]);
  const handleEnableLocationServices = useCallback(() => {
    void promptEnableLocationServices();
  }, [promptEnableLocationServices]);

  // A scan that finished with ZERO devices is the only place this belongs. Boards
  // that WERE found but are the wrong type (`noneMatchedSelectedType`) mean there
  // is LED hardware in the room, so the offer would be misleading there.
  const showNoLedsOffer = onNoLeds !== undefined && showEmptyState && !showLocationHint && !showLocationServicesHint;

  const handleNoLeds = useCallback(() => {
    hapticSelection();
    // Stops the scan and clears the host's picker state, which unmounts this
    // sheet — so there is no post-dismiss callback left to hang the take off.
    onDismiss();
    // Session-local only. This deliberately does NOT write `hasLeds: false`: an
    // empty scan is weak evidence (box powered off, out of range, or the Android
    // RN 0.86 scan regression) and a wrong server flip would strip the Bluetooth
    // affordance from every climber on this board. The server flag is set only
    // from the board edit form.
    //
    // Deferred past the sheet's dismissal because the picker is a NATIVE modal
    // and the "You've got the wall" toast is a root-level JS view, so it would
    // render behind it. Same ceiling the sheet coordinator itself waits.
    takeWallTimeoutRef.current = setTimeout(() => {
      takeWallTimeoutRef.current = null;
      onNoLeds?.();
    }, SHEET_SETTLE_MS);
  }, [onDismiss, onNoLeds]);

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

      {devices.length > 0 && noneMatchedSelectedType && currentBoardConfig && (
        <View style={styles.typeHint}>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('ble.differentBoardType', { board: formatBoardDisplayName(currentBoardConfig.boardName) })}
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
        {/* The OS is withholding results — say so instead of blaming the board. */}
        {showLocationHint && (
          <View style={styles.troubleshoot}>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {t('ble.locationHintTitle')}
            </Text>
            <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.troubleshootTip}>
              {locationHint.wasGranted ? t('ble.locationHintGranted') : t('ble.locationHintBody')}
            </Text>
            {locationHint.shouldOfferLocationGrant && (
              <Button
                title={t('ble.locationHintGrant')}
                onPress={handleGrantLocation}
                variant="text"
                size="medium"
                loading={locationHint.isRequesting}
              />
            )}
          </View>
        )}

        {/* Android 11 and below: the permission is granted, but the system
            Location toggle is off, so AOSP withholds every scan result. */}
        {!showLocationHint && showLocationServicesHint && (
          <View style={styles.troubleshoot}>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {t('ble.locationServicesHintTitle')}
            </Text>
            <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.troubleshootTip}>
              {locationHint.servicesWereEnabled
                ? t('ble.locationServicesHintEnabled')
                : t('ble.locationServicesHintBody')}
            </Text>
            {locationHint.shouldOfferLocationServicesEnable && (
              <Button
                title={t('ble.locationServicesHintEnable')}
                onPress={handleEnableLocationServices}
                variant="text"
                size="medium"
                loading={locationHint.isPromptingServices}
              />
            )}
          </View>
        )}

        {/* Only when the board they want may be missing — not when it's clearly
            listed, and not while the initial scan is still running (showEmptyState
            gates the zero-device path on the scan having finished empty). */}
        {!showLocationHint && !showLocationServicesHint && (showEmptyState || noneMatchedSelectedType) && (
          <View style={styles.troubleshoot}>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {t('ble.troubleshootTitle')}
            </Text>
            <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.troubleshootTip}>
              {t('ble.troubleshootTips')}
            </Text>
            {/* The wall may simply have no light kit. Offer to drive it anyway:
                everyone on the board feed (and the gym screen) still sees the
                climb. Session-local — nothing is written to the board record. */}
            {showNoLedsOffer && (
              <View style={styles.noLedsOffer}>
                <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.troubleshootTip}>
                  {t('ble.noLedsBody')}
                </Text>
                <Button
                  title={t('ble.noLedsCta')}
                  onPress={handleNoLeds}
                  variant="text"
                  size="medium"
                  icon="pin"
                  // The handler fires hapticSelection itself so the tap keeps one
                  // haptic; takeVirtualWall's own hapticLight lands after the
                  // dismissal, alongside the "You've got the wall" toast.
                  haptic={false}
                />
              </View>
            )}
          </View>
        )}
        <Button title={t('ble.cancel')} onPress={onDismiss} variant="text" size="medium" role="cancel" />
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
  typeHint: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
    alignItems: 'center',
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: iosSystemColors.separator,
  },
  troubleshoot: {
    alignItems: 'center',
    gap: spacing[1],
    paddingBottom: spacing[2],
  },
  troubleshootTip: {
    textAlign: 'center',
  },
  noLedsOffer: {
    alignItems: 'center',
    gap: spacing[1],
    // The troubleshoot block's own gap is spacing[1]; this pushes the no-lights
    // offer clear of the hardware tips so it reads as a separate suggestion.
    marginTop: spacing[3],
  },
});
