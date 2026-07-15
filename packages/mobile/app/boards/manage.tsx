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
import { useOfflineDownloadsEnabled } from '../../src/providers/feature-flags-provider';
import { useBottomChromeMetrics } from '../../src/hooks/use-bottom-chrome-metrics';
import { useSyncStatus } from '../../src/sync';
import {
  getDownloadedScopeKeys,
  getCheckpoint,
  getCheckpointKey,
  getBootstrapAttempts,
  estimateScopeDownload,
} from '@boardsesh/offline-sync';
import { useBoardDownloads } from '../../src/offline/use-board-downloads';
import { useSnapshotManifest } from '../../src/offline/use-snapshot-manifest';
import { formatBytes } from '../../src/lib/format-bytes';
import {
  getSetting,
  useSetting,
  setOfflineBoardEnabled,
  offlineBoardKeyForBoard,
  offlineBoardScopeForBoard,
} from '../../src/settings';
import { hapticSelection } from '../../src/lib/haptics';
import { Text } from '../../src/components/Text';
import { Icon } from '../../src/components/Icon';
import { Button } from '../../src/components/Button';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { BoardManageRow } from '../../src/components/board-discovery/BoardManageRow';
import { boardDownloadState, boardIsBootstrapping } from '../../src/components/board-discovery/board-offline-state';
import { buildManageItems, type ManageItem } from '../../src/components/board-discovery/manage-items';
import { iosSystemColors } from '../../src/theme/ios-colors';
import { spacing } from '../../src/theme/tokens';

const EMPTY_BOARDS: UserBoard[] = [];

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
  const currentUserId = profile?.id;
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
  const syncStatus = useSyncStatus();
  const [enabledBoards] = useSetting('syncEnabledBoards');
  const enabledSet = useMemo(() => new Set(enabledBoards), [enabledBoards]);
  const isSyncing = syncStatus.isSyncing;
  const currentTable = syncStatus.progress?.currentTable ?? null;
  const currentTableProcessed = syncStatus.progress?.currentTableProcessed;
  const currentPhase = syncStatus.progress?.phase ?? null;

  // Per-scope "downloaded" signal: which scopes actually have a board_climbs
  // checkpoint. Refetched whenever a cycle finishes (isSyncing → false), so a
  // board flips to "Available offline" only once its own data has landed.
  const { data: downloadedScopeKeys, refetch: refetchDownloaded } = useQuery({
    queryKey: ['downloadedScopeKeys'],
    queryFn: () => getDownloadedScopeKeys(db),
    enabled: offlineDownloadsEnabled,
  });
  const downloadedSet = useMemo(() => new Set(downloadedScopeKeys ?? []), [downloadedScopeKeys]);
  useEffect(() => {
    if (offlineDownloadsEnabled && !isSyncing) void refetchDownloaded();
  }, [offlineDownloadsEnabled, isSyncing, refetchDownloaded]);

  const handleToggleOffline = useCallback(
    async (board: UserBoard) => {
      const scope = offlineBoardScopeForBoard(board);
      const key = offlineBoardKeyForBoard(board);
      const alreadyEnabled = getSetting('syncEnabledBoards').includes(key);
      if (alreadyEnabled) {
        // Disabling just drops the setting entry; the cached rows + checkpoint stay
        // so re-enabling resumes instantly, so no confirm is needed.
        setOfflineBoardEnabled(scope, false);
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
      const [climbsCheckpoint, statsCheckpoint, bootstrapAttempts] = await Promise.all([
        getCheckpoint(db, getCheckpointKey('board_climbs', key)),
        getCheckpoint(db, getCheckpointKey('board_climb_stats', key)),
        getBootstrapAttempts(db, key),
      ]);
      const estimate = estimateScopeDownload({
        manifest: snapshotManifestRef.current,
        boardType: scope.boardType,
        layoutId: scope.layoutId,
        hasExistingCheckpoint: !!climbsCheckpoint || !!statsCheckpoint,
        bootstrapAttempts,
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
      enableBoardsOffline(board);
    },
    [confirm, t, i18n.language, db, enableBoardsOffline],
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
      // undefined (flag off) hides the row's toggle + caption entirely.
      const downloadStateInput = {
        scopeKey,
        enabled: enabledSet.has(scopeKey),
        isSyncing,
        downloaded: downloadedSet.has(scopeKey),
        currentTable,
        phase: currentPhase,
      };
      const downloadState = offlineDownloadsEnabled ? boardDownloadState(downloadStateInput) : undefined;
      // Only the board actually downloading gets the live count / bootstrap
      // flag; every other row gets undefined/false (stable props), so its
      // memo skips the per-frame churn.
      const downloadCount = downloadState === 'downloading' ? currentTableProcessed : undefined;
      const isBootstrapping = downloadState === 'downloading' && boardIsBootstrapping(downloadStateInput);
      return (
        <BoardManageRow
          board={item.board}
          isOwned={item.isOwned}
          isActive={item.isActive}
          isEditing={isEditing}
          isMutating={isMutating}
          downloadState={downloadState}
          downloadCount={downloadCount}
          isBootstrapping={isBootstrapping}
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
      offlineDownloadsEnabled,
      enabledSet,
      isSyncing,
      downloadedSet,
      currentTable,
      currentTableProcessed,
      currentPhase,
      handleEdit,
      handleDelete,
      handleUnfollow,
      handleToggleOffline,
    ],
  );

  // Edit / Done lives in the native header. Only offered when there are boards to
  // manage; collapse edit mode if the list empties out (last board removed).
  const hasBoards = myBoards.length > 0;
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

  // Wait for the profile too: owned-vs-followed is keyed on currentUserId, so
  // rendering before it resolves would file the user's own boards under
  // "Following" (myBoards can win the race on a cold open / deep link).
  if ((isLoading && myBoards.length === 0) || (isProfileLoading && !currentUserId)) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  // Boards failed with nothing cached, OR the profile settled without an id —
  // without currentUserId we can't classify owned vs followed, so never render
  // the list; offer a retry that refetches both.
  if ((isError && myBoards.length === 0) || !currentUserId) {
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
        data={items}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        getItemType={getItemType}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom }}
        ListHeaderComponent={
          items.length > 0 ? (
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
