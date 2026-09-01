import { forwardRef, useCallback, useEffect } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import type BottomSheet from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useBoardScan } from '../../lib/ble/use-board-scan';
import { useAndroidScanLocationHint } from '../../lib/ble/use-android-scan-location-hint';
import { useBoardsBySerialNumbers } from '../../lib/graphql/hooks';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { boardRowSubtitle } from './board-labels';
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
    const { status, serials, advertisedTypes, start, reset } = useBoardScan();
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
        return (
          <View style={styles.state}>
            <Icon name="warning" size={40} color={systemColors.tertiaryLabel} />
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.stateText}>
              {t('mobile.bluetooth.unavailable')}
            </Text>
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
                    {boardRowSubtitle(board)}
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
