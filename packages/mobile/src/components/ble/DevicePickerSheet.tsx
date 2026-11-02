import { useCallback, useEffect, useMemo, useRef } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { BottomSheetFlatList, BottomSheetScrollView } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { parseSerialNumber } from '@boardsesh/ble-protocol';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import type { DiscoveredDevice } from '../../lib/ble/types';
import { dismissManagedSheetAndWait, type ManagedSheetHandle } from '../../providers/sheet-presentation-provider';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import type { ResolvedBoardEntry } from '../../lib/ble/resolve-serials';
import type { BleBoardConfig } from '../../lib/ble/board-config-match';
import { groupPickerDevices, type PickerBoardTarget } from '../../lib/ble/picker-device-target';
import { noListedBoardMatchesSelectedType } from '../../lib/ble/picker-resolution-stats';
import type { DevicePickerSeen } from '../../lib/ble/picker-seen';
import { useScanTipsDue } from '../../lib/ble/scan-tips';
import { useAndroidScanLocationHint } from '../../lib/ble/use-android-scan-location-hint';
import { hapticSelection } from '../../lib/haptics';
import { recordDevicePickerNoLights } from '../../lib/onboarding/device-picker-no-lights';
import { Text } from '../Text';
import { Button } from '../Button';
import { DeviceCard } from './DeviceCard';
import { ScanTips } from './ScanTips';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';

const SNAP_POINTS = MEDIUM_LARGE_SNAP_POINTS;

function sortByRssi(devices: ReadonlyArray<DiscoveredDevice>): DiscoveredDevice[] {
  return [...devices].sort((deviceA, deviceB) => deviceB.rssi - deviceA.rssi);
}

// "Kilter Board", "Tension Board", "MoonBoard": the product name a climber
// knows, never the serial (#5658). The suffix is the one the board-account card
// uses (`aurora.card.boardSuffix`), and it is "Board" in every locale.
function savedBoardProductName(boardName: string, boardSuffix: string): string {
  const displayName = formatBoardDisplayName(boardName);
  return displayName.endsWith(boardSuffix) ? displayName : `${displayName} ${boardSuffix}`;
}

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
  /**
   * Scan again after a scan that found nothing. The host cancels this picker and
   * starts the connect over, which scans afresh. Omitted where no host wires it;
   * the button is then not rendered.
   */
  onScanAgain?: () => void;
  /**
   * "Browse for now", beside the tips: the climber stops waiting for the board
   * and keeps picking climbs, which open as previews with no board. The sheet
   * calls this, then `onDismiss` (the same cancel as the top bar's), so the host
   * only records it. Omitted where no host wires it; the button is then not
   * rendered.
   */
  onBrowseForNow?: () => void;
  isScanning: boolean;
  resolvedBoards: ReadonlyMap<string, ResolvedBoardEntry>;
  currentBoardConfig?: BleBoardConfig;
  targetBoard?: PickerBoardTarget;
  showAllBoards?: boolean;
  /**
   * `searching`: a connect to the saved board is still trying to auto-select it
   * (#5658). The sheet shows a spinner, "Searching for your board" and "Search
   * for any board" instead of the list. Defaults to `list`.
   */
  mode?: 'searching' | 'list';
  /** Whether the sheet should be on screen. Defaults to true. */
  open?: boolean;
  /**
   * The picker ended (a board was selected, or the connect failed). The sheet
   * dismisses itself and calls `onClosed` once that has settled, so it is never
   * unmounted mid-present.
   */
  closing?: boolean;
  onClosed?: () => void;
  /** "Search for any board", for saved-device searches and known-board lists. */
  onSearchAnyBoard?: () => void;
  /** Another sheet displaced this one. Defaults to `onDismiss`. */
  onDisplaced?: () => void;
  /**
   * What this session showed the climber, once each while on screen: "your
   * board isn't in the list" and the troubleshooting tips. For the release
   * watch (2.7); no render of the host's rides on it.
   */
  onSeen?: (seen: DevicePickerSeen) => void;
};

export function DevicePickerSheet({
  devices,
  onSelect,
  onDismiss,
  isScanning,
  resolvedBoards,
  currentBoardConfig,
  targetBoard,
  showAllBoards = false,
  onNoLeds,
  onScanAgain,
  onBrowseForNow,
  mode = 'list',
  open = true,
  closing = false,
  onClosed,
  onSearchAnyBoard,
  onDisplaced,
  onSeen,
}: DevicePickerSheetProps) {
  const { t } = useTranslation('settings');
  const theme = useTheme();
  const sheetRef = useRef<ManagedSheetHandle>(null);

  // The host mounts this sheet while a picker session is active. It is open
  // unless the session says otherwise (a background connect, or a searching
  // picker another sheet displaced). ModalSheet routes present/dismiss through
  // the coordinator (serialized, no overlapping native transitions); `onDismiss`
  // clears the host's picker state on a user pan-down / backdrop.
  const visible = open && !closing;

  // Closing a completed picker: wait for the coordinator's dismissal to settle
  // (immediately if the sheet never reached the screen), then let the host drop
  // the session. Unmounting straight away could tear the sheet down while it is
  // still presenting, the UIKit overlap the coordinator exists to prevent.
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  useEffect(() => {
    if (!closing) return;
    let active = true;
    void dismissManagedSheetAndWait(sheetRef.current).then(() => {
      if (active) onClosedRef.current?.();
    });
    return () => {
      active = false;
    };
  }, [closing]);

  // A known board (gym or saved) lists its own controller first, then the
  // controllers nothing identifies (no serial, or a serial nobody recorded),
  // strongest signal first within each. Only controllers that are positively a
  // different board wait behind "Search for any board" (#7125).
  //
  // Sorted once per scan push, never per serial lookup: the scan cache refreshes
  // RSSI in place between pushes, so re-sorting on a lookup could swap rows the
  // climber is about to tap. Grouping keeps the sorted order, so a lookup moves
  // a row only when its group changes, and the full list keeps its identity.
  const filteringTarget = Boolean(targetBoard?.boardUuid) && !showAllBoards;
  const devicesByRssi = useMemo(() => sortByRssi(devices), [devices]);
  const listedDevices = useMemo(() => {
    if (!filteringTarget || !targetBoard) return devicesByRssi;
    const groups = groupPickerDevices(devicesByRssi, resolvedBoards, targetBoard);
    return [...groups.target, ...groups.unknown];
  }, [devicesByRssi, filteringTarget, resolvedBoards, targetBoard]);

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

  const searching = mode === 'searching';
  // "Not found" only when every controller heard is positively another board.
  const targetNotListed = !searching && filteringTarget && listedDevices.length === 0 && devices.length > 0;
  const showScanningState = !searching && isScanning && devices.length === 0;
  const showEmptyState = !searching && !isScanning && devices.length === 0;

  // The tips used to wait for the 30 s scan to end empty. They now come in 5 s
  // into the scan (the sheet mounts per session, at the tap) while the scan goes
  // on, and stay once it ends. Not while `searching`: that has no list, and it
  // hands over to the list at 10 s, where the tips are already due.
  const tipsDue = useScanTipsDue(isScanning);
  const tipsTime = !searching && (tipsDue || !isScanning);
  // Nothing to pick yet: nothing listed. For a known board every listed box may
  // be theirs: the target group, and every unknown box. On a first Boardsesh
  // connect at a board (serials are recorded on connect) or while the serial
  // lookup is still out, the climber's own box is one of the unknown ones.
  const boardNotHeard = listedDevices.length === 0;

  // On a binary whose manifest declares `BLUETOOTH_SCAN` without
  // `neverForLocation` (before Android versionCode 2000761), an empty list on
  // Android 12+ with location denied is the OS hiding scan results, not a board
  // problem — so replace the hardware troubleshooting with copy that is
  // actually actionable. See lib/ble/android-scan-location-gate.ts. Asked from
  // the same 5 s as the tips, and only with nothing heard at all: a scan that
  // heard any board is not being hidden.
  const locationHint = useAndroidScanLocationHint(tipsTime && devices.length === 0);
  const showLocationHint = locationHint.shouldOfferLocationGrant || locationHint.wasGranted;
  // Same idea, but for Android 11 and below: the permission is fine, the
  // system-wide Location toggle is off. See android-scan-location-gate.ts.
  const showLocationServicesHint = locationHint.shouldOfferLocationServicesEnable || locationHint.servicesWereEnabled;
  // The hint on screen says location is sorted and asks for a fresh connect.
  // From 5 s that can land while the scan still runs, so Scan again comes with
  // it then too, not only once the scan ends.
  const locationFixedCopyShown = showLocationHint ? locationHint.wasGranted : locationHint.servicesWereEnabled;
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
    // The surviving provider owns the dismissal delay and cancellation. This
    // sheet unmounts on dismissal, so it cannot own the deferred action.
    onNoLeds?.();
    // The connect-step test (#5654) hears it from the tap itself, so a virtual
    // hold that moves with a board switch never reads as "no lights".
    recordDevicePickerNoLights();
  }, [onDismiss, onNoLeds]);

  const handleBrowseForNow = useCallback(() => {
    // Recorded before the cancel: the host flushes the session when the cancel
    // clears its picker state.
    onBrowseForNow?.();
    onDismiss();
  }, [onBrowseForNow, onDismiss]);

  // The hardware tips only when the board they want may be missing: not when
  // any box that may be theirs is listed, and not in the first
  // 5 s of the scan. Boards of another type listed with no known board in view
  // say so at once, as before. Never while `searching` (`tipsTime`; its device
  // list is held back empty, so no type can mismatch).
  const showHardwareTips =
    !showLocationHint &&
    !showLocationServicesHint &&
    ((tipsTime && boardNotHeard) || (!filteringTarget && noneMatchedSelectedType));
  const showHints = showLocationHint || showLocationServicesHint || showHardwareTips;
  // A MoonBoard moves "another phone" up the tips.
  const tipsBoardName = targetBoard?.boardName ?? currentBoardConfig?.boardName;

  // Report what the climber saw, while the sheet is on screen. Read through a
  // ref so a host's new callback never re-reports.
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;
  const targetNotListedShown = visible && targetNotListed;
  const hintsShown = visible && showHints;
  useEffect(() => {
    if (targetNotListedShown) onSeenRef.current?.('target_not_listed');
  }, [targetNotListedShown]);
  useEffect(() => {
    if (hintsShown) onSeenRef.current?.('tips');
  }, [hintsShown]);

  // Shared by both bodies below. For a known board: "Search for any board",
  // and while every box heard is another board, "not found" above it.
  const targetRow =
    !searching && filteringTarget ? (
      <View style={targetNotListed ? styles.scanningContainer : styles.searchAnyBoardRow}>
        {targetNotListed && (
          <>
            {isScanning && <ActivityIndicator size="small" color={theme.brandColors.primary} />}
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {isScanning ? t('ble.searchingForSavedBoard') : t('ble.selectedBoardNotFound')}
            </Text>
          </>
        )}
        {onSearchAnyBoard && (
          <Button title={t('ble.searchAnyBoard')} onPress={onSearchAnyBoard} variant="tonal" size="medium" />
        )}
      </View>
    ) : null;

  const hints = showHints ? (
    <View style={styles.hints}>
      {/* The OS is withholding results — say so instead of blaming the board. */}
      {showLocationHint && (
        <View style={styles.troubleshoot}>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('ble.locationHintTitle')}
          </Text>
          <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.troubleshootTip}>
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
          <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.troubleshootTip}>
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

      {showHardwareTips && (
        <View style={styles.troubleshoot}>
          <ScanTips boardName={tipsBoardName} />
          {/* The wall may simply have no light kit. Offer to drive it anyway:
              everyone on the board feed (and the gym screen) still sees the
              climb. Session-local — nothing is written to the board record. */}
          {showNoLedsOffer && (
            <View style={styles.noLedsOffer}>
              <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.troubleshootTip}>
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

      {/* The way on without a board: close the picker and keep picking
          climbs, which open as previews. Not "This wall has no lights",
          which takes the wall with no Bluetooth. */}
      {onBrowseForNow && (
        <Button title={t('ble.browseForNow')} onPress={handleBrowseForNow} variant="text" size="medium" />
      )}
    </View>
  ) : undefined;

  // ModalSheet hands the native sheet a single flex child and pads the body for
  // the window bottom inset. Cancel sits in the top bar. The body is always one
  // scroller, so the hints never squeeze the rest out of a medium detent: with
  // boards listed they ride at the foot of the list, and with none the state
  // and the hints scroll together.
  return (
    <ModalSheet
      ref={sheetRef}
      visible={visible}
      snapPoints={SNAP_POINTS}
      onClose={onDismiss}
      onDisplaced={onDisplaced}
      header={
        <SheetTopBar
          title={t('ble.selectBoard')}
          subtitle={listedDevices.length > 0 ? t('ble.devicesFound', { count: listedDevices.length }) : undefined}
          leading={{ kind: 'cancel', onPress: onDismiss }}
        />
      }
    >
      {listedDevices.length > 0 ? (
        <>
          {targetRow}

          {!filteringTarget && noneMatchedSelectedType && currentBoardConfig && (
            <View style={styles.typeHint}>
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {t('ble.differentBoardType', { board: formatBoardDisplayName(currentBoardConfig.boardName) })}
              </Text>
            </View>
          )}

          <BottomSheetFlatList
            style={styles.body}
            data={listedDevices}
            keyExtractor={keyExtractor}
            renderItem={renderDeviceItem}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            ListFooterComponent={hints}
          />
        </>
      ) : (
        <BottomSheetScrollView
          style={styles.body}
          contentContainerStyle={styles.stateContent}
          showsVerticalScrollIndicator={false}
        >
          {searching && (
            <View style={styles.scanningContainer}>
              <ActivityIndicator size="small" color={theme.brandColors.primary} />
              <Text variant="subheadline" color={systemColors.secondaryLabel}>
                {currentBoardConfig
                  ? t('ble.searchingForBoard', {
                      board: savedBoardProductName(currentBoardConfig.boardName, t('aurora.card.boardSuffix')),
                    })
                  : t('ble.searchingForSavedBoard')}
              </Text>
              {onSearchAnyBoard && (
                <Button title={t('ble.searchAnyBoard')} onPress={onSearchAnyBoard} variant="tonal" size="medium" />
              )}
            </View>
          )}

          {showScanningState && (
            <View style={styles.scanningContainer}>
              <ActivityIndicator size="small" color={theme.brandColors.primary} />
              <Text variant="subheadline" color={systemColors.secondaryLabel}>
                {t('ble.scanning')}
              </Text>
              {/* The location hint below says location is sorted and asks for
                  a fresh connect; from 5 s that can come mid-scan. */}
              {onScanAgain && locationFixedCopyShown && (
                <Button title={t('ble.scanAgain')} onPress={onScanAgain} variant="tonal" size="medium" icon="refresh" />
              )}
            </View>
          )}

          {showEmptyState && (
            <View style={styles.scanningContainer}>
              <Text variant="subheadline" color={systemColors.secondaryLabel}>
                {t('ble.noDevicesFound')}
              </Text>
              {/* An empty scan used to end in an OK-only "Couldn't find your board"
                  alert, then finding the bulb again. The adapters now leave the
                  picker up when the scan window closes empty (#5654), so this state
                  is where that climber lands. Shown next to the location hints too:
                  their "granted" copy asks for exactly this. */}
              {onScanAgain && (
                <Button title={t('ble.scanAgain')} onPress={onScanAgain} variant="tonal" size="medium" icon="refresh" />
              )}
            </View>
          )}

          {targetRow}

          {hints}
        </BottomSheetScrollView>
      )}
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  searchAnyBoardRow: {
    alignItems: 'center',
    paddingVertical: spacing[3],
  },
  // Grows into the space the hints leave, centred, but never below its own
  // height: a squeezed `flex: 1` box let "No boards found" and Scan again spill
  // into the tips at a medium detent.
  scanningContainer: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
    paddingVertical: spacing[4],
  },
  body: {
    flex: 1,
  },
  stateContent: {
    flexGrow: 1,
    paddingBottom: spacing[4],
  },
  listContent: {
    paddingTop: spacing[2],
    paddingHorizontal: spacing[2],
    paddingBottom: spacing[4],
    gap: spacing[1],
  },
  typeHint: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    alignItems: 'center',
  },
  hints: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    alignItems: 'center',
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
