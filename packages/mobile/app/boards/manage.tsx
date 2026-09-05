import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSQLiteContext } from 'expo-sqlite';
import { useQuery } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useMyBoards, useProfile } from '../../src/lib/graphql/hooks';
import { useActiveBoard } from '../../src/lib/graphql/use-active-board';
import { useAuth } from '../../src/providers/auth-provider';
import { useConfirm } from '../../src/providers/dialog-provider';
import { useTheme } from '../../src/providers/theme-provider';
import {
  useOfflineDownloadProgressEnabled,
  useOfflineDownloadsEnabled,
} from '../../src/providers/feature-flags-provider';
import { useBottomChromeMetrics } from '../../src/hooks/use-bottom-chrome-metrics';
import { useSyncStatus } from '../../src/sync';
import {
  getCheckpoint,
  getCheckpointKey,
  readBootstrapRetryState,
  isScopeDownloadComplete,
  isBootstrapDone,
  getBootstrapMetadataByScope,
  estimateScopeDownload,
} from '@boardsesh/offline-sync';
import { reportAbandonedDownloadOnDisable } from '../../src/offline/abandoned-download-terminals';
import { useBoardDownloads } from '../../src/offline/use-board-downloads';
import { useSnapshotManifest } from '../../src/offline/use-snapshot-manifest';
import { useConfirmBoardDownload } from '../../src/offline/use-confirm-board-download';
import { useDownloadedScopeKeys } from '../../src/offline/use-downloaded-scope-keys';
import { useRememberDownloadedBoards } from '../../src/offline/use-remember-downloaded-boards';
import { useSnapshotSource } from '../../src/offline/use-snapshot-source';
import { formatBytes } from '../../src/lib/format-bytes';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../src/lib/analytics';
import { isOfflineEngineEnabled } from '../../src/lib/offline-engine';
import {
  getSetting,
  useSetting,
  setOfflineBoardEnabled,
  forgetDownloadTrigger,
  forgetOfflineBoardScope,
  useOfflineBoards,
  offlineBoardKeyForBoard,
  offlineBoardScopeForBoard,
} from '../../src/settings';
import { Text } from '../../src/components/Text';
import { Icon } from '../../src/components/Icon';
import { Button } from '../../src/components/Button';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { BoardManageRow } from '../../src/components/board-discovery/BoardManageRow';
import {
  boardDownloadNotice,
  boardDownloadState,
  boardIsBootstrapping,
  boardDownloadProgress,
} from '../../src/components/board-discovery/board-offline-state';
import { buildManageItems, type ManageItem } from '../../src/components/board-discovery/manage-items';
import { offlineBoardRows } from '../../src/components/board-discovery/offline-board-items';
import { useIsOffline } from '../../src/hooks/use-is-offline';
import { useStoredUserId } from '../../src/hooks/use-current-user-id';
import { iosSystemColors } from '../../src/theme/ios-colors';
import { spacing } from '../../src/theme/tokens';

const EMPTY_BOARDS: UserBoard[] = [];
const EMPTY_ITEMS: ManageItem[] = [];

const keyExtractor = (item: ManageItem) => item.key;
const getItemType = (item: ManageItem) => item.type;

export default function ManageBoards() {
  const router = useRouter();
  const { t, i18n } = useTranslation('boards');
  const { isAuthenticated, refreshAuthState } = useAuth();
  const { systemColors, brandColors } = useTheme();
  const confirm = useConfirm();
  const bottomChrome = useBottomChromeMetrics();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[4];

  const {
    data: profile,
    isLoading: isProfileLoading,
    isError: isProfileError,
    refetch: refetchProfile,
  } = useProfile({ enabled: isAuthenticated });
  // The profile is the fresher answer but it's network-only. Fall back to the id
  // the signed JWT already carries on this device, so owned-vs-followed survives a
  // cold start with no signal (and an online profile fetch that simply fails).
  const { userId: storedUserId, isLoading: isStoredUserIdLoading } = useStoredUserId(isAuthenticated && !profile?.id);
  const currentUserId = profile?.id ?? storedUserId;
  const { data: activeBoard } = useActiveBoard();
  const activeUuid = activeBoard?.uuid;

  const {
    data: boardConnection,
    isLoading,
    isError,
    refetch,
    isRefetching,
  } = useMyBoards(undefined, { enabled: isAuthenticated });
  const myBoards = boardConnection?.boards ?? EMPTY_BOARDS;

  // Offline download wiring. Subscribe to the sync status + enabled-boards setting
  // ONCE here (not per row) and derive a primitive state per row, so a download's
  // frequent progress frames only re-render the one row that's changing.
  //
  // The hook preserves the native/web platform split: native offline mode is
  // permanently on, while Expo web remains off because it lacks the native
  // SQLite/filesystem stack. This screen stays the only writer of
  // syncEnabledBoards.
  const offlineDownloadsEnabled = useOfflineDownloadsEnabled();
  const { retryFastDownload } = useBoardDownloads();
  const { confirmAndDownload } = useConfirmBoardDownload();
  // Warmed here on mount so the download-size estimate is already in cache when a
  // row's toggle is tapped — the confirm dialog must never wait on a fetch.
  //
  // Mirrored into a ref because the toggle handler only reads it at tap time:
  // keeping it out of that handler's deps means a manifest refresh can't churn the
  // callback identity and re-render every memoised row. The ref also always reads
  // the freshest manifest, which is exactly what the tap wants.
  const snapshotManifest = useSnapshotManifest();
  const snapshotManifestRef = useRef(snapshotManifest);
  snapshotManifestRef.current = snapshotManifest;
  const db = useSQLiteContext();
  const syncStatus = useSyncStatus();
  // Mirrored for the toggle-off handler, which only reads it at tap time: keeping
  // the live status out of that callback's deps means a progress frame can't churn
  // its identity and re-render every memoised row.
  const syncStatusRef = useRef(syncStatus);
  syncStatusRef.current = syncStatus;
  // This must be the same source the sync bridge uses. A build without the
  // snapshot base URL safely gets the ordinary paged downloader.
  const snapshotSource = useSnapshotSource();
  const snapshotSourceAvailable = snapshotSource !== undefined;
  // Keep the source generation defensive for build/runtime source transitions:
  // a paged interval must not reuse stale snapshot metadata if availability ever
  // changes. Production availability is fixed by the build-time URL.
  const [snapshotSourceState, setSnapshotSourceState] = useState(() => ({
    available: snapshotSourceAvailable,
    generation: 0,
  }));
  const snapshotSourceTransitionPending = snapshotSourceState.available !== snapshotSourceAvailable;
  useEffect(() => {
    if (!snapshotSourceTransitionPending) return;
    setSnapshotSourceState((previous) => ({
      available: snapshotSourceAvailable,
      generation: previous.generation + 1,
    }));
  }, [snapshotSourceAvailable, snapshotSourceTransitionPending]);
  const [enabledBoards] = useSetting('syncEnabledBoards');
  const enabledSet = useMemo(() => new Set(enabledBoards), [enabledBoards]);
  const isSyncing = syncStatus.isSyncing;
  const currentTable = syncStatus.progress?.currentTable ?? null;
  const currentTableProcessed = syncStatus.progress?.currentTableProcessed;
  const currentPhase = syncStatus.progress?.phase ?? null;
  // The live snapshot download frame, whichever scope it names (issue #4311).
  // Read once here and matched per row below, so a row that is NOT the one
  // downloading gets a stable `null` prop and its memo holds.
  const snapshotFrame = syncStatus.progress?.snapshot;
  // Compatibility seam retained while the row API still accepts a boolean;
  // native snapshot progress is permanently enabled.
  const downloadProgressEnabled = useOfflineDownloadProgressEnabled();

  // Per-scope "downloaded" signal: which scopes actually have a board_climbs
  // checkpoint. Refetched whenever a cycle finishes (isSyncing → false), so a
  // board flips to "Available offline" only once its own data has landed.
  // Ungated by the flag: the offline fallback below needs it too, and a device that
  // still holds downloads after a kill-switch rollback must not be stranded. One
  // cheap indexed read, shared with the Storage screen's cache entry.
  const { data: downloadedScopeKeys, refetch: refetchDownloaded } = useDownloadedScopeKeys();
  const downloadedSet = useMemo(() => new Set(downloadedScopeKeys ?? []), [downloadedScopeKeys]);
  useEffect(() => {
    if (offlineDownloadsEnabled && (!isSyncing || syncStatus.scopeCompletionRevision > 0)) void refetchDownloaded();
  }, [offlineDownloadsEnabled, isSyncing, refetchDownloaded, syncStatus.scopeCompletionRevision]);

  // Snapshot attempt/done markers are persisted per scope. Read them in one
  // query and keep the resulting map in O(1) row lookups; My Boards is a
  // virtualised list and must never open a SQLite read for every rendered row.
  // Each marker-changing revision gets a distinct cache entry. React Query may
  // retain the previous key's successful value while a refetch is pending or
  // after it fails; the payload revision is a second fail-closed guard so that
  // stale outcome is never rendered or announced as current.
  const bootstrapMetadataQueryRevision = useMemo(
    () =>
      JSON.stringify([
        syncStatus.bootstrapMetadataRevision,
        syncStatus.scopeCompletionRevision,
        snapshotSourceState.generation,
        enabledBoards,
      ]),
    [
      enabledBoards,
      snapshotSourceState.generation,
      syncStatus.bootstrapMetadataRevision,
      syncStatus.scopeCompletionRevision,
    ],
  );
  const { data: bootstrapMetadataResult } = useQuery({
    queryKey: ['bootstrapMetadataByScope', bootstrapMetadataQueryRevision],
    queryFn: async () => ({
      revision: bootstrapMetadataQueryRevision,
      metadataByScope: await getBootstrapMetadataByScope(db, enabledBoards),
    }),
    enabled:
      offlineDownloadsEnabled &&
      snapshotSourceAvailable &&
      !snapshotSourceTransitionPending &&
      enabledBoards.length > 0,
    gcTime: 0,
  });
  const bootstrapMetadataByScope =
    !snapshotSourceTransitionPending && bootstrapMetadataResult?.revision === bootstrapMetadataQueryRevision
      ? bootstrapMetadataResult.metadataByScope
      : undefined;

  const handleToggleOffline = useCallback(
    async (board: UserBoard) => {
      const scope = offlineBoardScopeForBoard(board);
      const key = offlineBoardKeyForBoard(board);
      const alreadyEnabled = getSetting('syncEnabledBoards').includes(key);
      if (alreadyEnabled) {
        // How far had it got? Read BEFORE the setting write, so the cancel event
        // below carries the live progress frame (issue #4316). It needs a
        // snapshot frame naming this exact scope, so it is silent for a paged
        // crawl — the funnel terminal further down is the signal that always
        // fires, this is the extra detail when we happen to have it.
        const liveProgress = boardDownloadProgress({
          scopeKey: key,
          isSyncing: syncStatusRef.current.isSyncing,
          currentTable: syncStatusRef.current.progress?.currentTable ?? null,
          phase: syncStatusRef.current.progress?.phase ?? null,
          snapshot: syncStatusRef.current.progress?.snapshot,
          // The progress hook is permanently true on native. Keeping the value
          // explicit here makes the cancellation telemetry contract obvious.
          progressEnabled: downloadProgressEnabled,
        });
        // Disabling just drops the setting entry; the cached rows + checkpoint stay
        // so re-enabling resumes instantly, so no confirm is needed.
        setOfflineBoardEnabled(scope, false);
        // Drop the offline picker's snapshots for this scope too, so it stops
        // offering a board the user just opted out of.
        forgetOfflineBoardScope(scope);
        // …and its pending download attribution, so a later re-enable is attributed
        // to the tap that actually caused it rather than to this abandoned one.
        forgetDownloadTrigger(key);
        track(SHARED_EVENTS.OfflineBoardToggled, {
          scopeKey: key,
          enabled: false,
          source: 'manage',
          offlineEngineEnabled: isOfflineEngineEnabled(),
        });
        if (liveProgress) {
          track(SHARED_EVENTS.OfflineBoardDownloadCancelled, {
            scopeKey: key,
            source: 'manage',
            stage: liveProgress.stage,
            fraction: liveProgress.fraction,
            bytesDone: liveProgress.bytesDone,
            offlineEngineEnabled: isOfflineEngineEnabled(),
          });
        }
        // The funnel's terminal (issue #4452). Turning a board off deletes
        // nothing, so there is no teardown to hang this off — but the scope has
        // just left `syncEnabledBoards`, and pullSync only ever visits enabled
        // scopes, so this download is over for good. Reported and its markers
        // cleared, so a re-enable opens a fresh Started → Completed pair rather
        // than resuming a funnel this tap ended.
        await reportAbandonedDownloadOnDisable(db, key);
        return;
      }
      // Size quote + confirm + enable, shared with the discovery-nudge surfaces.
      await confirmAndDownload(board, { trigger: 'toggle', source: 'manage' });
    },
    [confirmAndDownload, db],
  );

  // The escape from a board that settled onto the slow crawl (issue #4313).
  // Consented and size-disclosed on purpose: this is the largest single download
  // in the app, and the automatic paths deliberately never ask.
  const handleRetryFastDownload = useCallback(
    async (board: UserBoard) => {
      const scope = offlineBoardScopeForBoard(board);
      const key = offlineBoardKeyForBoard(board);
      const now = Date.now();
      const [climbsCheckpoint, statsCheckpoint, scopeComplete, bootstrapAlreadyDone] = await Promise.all([
        getCheckpoint(db, getCheckpointKey('board_climbs', key)),
        getCheckpoint(db, getCheckpointKey('board_climb_stats', key)),
        isScopeDownloadComplete(db, key),
        isBootstrapDone(db, key),
      ]);
      const hasBoardCheckpoint = !!climbsCheckpoint || !!statsCheckpoint;
      const { state: retryState } = await readBootstrapRetryState(
        db,
        key,
        { now, random: Math.random },
        hasBoardCheckpoint,
      );
      const estimate = estimateScopeDownload({
        manifest: snapshotManifestRef.current,
        boardType: scope.boardType,
        layoutId: scope.layoutId,
        retryState,
        hasBoardCheckpoint,
        isScopeComplete: scopeComplete,
        isBootstrapDone: bootstrapAlreadyDone,
        now,
        // Restoring the budget IS the action being confirmed, so the terminal
        // state the row is showing must not suppress the size.
        userRequested: true,
      });
      const confirmed = await confirm({
        title: t('mobile.offline.retryFastDownloadTitle'),
        message:
          estimate.kind === 'snapshot'
            ? t('mobile.offline.retryFastDownloadMessageWithSize', {
                size: formatBytes(estimate.bytes, i18n.language),
              })
            : t('mobile.offline.retryFastDownloadMessage'),
        confirmLabel: t('mobile.offline.retryFastDownloadConfirm'),
        cancelLabel: t('mobile.manage.cancel'),
      });
      if (!confirmed) return;
      await retryFastDownload(board);
    },
    [confirm, t, i18n.language, db, retryFastDownload],
  );

  // See boards/index.tsx: a hard 401 clears tokens without flipping
  // isAuthenticated, so re-validate on error to escape a stuck retry loop.
  useEffect(() => {
    if (isError) void refreshAuthState();
  }, [isError, refreshAuthState]);

  // Split into owned + followed groups (pure helper, unit-tested). Each board
  // carries precomputed isOwned/isActive so a row never scans for them.
  const items = useMemo(
    () =>
      buildManageItems(myBoards, currentUserId, activeUuid, {
        ownedHeader: t('mobile.manage.ownedHeader'),
        followingHeader: t('mobile.manage.followingHeader'),
      }),
    [myBoards, currentUserId, activeUuid, t],
  );

  // Offline this screen has TWO independent failures: `useMyBoards` and `useProfile`
  // are both plain network queries. Fall back to the boards this device downloaded,
  // grouped the same way the online list is — `currentUserId` now resolves from the
  // stored JWT, so the user's own wall still lands under "Your boards" instead of
  // being filed as something they follow. Only when even that is missing (a keychain
  // read that failed) do the headers drop and the list goes flat, because an
  // undefined id would confidently mis-file every board.
  const isOffline = useIsOffline();
  const offlineCards = useOfflineBoards();
  // "No id is coming" — both sources have to have settled, or a slow keychain read
  // would briefly look like a missing identity and flip the screen to the offline
  // list on its way to the normal one.
  const noUserIdAvailable = !currentUserId && !isProfileLoading && !isStoredUserIdLoading;
  // PRECEDENCE, three tiers: live `myBoards` query > persisted `myBoards` cache >
  // `offlineBoardsV1` MMKV cards. Tier 2 arrives below as `cachedMyBoards`, warm
  // on a cold start since #4353 (`src/lib/query-persist`). Tier 3 is the last
  // resort on purpose: it survives the cache's 14-day maxAge and is pruned
  // deliberately by `useRememberDownloadedBoards`, so it is the only tier that
  // still answers after the persisted cache expires.
  //
  // With `['profile']` persisted, `currentUserId = profile?.id ?? storedUserId`
  // now resolves from disk on a cold start too, so the `!currentUserId` hard-error
  // branch further down is reachable only when the profile blob AND the keychain
  // read are both gone — the general fix for what #4309 worked around per-screen.
  const shouldUseOfflineList = isOffline || noUserIdAvailable || (isError && myBoards.length === 0);
  const offlineItems = useMemo(() => {
    if (!shouldUseOfflineList) return EMPTY_ITEMS;
    const rows = offlineBoardRows({
      cards: offlineCards,
      cachedMyBoards: myBoards,
      activeBoard: activeBoard ?? null,
      downloadedScopeKeys: downloadedScopeKeys ?? [],
    });
    if (currentUserId !== undefined) {
      return buildManageItems(rows, currentUserId, activeUuid, {
        ownedHeader: t('mobile.manage.ownedHeader'),
        followingHeader: t('mobile.manage.followingHeader'),
      });
    }
    return rows.map((board): ManageItem => ({
      type: 'board',
      key: board.uuid,
      board,
      // `=== true` because a snapshot written by an older build can be missing
      // the field entirely, and the row prop is a plain boolean.
      isOwned: board.isOwned === true,
      isActive: board.uuid === activeUuid,
    }));
  }, [shouldUseOfflineList, offlineCards, myBoards, activeBoard, downloadedScopeKeys, activeUuid, currentUserId, t]);
  // Only take over the screen when there is actually something to show; otherwise the
  // existing loading/error states still tell the more honest story.
  const showOfflineList = shouldUseOfflineList && offlineItems.length > 0;
  // Keep the snapshots fresh from the live list while online (renames, a backfill for
  // boards downloaded before this existed, and a prune of boards the server dropped).
  useRememberDownloadedBoards(boardConnection);

  const onCreate = useCallback(() => {
    router.push('/boards/create');
  }, [router]);

  const renderItem = useCallback(
    ({ item }: { item: ManageItem }) => {
      if (item.type === 'header') {
        return (
          <Text variant="title3" style={styles.sectionHeader}>
            {item.title}
          </Text>
        );
      }
      const scopeKey = offlineBoardKeyForBoard(item.board);
      const bootstrapMetadata = bootstrapMetadataByScope?.get(scopeKey);
      // The metadata batch and downloaded-scope query refetch together on the
      // per-scope callback. Let either committed marker win so a scheduling race
      // between those two reads cannot briefly put a completed row back in pending.
      const isDownloaded = downloadedSet.has(scopeKey) || (bootstrapMetadata?.isScopeComplete ?? false);
      // undefined is reserved for platforms without native offline support.
      const downloadStateInput = {
        scopeKey,
        enabled: enabledSet.has(scopeKey),
        isBootstrapDone: bootstrapMetadata?.isBootstrapDone ?? false,
        isSyncing,
        downloaded: isDownloaded,
        currentTable,
        phase: currentPhase,
      };
      const downloadState = offlineDownloadsEnabled ? boardDownloadState(downloadStateInput) : undefined;
      const isBootstrapping = downloadState === 'downloading' && boardIsBootstrapping(downloadStateInput);
      const isPagedDownloadActive = downloadState === 'downloading' && !isBootstrapping;
      const downloadNotice = offlineDownloadsEnabled
        ? boardDownloadNotice({
            enabled: enabledSet.has(scopeKey),
            downloaded: isDownloaded,
            snapshotSourceAvailable,
            bootstrapAttempts: bootstrapMetadata?.attempts ?? 0,
            isTerminal: bootstrapMetadata?.isTerminal ?? false,
            retryAfter: bootstrapMetadata?.retryAfter ?? null,
            isBootstrapDone: bootstrapMetadata?.isBootstrapDone ?? false,
            isPagedFallback: bootstrapMetadata?.isPagedFallback ?? false,
            hasBoardCheckpoint: bootstrapMetadata?.hasBoardCheckpoint ?? false,
            isScopeComplete: bootstrapMetadata?.isScopeComplete ?? false,
            isBootstrapping,
            isPagedDownloadActive,
          })
        : null;
      // Only the board actually downloading gets the live count / bootstrap
      // flag; every other row gets undefined/false (stable props), so its
      // memo skips the per-frame churn.
      const downloadCount = downloadState === 'downloading' ? currentTableProcessed : undefined;
      const downloadProgress = isBootstrapping
        ? boardDownloadProgress({
            scopeKey,
            isSyncing,
            currentTable,
            phase: currentPhase,
            snapshot: snapshotFrame,
            progressEnabled: downloadProgressEnabled,
          })
        : null;
      // Offered only where it can actually help: a board that has settled onto
      // the crawl and has not yet finished it. A completed scope already holds
      // the whole catalog, so an artifact buys it nothing.
      const canRetryFastDownload =
        offlineDownloadsEnabled &&
        snapshotSourceAvailable &&
        enabledSet.has(scopeKey) &&
        !isDownloaded &&
        (bootstrapMetadata?.isTerminal ?? false) &&
        !(bootstrapMetadata?.isBootstrapDone ?? false);
      return (
        <BoardManageRow
          board={item.board}
          isOwned={item.isOwned}
          isActive={item.isActive}
          downloadState={downloadState}
          downloadCount={downloadCount}
          isBootstrapping={isBootstrapping}
          downloadProgress={downloadProgress}
          downloadNotice={downloadNotice}
          canRetryFastDownload={canRetryFastDownload}
          onRetryFastDownload={handleRetryFastDownload}
          onToggleOffline={handleToggleOffline}
        />
      );
    },
    [
      offlineDownloadsEnabled,
      enabledSet,
      isSyncing,
      downloadedSet,
      currentTable,
      currentTableProcessed,
      currentPhase,
      snapshotFrame,
      downloadProgressEnabled,
      bootstrapMetadataByScope,
      snapshotSourceAvailable,
      handleToggleOffline,
      handleRetryFastDownload,
    ],
  );

  if (!isAuthenticated) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <Icon name="person" size={40} color={iosSystemColors.systemGray} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.signInTitle')}
        </Text>
        <Text variant="subheadline" style={styles.stateSubtitle}>
          {t('mobile.signInSubtitle')}
        </Text>
        <Button title={t('mobile.signInCta')} onPress={() => router.push('/auth/login')} style={styles.stateButton} />
      </View>
    );
  }

  // Wait for an id too: owned-vs-followed is keyed on currentUserId, so rendering
  // before either source resolves would file the user's own boards under
  // "Following" (myBoards can win the race on a cold open / deep link).
  if (
    !showOfflineList &&
    ((isLoading && myBoards.length === 0) || ((isProfileLoading || isStoredUserIdLoading) && !currentUserId))
  ) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  // Boards failed with nothing cached, OR neither the profile nor the stored JWT
  // yielded an id — without currentUserId we can't classify owned vs followed, so
  // never render the list; offer a retry that refetches both.
  if (!showOfflineList && ((isError && myBoards.length === 0) || !currentUserId)) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <Icon name="error" size={40} color={iosSystemColors.systemRed} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.errorTitle')}
        </Text>
        <Button
          title={t('mobile.errorRetry')}
          variant="outlined"
          loading={isRefetching}
          onPress={() => {
            void refetch();
            if (isProfileError || !currentUserId) void refetchProfile();
          }}
          style={styles.stateButton}
        />
      </View>
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      <FlashList
        data={showOfflineList ? offlineItems : items}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        getItemType={getItemType}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom }}
        ListHeaderComponent={
          showOfflineList ? (
            <View style={styles.listHeader}>
              {/* Only the offline branch actually has no signal — the profile-failure
                  and lying-connection branches have bars and a dead request. */}
              <Text variant="subheadline" style={styles.offlineNotice}>
                {isOffline ? t('mobile.offline.pickerNotice') : t('mobile.offline.pickerNoticeUnreachable')}
              </Text>
            </View>
          ) : items.length > 0 ? (
            <View style={styles.listHeader}>
              <Button title={t('mobile.discovery.create')} variant="outlined" onPress={onCreate} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Icon name="boards" size={48} color={systemColors.tertiaryLabel} />
            <Text variant="headline" style={styles.emptyTitle}>
              {t('mobile.emptyTitle')}
            </Text>
            <Text variant="subheadline" style={styles.emptySubtitle}>
              {t('mobile.emptySubtitle')}
            </Text>
            <Button title={t('mobile.discovery.create')} onPress={onCreate} style={styles.emptyCta} />
          </View>
        }
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={brandColors.primary} />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  listHeader: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    paddingBottom: spacing[2],
  },
  offlineNotice: {
    opacity: 0.7,
  },
  sectionHeader: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[5],
    paddingBottom: spacing[2],
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[8],
  },
  stateTitle: {
    marginTop: spacing[3],
    textAlign: 'center',
  },
  stateSubtitle: {
    marginTop: spacing[1],
    textAlign: 'center',
    opacity: 0.6,
  },
  stateButton: {
    marginTop: spacing[4],
  },
  emptyState: {
    alignItems: 'center',
    paddingHorizontal: spacing[8],
    paddingVertical: spacing[16],
    gap: spacing[2],
  },
  emptyTitle: {
    marginTop: spacing[3],
    opacity: 0.6,
  },
  emptySubtitle: {
    opacity: 0.4,
    textAlign: 'center',
  },
  emptyCta: {
    marginTop: spacing[5],
  },
});
