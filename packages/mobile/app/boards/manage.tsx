import { useCallback, useEffect, useMemo } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSQLiteContext } from 'expo-sqlite';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useMyBoards, useProfile, useDeleteBoard, useUnfollowBoard } from '../../src/lib/graphql/hooks';
import { useActiveBoard, useClearActiveBoard } from '../../src/lib/graphql/use-active-board';
import { useAuth } from '../../src/providers/auth-provider';
import { useToast } from '../../src/providers/toast-provider';
import { useConfirm } from '../../src/providers/dialog-provider';
import { useTheme } from '../../src/providers/theme-provider';
import { useBottomChromeMetrics } from '../../src/hooks/use-bottom-chrome-metrics';
import { useSyncStatus, triggerSync, setSyncProgress, getDownloadedScopeKeys } from '../../src/sync';
import { drainMutationQueue } from '../../src/mutation-queue';
import type { GraphQLFetch } from '../../src/mutation-queue/handlers';
import {
  getSetting,
  useSetting,
  setOfflineBoardEnabled,
  offlineBoardKeyForBoard,
  offlineBoardScopeForBoard,
} from '../../src/settings';
import { getHttpClient } from '../../src/lib/graphql/client';
import { Text } from '../../src/components/Text';
import { Icon } from '../../src/components/Icon';
import { Button } from '../../src/components/Button';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { BoardManageRow } from '../../src/components/board-discovery/BoardManageRow';
import { boardDownloadState } from '../../src/components/board-discovery/board-offline-state';
import { buildManageItems, type ManageItem } from '../../src/components/board-discovery/manage-items';
import { iosSystemColors } from '../../src/theme/ios-colors';
import { spacing } from '../../src/theme/tokens';

const EMPTY_BOARDS: UserBoard[] = [];

const keyExtractor = (item: ManageItem) => item.key;
const getItemType = (item: ManageItem) => item.type;

export default function ManageBoards() {
  const router = useRouter();
  const { t } = useTranslation('boards');
  const { isAuthenticated, refreshAuthState } = useAuth();
  const { systemColors, brandColors } = useTheme();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const bottomChrome = useBottomChromeMetrics();
  const paddingBottom = bottomChrome.scrollBottomPadding + spacing[4];

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
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const syncStatus = useSyncStatus();
  const [enabledBoards] = useSetting('syncEnabledBoards');
  const enabledSet = useMemo(() => new Set(enabledBoards), [enabledBoards]);
  const isSyncing = syncStatus.isSyncing;
  const currentTable = syncStatus.progress?.currentTable ?? null;
  const currentTableProcessed = syncStatus.progress?.currentTableProcessed;

  // Per-scope "downloaded" signal: which scopes actually have a board_climbs
  // checkpoint. Refetched whenever a cycle finishes (isSyncing → false), so a
  // board flips to "Available offline" only once its own data has landed.
  const { data: downloadedScopeKeys, refetch: refetchDownloaded } = useQuery({
    queryKey: ['downloadedScopeKeys'],
    queryFn: () => getDownloadedScopeKeys(db),
  });
  const downloadedSet = useMemo(() => new Set(downloadedScopeKeys ?? []), [downloadedScopeKeys]);
  useEffect(() => {
    if (!isSyncing) void refetchDownloaded();
  }, [isSyncing, refetchDownloaded]);

  const graphqlFetch = useMemo<GraphQLFetch>(() => (query, variables) => getHttpClient().request(query, variables), []);
  const drainQueue = useCallback(
    () => drainMutationQueue(db, queryClient, graphqlFetch),
    [db, queryClient, graphqlFetch],
  );

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
      const confirmed = await confirm({
        title: t('mobile.offline.enableTitle', { name: board.name }),
        message: t('mobile.offline.enableMessage'),
        confirmLabel: t('mobile.offline.enableConfirm'),
        cancelLabel: t('mobile.manage.cancel'),
      });
      if (!confirmed) return;
      setOfflineBoardEnabled(scope, true);
      // Kick a sync now so the download starts immediately rather than waiting for
      // the next foreground/reconnect trigger. triggerSync → runSync is single-flight
      // (one in-flight run + at most one queued follow-up), so enabling several boards
      // in quick succession collapses into one cycle that reads the latest setting.
      triggerSync(db, queryClient, graphqlFetch, () => getSetting('syncEnabledBoards'), drainQueue, setSyncProgress);
    },
    [confirm, t, db, queryClient, graphqlFetch, drainQueue],
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
      const downloadState = boardDownloadState({
        scopeKey,
        enabled: enabledSet.has(scopeKey),
        isSyncing,
        downloaded: downloadedSet.has(scopeKey),
        currentTable,
      });
      // Only the board actually downloading gets the live count; every other row
      // gets undefined (a stable prop), so its memo skips the per-frame churn.
      const downloadCount = downloadState === 'downloading' ? currentTableProcessed : undefined;
      return (
        <BoardManageRow
          board={item.board}
          isOwned={item.isOwned}
          isActive={item.isActive}
          isMutating={isMutating}
          downloadState={downloadState}
          downloadCount={downloadCount}
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
      enabledSet,
      isSyncing,
      downloadedSet,
      currentTable,
      currentTableProcessed,
      handleEdit,
      handleDelete,
      handleUnfollow,
      handleToggleOffline,
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
