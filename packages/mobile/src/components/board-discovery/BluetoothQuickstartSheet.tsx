import { PressableSurface } from '../PressableSurface';
import { forwardRef, memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { View, Platform, StyleSheet } from 'react-native';
import type BottomSheet from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { BoardName, UserBoard } from '@boardsesh/shared-schema';
import { boardRowSubtitle, formatBoardDisplayName, type BoardLabelOptions } from '@boardsesh/board-config';
import { useSprayLabelOptions } from '../../lib/spray/use-spray-label-options';
import { useBoardScan } from '../../lib/ble/use-board-scan';
import { useAndroidScanLocationHint } from '../../lib/ble/use-android-scan-location-hint';
import { bluetoothBlockedBody } from '../../lib/ble/bluetooth-unavailable-alert';
import { canOpenAppSettings, openAppSettings } from '../../lib/open-app-settings';
import { useBoardsBySerialNumbers } from '../../lib/graphql/hooks';
import { selectBleBoardCandidates } from '../../lib/ble/select-board-candidates';
import { useMyBoardSerialConfigs } from '../../lib/ble/use-my-board-serial-configs';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { Sheet, dismissSheetAndWait } from '../Sheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { MEDIUM_SNAP_POINTS } from '../sheet-snap-points';
import { buildQuickstartRows, quickstartLookupState, type QuickstartRow } from './quickstart-scan-rows';

const EMPTY_BOARDS: UserBoard[] = [];

type BluetoothQuickstartSheetProps = {
  /** True while the sheet is open — drives when the scan kicks off. */
  active: boolean;
  onClose: () => void;
  onSelect: (board: UserBoard) => void;
  /**
   * "Find it at my gym" on a board we couldn't name: the boards near the
   * climber, of this type. Called once the sheet has slid away, so the location
   * prompt never lands on a dismissing sheet.
   */
  onFindAtGym: (boardType: BoardName) => void;
  /**
   * "It's my own board" on a board we couldn't name: the builder, opened on
   * this type. Called once the sheet has slid away, so the push never starts
   * under it.
   */
  onOwnBoard: (boardType: BoardName) => void;
};

/**
 * Bluetooth quickstart: scans for in-range boards (scan-only, no connection),
 * resolves Aurora serials to saved boards, and lets the user pick one to make
 * active. Mirrors the web home's Bluetooth card flow.
 *
 * A board it can't name still gets a row, closest first: a MoonBoard, a
 * Kilter-built box with no serial in its name, a serial nobody has saved, and a
 * serial it couldn't look up offline. Each says what we heard and offers the
 * next step (see quickstart-scan-rows.ts).
 */
export const BluetoothQuickstartSheet = forwardRef<BottomSheet, BluetoothQuickstartSheetProps>(
  function BluetoothQuickstartSheet({ active, onClose, onSelect, onFindAtGym, onOwnBoard }, ref) {
    const { systemColors } = useTheme();
    const { t } = useTranslation(['boards', 'settings']);
    const { t: tSettings } = useTranslation('settings');
    const labelOptions = useSprayLabelOptions();
    const { status, unavailableReason, serials, advertisedTypes, devices, start, reset } = useBoardScan();
    // Scoped to what each controller announced. Aurora reuses a serial across
    // board apps, so unscoped this sheet would offer a stranger's Kilter board
    // for an in-range Tension controller and let the user make it active.
    const boardLookup = useBoardsBySerialNumbers(serials, advertisedTypes);
    const { data: boards, isLoading: isResolvingBoards, refetch: refetchBoards } = boardLookup;
    const { data: serialConfigs, isResolving: isResolvingPreferences } = useMyBoardSerialConfigs(serials);
    const visibleBoards = useMemo(
      () => selectBleBoardCandidates(boards ?? EMPTY_BOARDS, serialConfigs, advertisedTypes),
      [advertisedTypes, boards, serialConfigs],
    );
    // With no signal the lookup pauses instead of failing (`networkMode:
    // 'offlineFirst'`), so a paused lookup counts as failed: it used to read as
    // "No boards in range" while a board stood in front of the climber.
    const lookup = quickstartLookupState({
      serialCount: serials.length,
      hasResult: boards !== undefined,
      failed: boardLookup.isError || boardLookup.fetchStatus === 'paused',
      resolving: isResolvingBoards || isResolvingPreferences,
    });
    const rows = useMemo(
      () => buildQuickstartRows({ devices, boards: visibleBoards, lookup }),
      [devices, visibleBoards, lookup],
    );

    // `lookup !== 'pending'` matters: the scan reports 'done' the moment the
    // radio work finishes, while serial rows wait until GraphQL has turned the
    // serials into boards. Without it, a scan that found plenty of boards spends
    // the resolution window looking exactly like a scan that found none.
    const scanFinishedEmpty = status === 'done' && rows.length === 0 && lookup !== 'pending';
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
    const handleRetryLookup = useCallback(() => {
      void refetchBoards();
    }, [refetchBoards]);

    // The sheet's own handle, beside the one forwarded to the screen, so the
    // next-step actions can close it and wait.
    const sheetRef = useRef<BottomSheet | null>(null);
    const setSheetRef = useCallback(
      (instance: BottomSheet | null) => {
        sheetRef.current = instance;
        if (typeof ref === 'function') ref(instance);
        else if (ref) ref.current = instance;
      },
      [ref],
    );
    // Closes the sheet, then hands over once it has slid away (at once if it
    // never reached the screen). A second tap while it slides is ignored, and
    // a sheet re-opened before it settled hands over nothing.
    const leavingRef = useRef(false);
    const closeThen = useCallback((handOver: () => void) => {
      if (leavingRef.current) return;
      leavingRef.current = true;
      void dismissSheetAndWait(sheetRef.current).then((result) => {
        leavingRef.current = false;
        if (result.status === 'dismissed') handOver();
      });
    }, []);
    const handleFindAtGym = useCallback(
      (boardType: BoardName) => closeThen(() => onFindAtGym(boardType)),
      [closeThen, onFindAtGym],
    );
    const handleOwnBoard = useCallback(
      (boardType: BoardName) => closeThen(() => onOwnBoard(boardType)),
      [closeThen, onOwnBoard],
    );

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
              <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.stateText}>
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
        // again brings the system dialog back. Nor is an iOS alert left
        // unanswered ('not_asked'): scanning again asks. No Scan again for a
        // phone with no Bluetooth LE, or in any browser: the web BLE manager
        // always reads the radio as off, even where Web Bluetooth works, so the
        // next scan can only end here again.
        const scanAgainCanHelp = unavailableReason !== 'unsupported' && Platform.OS !== 'web';
        return (
          <View style={styles.state}>
            <Icon name="warning" size={40} color={systemColors.tertiaryLabel} />
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.stateText}>
              {unavailableReason === 'not_asked'
                ? t('mobile.bluetooth.notAsked')
                : unavailableReason === 'permission_denied'
                  ? tSettings('ble.errorPermissionDenied')
                  : t('mobile.bluetooth.unavailable')}
            </Text>
            {scanAgainCanHelp && scanAgainButton}
          </View>
        );
      }

      if (rows.length > 0) {
        // Not virtualised: one row per board in radio range, with the boards we
        // can't name folded to one row per type, so it stays a handful.
        return (
          <View style={styles.list}>
            {rows.map((row) =>
              row.kind === 'board' ? (
                <ResolvedBoardRow key={row.key} board={row.board} labelOptions={labelOptions} onSelect={onSelect} />
              ) : (
                <NextStepRow
                  key={row.key}
                  kind={row.kind}
                  boardType={row.kind === 'lookup_failed' ? null : row.boardType}
                  onFindAtGym={handleFindAtGym}
                  onOwnBoard={handleOwnBoard}
                  onRetryLookup={handleRetryLookup}
                />
              ),
            )}
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
                <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.stateText}>
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
                <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.stateText}>
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
              <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.stateText}>
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
            {lookup === 'pending' ? t('mobile.bluetooth.resolving') : t('mobile.bluetooth.scanning')}
          </Text>
        </View>
      );
    };

    // Scrollable: the Android empty scan (hint title, body and a grant button
    // under "No boards in range") runs past a medium sheet on a 667 pt phone at
    // large text, and so do a few rows that each carry two buttons. Without a
    // scroll the buttons at the bottom were the part that got cut off.
    return (
      <Sheet
        ref={setSheetRef}
        snapPoints={MEDIUM_SNAP_POINTS}
        onClose={onClose}
        scrollable
        contentContainerStyle={styles.scrollContent}
      >
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

/** A heard serial that matched a saved board: tap to make it active. */
const ResolvedBoardRow = memo(function ResolvedBoardRow({
  board,
  labelOptions,
  onSelect,
}: {
  board: UserBoard;
  labelOptions: BoardLabelOptions;
  onSelect: (board: UserBoard) => void;
}) {
  const { systemColors } = useTheme();
  const handlePress = useCallback(() => onSelect(board), [board, onSelect]);
  return (
    <PressableSurface
      accessibilityRole="button"
      onPress={handlePress}
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
    </PressableSurface>
  );
});

type NextStepKind = Exclude<QuickstartRow['kind'], 'board'>;

/**
 * A board we heard but can't name, or can't look up: what it is, and the way
 * forward. `boardType` is null only for `lookup_failed`, whose way forward is
 * trying the lookup again.
 */
const NextStepRow = memo(function NextStepRow({
  kind,
  boardType,
  onFindAtGym,
  onOwnBoard,
  onRetryLookup,
}: {
  kind: NextStepKind;
  boardType: BoardName | null;
  onFindAtGym: (boardType: BoardName) => void;
  onOwnBoard: (boardType: BoardName) => void;
  onRetryLookup: () => void;
}) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const handleFindAtGym = useCallback(() => {
    if (boardType) onFindAtGym(boardType);
  }, [boardType, onFindAtGym]);
  const handleOwnBoard = useCallback(() => {
    if (boardType) onOwnBoard(boardType);
  }, [boardType, onOwnBoard]);

  const board = boardType ? formatBoardDisplayName(boardType) : '';
  // Literal keys per kind: the i18n lint rejects a computed one.
  let title: string;
  let body: string;
  switch (kind) {
    case 'unknown_setup':
      title = t('mobile.bluetooth.unknownSetupTitle', { board });
      body = t('mobile.bluetooth.unknownSetupBody');
      break;
    case 'moonboard':
      title = t('mobile.bluetooth.moonboardTitle');
      body = t('mobile.bluetooth.moonboardBody');
      break;
    case 'bare_name':
      title = t('mobile.bluetooth.bareNameTitle', { board });
      body = t('mobile.bluetooth.bareNameBody');
      break;
    case 'lookup_failed':
      title = t('mobile.bluetooth.needSignalTitle');
      body = t('mobile.bluetooth.needSignalBody');
      break;
  }

  return (
    <View style={[styles.row, styles.nextStepRow, { borderColor: systemColors.separator }]}>
      <View style={styles.nextStepHeader}>
        <Icon name="bluetooth" size={20} color={systemColors.label} />
        <View style={styles.rowText}>
          <Text variant="headline">{title}</Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {body}
          </Text>
        </View>
      </View>
      <View style={styles.nextStepActions}>
        {kind === 'lookup_failed' ? (
          <Button title={t('mobile.errorRetry')} onPress={onRetryLookup} variant="tonal" size="small" icon="refresh" />
        ) : (
          <>
            <Button
              title={t('mobile.bluetooth.findAtGym')}
              onPress={handleFindAtGym}
              variant="tonal"
              size="small"
              icon="gym"
            />
            <Button
              title={t('mobile.bluetooth.ownBoard')}
              onPress={handleOwnBoard}
              variant="text"
              size="small"
              icon="home"
            />
          </>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  // At least the sheet's height, so a short state still centres in it; taller
  // content grows past it and scrolls.
  scrollContent: {
    flexGrow: 1,
  },
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
  // Text above, buttons below: two labelled buttons beside the text would leave
  // the title a word wide on a small phone.
  nextStepRow: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  nextStepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  nextStepActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing[2],
  },
});
