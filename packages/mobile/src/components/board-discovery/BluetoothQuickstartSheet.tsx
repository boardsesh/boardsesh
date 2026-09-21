import { forwardRef, useCallback, useEffect } from 'react';
import { View, Pressable, Platform, StyleSheet } from 'react-native';
import type BottomSheet from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { boardRowSubtitle } from '@boardsesh/board-config';
import { useSprayLabelOptions } from '../../lib/spray/use-spray-label-options';
import { useBoardScan } from '../../lib/ble/use-board-scan';
import { useAndroidScanLocationHint } from '../../lib/ble/use-android-scan-location-hint';
import { bluetoothBlockedBody } from '../../lib/ble/bluetooth-unavailable-alert';
import { canOpenAppSettings, openAppSettings } from '../../lib/open-app-settings';
import { useBoardsBySerialNumbers } from '../../lib/graphql/hooks';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { Sheet } from '../Sheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';

type BluetoothQuickstartSheetProps = {
  /** True while the sheet is open — drives when the scan kicks off. */
  active: boolean;
  onClose: () => void;
  onSelect: (board: UserBoard) => void;
};

/**
 * Bluetooth quickstart: scans for in-range Aurora boards (scan-only, no
 * connection), resolves their serials to boards, and lets the user pick one to
 * make active. Mirrors the web home's Bluetooth card flow.
 */
export const BluetoothQuickstartSheet = forwardRef<BottomSheet, BluetoothQuickstartSheetProps>(
  function BluetoothQuickstartSheet({ active, onClose, onSelect }, ref) {
    const { systemColors } = useTheme();
    const { t } = useTranslation(['boards', 'settings']);
    const { t: tSettings } = useTranslation('settings');
    const labelOptions = useSprayLabelOptions();
    const { status, unavailableReason, serials, advertisedTypes, start, reset } = useBoardScan();
    // Scoped to what each controller announced. Aurora reuses a serial across
    // board apps, so unscoped this sheet would offer a stranger's Kilter board
    // for an in-range Tension controller and let the user make it active.
    const { data: boards = [], isLoading: isResolving } = useBoardsBySerialNumbers(serials, advertisedTypes);

    // `!isResolving` matters: the scan reports 'done' the moment the radio work
    // finishes, while `boards` stays empty until GraphQL has turned the serials
    // into boards. Without it, a scan that found plenty of boards spends the
    // resolution window looking exactly like a scan that found none.
    const scanFinishedEmpty = status === 'done' && boards.length === 0 && !isResolving;
    // Same Android 12+ scan-result suppression the device picker guards against —
    // this sheet runs its own scan through use-board-scan, so it needs its own
    // hint. See lib/ble/android-scan-location-gate.ts.
    const locationHint = useAndroidScanLocationHint(scanFinishedEmpty);
    const { requestLocationPermission, promptEnableLocationServices } = locationHint;
    const handleGrantLocation = useCallback(() => {
      // Rescan straight away on a grant — unlike the picker (whose scan is owned
      // by the connect flow) this sheet controls its own scan lifecycle.
      void requestLocationPermission().then((granted) => {
        // reset() drops the scan back to 'idle', which the mount effect above
        // picks up and restarts — no explicit start() (that would race it).
        if (granted) reset();
      });
    }, [requestLocationPermission, reset]);
    const handleEnableLocationServices = useCallback(() => {
      // Same rescan-on-success flow as handleGrantLocation, for Android 11 and
      // below where it's the services toggle, not the permission.
      void promptEnableLocationServices().then((enabled) => {
        if (enabled) reset();
      });
    }, [promptEnableLocationServices, reset]);

    // reset() drops the scan back to 'idle' and the open effect below starts a
    // fresh one, the same restart the location grant uses.
    const handleScanAgain = useCallback(() => {
      reset();
    }, [reset]);
    const handleOpenSettings = useCallback(() => {
      void openAppSettings();
    }, []);

    // Start scanning when the sheet opens; reset back to idle when it closes so
    // the next open re-scans from scratch.
    useEffect(() => {
      if (active && status === 'idle') {
        void start();
      } else if (!active && status !== 'idle') {
        reset();
      }
    }, [active, status, start, reset]);

    const renderBody = () => {
      if (status === 'unavailable') {
        const scanAgainButton = (
          <Button
            title={tSettings('ble.scanAgain')}
            onPress={handleScanAgain}
            variant="text"
            size="medium"
            icon="refresh"
          />
        );
        // Blocked (a denied iOS prompt, or Android no longer asking) used to read
        // "Turn on Bluetooth to scan", which a climber with Bluetooth on can't act
        // on. Only the Settings app can fix it, so point there.
        if (unavailableReason === 'unauthorized') {
          return (
            <View style={[styles.state, styles.blockedState]}>
              <Icon name="bluetooth" size={40} color={systemColors.tertiaryLabel} />
              <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.stateText}>
                {tSettings('ble.blockedTitle')}
              </Text>
              <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.stateText}>
                {bluetoothBlockedBody(tSettings)}
              </Text>
              {canOpenAppSettings() && (
                <Button
                  title={tSettings('ble.openSettings')}
                  onPress={handleOpenSettings}
                  variant="tonal"
                  size="medium"
                />
              )}
              {/* Android only. On iOS nothing but the Settings switch can change
                  this state, and iOS relaunches the app when that switch moves,
                  so the tap would only spin for 2.5 s and land back here. An
                  Android grant in Settings leaves the app running, so this is how
                  that climber starts the scan again. */}
              {Platform.OS === 'android' && scanAgainButton}
            </View>
          );
        }
        // An Android "Don't allow" isn't a radio problem either, and scanning
        // again brings the system dialog back. No Scan again for a phone with no
        // Bluetooth LE, or in any browser: the web BLE manager always reads the
        // radio as off, even where Web Bluetooth works, so the next scan can only
        // end here again.
        const scanAgainCanHelp = unavailableReason !== 'unsupported' && Platform.OS !== 'web';
        return (
          <View style={styles.state}>
            <Icon name="warning" size={40} color={systemColors.tertiaryLabel} />
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.stateText}>
              {unavailableReason === 'permission_denied'
                ? tSettings('ble.errorPermissionDenied')
                : t('mobile.bluetooth.unavailable')}
            </Text>
            {scanAgainCanHelp && scanAgainButton}
          </View>
        );
      }

      if (boards.length > 0) {
        return (
          <View style={styles.list}>
            {boards.map((board) => (
              <Pressable
                key={board.uuid}
                onPress={() => onSelect(board)}
                style={[styles.row, { borderColor: systemColors.separator }]}
              >
                <Icon name="bluetooth" size={20} color={systemColors.label} />
                <View style={styles.rowText}>
                  <Text variant="headline">{board.name}</Text>
                  <Text variant="subheadline" color={systemColors.secondaryLabel}>
                    {boardRowSubtitle(board, labelOptions)}
                  </Text>
                </View>
                <Icon name="add" size={20} color={systemColors.tertiaryLabel} />
              </Pressable>
            ))}
          </View>
        );
      }

      if (scanFinishedEmpty) {
        return (
          <View style={styles.state}>
            <Icon name="search" size={40} color={systemColors.tertiaryLabel} />
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.stateText}>
              {t('mobile.bluetooth.noResults')}
            </Text>
            {/* Android is withholding the results — say so instead of leaving a
                bare "none in range" the user can't act on. No "granted/enabled"
                follow-up copy on either branch: a successful grant restarts the
                scan immediately, so the branch is gone by the time it would
                render. */}
            {locationHint.shouldOfferLocationGrant ? (
              <>
                <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.stateText}>
                  {t('settings:ble.locationHintTitle')}
                </Text>
                <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.stateText}>
                  {t('settings:ble.locationHintBody')}
                </Text>
                <Button
                  title={t('settings:ble.locationHintGrant')}
                  onPress={handleGrantLocation}
                  variant="text"
                  size="medium"
                  loading={locationHint.isRequesting}
                />
              </>
            ) : locationHint.shouldOfferLocationServicesEnable ? (
              <>
                <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.stateText}>
                  {t('settings:ble.locationServicesHintTitle')}
                </Text>
                <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.stateText}>
                  {t('settings:ble.locationServicesHintBody')}
                </Text>
                <Button
                  title={t('settings:ble.locationServicesHintEnable')}
                  onPress={handleEnableLocationServices}
                  variant="text"
                  size="medium"
                  loading={locationHint.isPromptingServices}
                />
              </>
            ) : (
              // The zero-result state used to end here, with nothing to try next.
              <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.stateText}>
                {t('settings:ble.troubleshootTips')}
              </Text>
            )}
            {/* A board that was asleep or out of range a moment ago is the usual
                reason for an empty scan; the tips above say to fix that, this
                runs the scan again once they have. */}
            <Button
              title={tSettings('ble.scanAgain')}
              onPress={handleScanAgain}
              variant="text"
              size="medium"
              icon="refresh"
            />
          </View>
        );
      }

      // scanning / resolving
      return (
        <View style={styles.state}>
          <ActivityIndicator size="large" />
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.stateText}>
            {isResolving ? t('mobile.bluetooth.resolving') : t('mobile.bluetooth.scanning')}
          </Text>
        </View>
      );
    };

    return (
      <Sheet ref={ref} snapPoints={['55%']} onClose={onClose}>
        <View style={styles.content}>
          <Text variant="title3" style={styles.heading}>
            {t('mobile.bluetooth.title')}
          </Text>
          {renderBody()}
        </View>
      </Sheet>
    );
  },
);

const styles = StyleSheet.create({
  content: {
    flex: 1,
    padding: spacing[4],
  },
  heading: {
    marginBottom: spacing[4],
  },
  state: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
    paddingVertical: spacing[8],
  },
  // The blocked state stacks icon, title, a two or three line body and up to two
  // buttons. The default 32 pt top and bottom padding would push the last button
  // past a 55% sheet on a 667 pt phone, and further at large text sizes.
  blockedState: {
    paddingVertical: spacing[2],
  },
  stateText: {
    textAlign: 'center',
  },
  list: {
    gap: spacing[2],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowText: {
    flex: 1,
  },
});
