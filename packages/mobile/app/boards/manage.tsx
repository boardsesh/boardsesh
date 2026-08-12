import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useNavigation, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSQLiteContext } from 'expo-sqlite';
import { useQuery } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useMyBoards, useProfile, useDeleteBoard, useUnfollowBoard } from '../../src/lib/graphql/hooks';
import { useActiveBoard, useClearActiveBoard } from '../../src/lib/graphql/use-active-board';
import { useAuth } from '../../src/providers/auth-provider';
import { useToast } from '../../src/providers/toast-provider';
import { useConfirm } from '../../src/providers/dialog-provider';
import { useTheme } from '../../src/providers/theme-provider';
import {
  useOfflineDownloadProgressEnabled,
  useOfflineDownloadsEnabled,
} from '../../src/providers/feature-flags-provider';
import { useBottomChromeMetrics } from '../../src/hooks/use-bottom-chrome-metrics';
import { useSyncStatus } from '../../src/sync';
import {
  getDownloadedScopeKeys,
  getCheckpoint,
  getCheckpointKey,
  readBootstrapRetryState,
  isScopeDownloadComplete,
  isBootstrapDone,
  getBootstrapMetadataByScope,
  estimateScopeDownload,
} from '@boardsesh/offline-sync';
import { useBoardDownloads } from '../../src/offline/use-board-downloads';
import { useRememberDownloadedBoards } from '../../src/offline/use-remember-downloaded-boards';
import { useSnapshotManifest } from '../../src/offline/use-snapshot-manifest';
import { useSnapshotSource } from '../../src/offline/use-snapshot-source';
import { useOfflineSchemaReady } from '../../src/db/use-offline-schema-ready';
import { formatBytes } from '../../src/lib/format-bytes';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../src/lib/analytics';
import { isOfflineEngineEnabled } from '../../src/lib/offline-engine';
import {
  getSetting,
  useSetting,
  setOfflineBoardEnabled,
  forgetDownloadTrigger,
  forgetOfflineBoard,
  forgetOfflineBoardScope,
  useOfflineBoards,
  offlineBoardKeyForBoard,
  offlineBoardScopeForBoard,
} from '../../src/settings';
import { hapticSelection } from '../../src/lib/haptics';
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
  const navigation = useNavigation();
  const { t, i18n } = useTranslation('boards');
  const { isAuthenticated, refreshAuthState } = useAuth();
  const { systemColors, brandColors } = useTheme();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const bottomChrome = useBottomChromeMetrics();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[4];

  // Traditional iOS-style edit mode: an "Edit"/"Done" header button reveals a
  // persistent per-row remove control, so unfollow/delete never depend on the
  // (hard-to-hit) swipe alone.
  const [isEditing, setIsEditing] = useState(false);

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

  const deleteBoard = useDeleteBoard();
  const unfollowBoard = useUnfollowBoard();
  const clearActiveBoard = useClearActiveBoard();

  // Offline download wiring. Subscribe to the sync status + enabled-boards setting
  // ONCE here (not per row) and derive a primitive state per row, so a download's
  // frequent progress frames only re-render the one row that's changing.
  //
  // This surface is behind the offline-board-downloads flag: off (or absent)
  // hides the per-row toggle + status caption. The flag gates the entire offline
  // engine, not just this screen — with it off the sync scheduler never starts,
  // reads/writes stay network-only, and only previously-queued writes still
  // flush (see OfflineSyncBridge). This screen stays the only writer of
  // syncEnabledBoards.
  const offlineDownloadsEnabled = useOfflineDownloadsEnabled();
  const { enableBoardsOffline } = useBoardDownloads();
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
  // This connection is handed out as soon as the launch gate opens — after the first
  // init attempt, whatever it did — so on a contended launch it has no tables yet.
  const schemaReady = useOfflineSchemaReady();
  const syncStatus = useSyncStatus();
  // Mirrored for the toggle-off handler, which only reads it at tap time: keeping
  // the live status out of that callback's deps means a progress frame can't churn
  // its identity and re-render every memoised row.
  const syncStatusRef = useRef(syncStatus);
  syncStatusRef.current = syncStatus;
  // This must be the same gate the sync bridge uses. A previous app version can
  // leave bootstrap markers in SQLite, but they are meaningless while this build
  // is intentionally running the ordinary paged downloader.
  const snapshotSource = useSnapshotSource();
  const snapshotSourceAvailable = snapshotSource !== undefined;
  // A flag-off interval can run the ordinary paged downloader without advancing
  // either snapshot revision (for example, when only the first page lands). Keep
  // a local source generation so turning snapshot bootstrap back on cannot reuse
  // the pre-toggle React Query entry. The transition render is deliberately
  // unresolved; its effect advances the generation, then the new key reads SQLite.
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
  // The UI half of the download-progress kill switch: `useSnapshotSource` drops
  // the native progress callback, but the engine keeps flushing its three stage
  // frames regardless, so the row would otherwise sit on "Downloading 0 MB of
  // 103 MB" with the switch off. `boardDownloadProgress` takes this as a
  // required input so no call site can forget it.
  const downloadProgressEnabled = useOfflineDownloadProgressEnabled();

  // Per-scope "downloaded" signal: which scopes actually have a board_climbs
  // checkpoint. Refetched whenever a cycle finishes (isSyncing → false), so a
  // board flips to "Available offline" only once its own data has landed.
  // Ungated by the flag: the offline fallback below needs it too, and a device that
  // still holds downloads after a kill-switch rollback must not be stranded. One
  // cheap indexed read, shared with the Storage screen's cache entry.
  //
  // Readiness is a KEY member, not an `enabled` gate: a read against the unmigrated
  // connection fails into "nothing downloaded", which is the right answer, and a
  // late flip refetches. Gating would spin forever whenever init genuinely fails.
  const { data: downloadedScopeKeys, refetch: refetchDownloaded } = useQuery({
    queryKey: ['downloadedScopeKeys', schemaReady],
    queryFn: () => getDownloadedScopeKeys(db),
  });
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
        // Was this download still in flight? Read BEFORE the setting write, so the
        // cancel event carries how far it had got (issue #4316) — this is the
        // abandonment the funnel exists to size, caught at the moment it happens.
        const liveProgress = boardDownloadProgress({
          scopeKey: key,
          isSyncing: syncStatusRef.current.isSyncing,
          currentTable: syncStatusRef.current.progress?.currentTable ?? null,
          phase: syncStatusRef.current.progress?.phase ?? null,
          snapshot: syncStatusRef.current.progress?.snapshot,
          // With the progress kill switch off the frames still exist but carry no
          // bytes, so a Cancelled event built from them would report a fake
          // stage-and-zero. The abandonment itself is still counted — the
          // Toggled(enabled:false) above always fires — just without the detail
          // the progress feature is what supplies.
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
        return;
      }
      // How big is this download? Only the snapshot path can answer honestly, and
      // only for a scope that would actually bootstrap — a board toggled off and
      // back on keeps its rows + checkpoint and resumes as a small delta, so
      // quoting the full artifact size there would be wrong. estimateScopeDownload
      // owns those rules (shared with the engine's own eligibility check); anything
      // it can't vouch for falls back to the sizeless copy.
      //
      // Concurrent, not sequential: these are three independent reads and the
      // dialog opens behind them, so serialising them would show up as a stall on
      // slow storage.
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
      });
      const confirmed = await confirm({
        title: t('mobile.offline.enableTitle', { name: board.name }),
        message:
          estimate.kind === 'snapshot'
            ? t('mobile.offline.enableMessageWithSize', { size: formatBytes(estimate.bytes, i18n.language) })
            : t('mobile.offline.enableMessage'),
        confirmLabel: t('mobile.offline.enableConfirm'),
        cancelLabel: t('mobile.manage.cancel'),
      });
      if (!confirmed) return;
      // Enable + kick a download now via the shared hook (single-flight, reads the
      // latest syncEnabledBoards setting).
      enableBoardsOffline(board, { trigger: 'toggle', source: 'manage' });
    },
    [confirm, t, i18n.language, db, enableBoardsOffline, downloadProgressEnabled],
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
    return rows.map(
      (board): ManageItem => ({
        type: 'board',
        key: board.uuid,
        board,
        // `=== true` because a snapshot written by an older build can be missing
        // the field entirely, and the row prop is a plain boolean.
        isOwned: board.isOwned === true,
        isActive: board.uuid === activeUuid,
      }),
    );
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

  const handleEdit = useCallback(
    (board: UserBoard) => {
      router.push({ pathname: '/boards/edit', params: { boardUuid: board.uuid } });
    },
    [router],
  );

  const handleDelete = useCallback(
    async (board: UserBoard) => {
      const confirmed = await confirm({
        title: t('mobile.manage.deleteTitle'),
        message: t('mobile.manage.deleteMessage', { name: board.name }),
        confirmLabel: t('mobile.manage.deleteConfirm'),
        cancelLabel: t('mobile.manage.cancel'),
        destructive: true,
      });
      if (!confirmed) return;
      try {
        await deleteBoard.mutateAsync(board.uuid);
        // The offline picker's snapshot goes with it. The download itself stays (a
        // sibling board can share the scope), but a card for a board the backend has
        // dropped must never reach setActiveBoard.
        forgetOfflineBoard(board.uuid);
        // The deleted board can't stay the active selection — drop it so the app
        // routes to the picker instead of a board that no longer exists.
        if (activeUuid === board.uuid) await clearActiveBoard();
      } catch {
        showToast(t('mobile.manage.deleteError'), 'error');
      }
    },
    [confirm, t, deleteBoard, activeUuid, clearActiveBoard, showToast],
  );

  const handleUnfollow = useCallback(
    async (board: UserBoard) => {
      try {
        await unfollowBoard.mutateAsync(board.uuid);
        // Same as delete: the board is no longer the user's, so its offline card goes.
        forgetOfflineBoard(board.uuid);
        if (activeUuid === board.uuid) await clearActiveBoard();
      } catch {
        showToast(t('mobile.manage.unfollowError'), 'error');
      }
    },
    [unfollowBoard, activeUuid, clearActiveBoard, showToast, t],
  );

  const renderItem = useCallback(
    ({ item }: { item: ManageItem }) => {
      if (item.type === 'header') {
        return (
          <Text variant="title3" style={styles.sectionHeader}>
            {item.title}
          </Text>
        );
      }
      const isMutating =
        (deleteBoard.isPending && deleteBoard.variables === item.board.uuid) ||
        (unfollowBoard.isPending && unfollowBoard.variables === item.board.uuid);
      const scopeKey = offlineBoardKeyForBoard(item.board);
      const bootstrapMetadata = bootstrapMetadataByScope?.get(scopeKey);
      // The metadata batch and downloaded-scope query refetch together on the
      // per-scope callback. Let either committed marker win so a scheduling race
      // between those two reads cannot briefly put a completed row back in pending.
      const isDownloaded = downloadedSet.has(scopeKey) || (bootstrapMetadata?.isScopeComplete ?? false);
      // undefined (flag off) hides the row's toggle + caption entirely.
      const downloadStateInput = {
        scopeKey,
        enabled: enabledSet.has(scopeKey),
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
      return (
        <BoardManageRow
          board={item.board}
          isOwned={item.isOwned}
          isActive={item.isActive}
          // Offline every row affordance except the offline toggle is a network
          // mutation (edit, delete, unfollow), so the row goes read-only.
          readOnly={showOfflineList}
          isEditing={isEditing}
          isMutating={isMutating}
          downloadState={downloadState}
          downloadCount={downloadCount}
          isBootstrapping={isBootstrapping}
          downloadProgress={downloadProgress}
          downloadNotice={downloadNotice}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onUnfollow={handleUnfollow}
          onToggleOffline={handleToggleOffline}
        />
      );
    },
    [
      deleteBoard.isPending,
      deleteBoard.variables,
      unfollowBoard.isPending,
      unfollowBoard.variables,
      isEditing,
      showOfflineList,
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
      handleEdit,
      handleDelete,
      handleUnfollow,
      handleToggleOffline,
    ],
  );

  // Edit / Done lives in the native header. Only offered when there are boards to
  // manage; collapse edit mode if the list empties out (last board removed).
  const hasBoards = myBoards.length > 0 && !showOfflineList;
  useEffect(() => {
    if (!hasBoards && isEditing) setIsEditing(false);
  }, [hasBoards, isEditing]);
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: hasBoards
        ? () => (
            <Pressable
              onPress={() => {
                hapticSelection();
                setIsEditing((prev) => !prev);
              }}
              hitSlop={8}
              accessibilityRole="button"
            >
              <Text variant="body" color={brandColors.primary}>
                {isEditing ? t('mobile.manage.done') : t('mobile.manage.edit')}
              </Text>
            </Pressable>
          )
        : undefined,
    });
  }, [navigation, hasBoards, isEditing, t, brandColors.primary]);

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
