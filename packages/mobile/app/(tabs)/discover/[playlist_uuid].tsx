import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, Alert, Pressable } from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  usePlaylistClimbs,
  usePlaylistMutations,
  usePlaylistItemMutations,
  type PlaylistClimbsBoardInput,
} from '@boardsesh/playlists-react';
import type { Climb } from '@boardsesh/queue';
import {
  GET_PLAYLIST,
  GET_PLAYLIST_CLIMBS,
  type GetPlaylistQueryResponse,
  type GetPlaylistQueryVariables,
  type GetPlaylistClimbsInput,
  type GetPlaylistClimbsQueryResponse,
  type Playlist,
} from '@boardsesh/graphql/operations/playlists';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import { ClimbListRowSkeleton } from '../../../src/components/ClimbListRowSkeleton';
import {
  PlaylistDetailView,
  SKELETON_PLACEHOLDERS,
  PlaylistFormSheet,
  PlaylistActionsMenu,
  PlaylistFollowButton,
  PlaylistEditDoneButton,
  PlaylistOwnerToolbar,
  PlaylistBackFab,
  type PlaylistFormValues,
} from '../../../src/components/playlist';
import { GlassIconButton } from '../../../src/components/GlassIconButton';
import { getHttpClient } from '../../../src/lib/graphql/client';
import { useActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { usePlaylistActivation } from '../../../src/lib/playlists/use-playlist-activation';
import { usePlaylistRenderBoard } from '../../../src/lib/playlists/use-playlist-render-board';
import { resolvePlaylistClimbRenderBoard } from '../../../src/lib/playlists/playlist-climb-render-board';
import { recordPlaylistOpen } from '../../../src/lib/playlists/recents-store';
import { reportHandledError } from '../../../src/lib/error-reporting';
import { toQueueClimbs } from '../../../src/lib/climb-types';
import { hapticSelection } from '../../../src/lib/haptics';
import { useAuth } from '../../../src/providers/auth-provider';
import { useToast } from '../../../src/providers/toast-provider';
import { useTheme } from '../../../src/providers/theme-provider';
import { iosSystemColors } from '../../../src/theme/ios-colors';

type DetailParams = {
  playlist_uuid: string;
};

export default function PlaylistDetail() {
  const { playlist_uuid: playlistUuid } = useLocalSearchParams<DetailParams>();
  const { t } = useTranslation('playlists');
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();
  const { showToast } = useToast();
  const { systemColors, brandColors } = useTheme();
  const { updatePlaylist, deletePlaylist, pinPlaylist, unpinPlaylist, followPlaylist, unfollowPlaylist } =
    usePlaylistMutations();
  const { reorderPlaylistClimb, removeClimbFromPlaylist } = usePlaylistItemMutations();

  // Playlist metadata for the hero (name, climb count, colour, icon, ownership,
  // pin/follow state).
  const {
    data: playlist,
    isLoading: metaLoading,
    isError: metaError,
    refetch: refetchMeta,
  } = useQuery({
    queryKey: ['playlist', playlistUuid],
    queryFn: async () => {
      const response = await getHttpClient().request<GetPlaylistQueryResponse, GetPlaylistQueryVariables>(
        GET_PLAYLIST,
        {
          playlistId: playlistUuid,
        },
      );
      return response.playlist;
    },
    enabled: !!playlistUuid,
  });

  // Render the list at the user's selected wall angle: in all-boards mode the
  // resolver renders on-active-board climbs' grades at `activeAngle` instead of
  // the added-at / most-ascents fallback. `boardName` is deliberately omitted so
  // the resolver stays in all-boards mode and still lists off-board climbs
  // (dimmed) rather than filtering them out.
  const activeBoard = useActiveBoard().data ?? null;
  const playlistClimbsBoardInput = useMemo<PlaylistClimbsBoardInput | undefined>(
    () => (activeBoard ? { activeBoardName: activeBoard.boardType, activeAngle: activeBoard.angle } : undefined),
    [activeBoard],
  );
  const { query, allClimbs } = usePlaylistClimbs({
    playlistUuid,
    // Key the cache by the active board so switching board/angle refetches at
    // the new angle instead of serving stale grades.
    boardUuid: activeBoard?.uuid ?? null,
    boardInput: playlistClimbsBoardInput,
  });

  // Suggestion-refresh fetcher: pages the same playlist scoped to the active
  // board so the play-drawer swipe walks the whole playlist on that board.
  const fetchPage = useCallback(
    async ({
      page,
      pageSize,
      board,
    }: {
      page: number;
      pageSize: number;
      board: { boardName: string; layoutId: number; sizeId: number; setIds: string; angle: number };
    }) => {
      const input: GetPlaylistClimbsInput = {
        playlistId: playlistUuid,
        boardName: board.boardName,
        layoutId: board.layoutId,
        sizeId: board.sizeId,
        setIds: board.setIds,
        angle: board.angle,
        page,
        pageSize,
      };
      const response = await getHttpClient().request<GetPlaylistClimbsQueryResponse, { input: GetPlaylistClimbsInput }>(
        GET_PLAYLIST_CLIMBS,
        { input },
      );
      return {
        climbs: toQueueClimbs(response.playlistClimbs.climbs),
        hasMore: response.playlistClimbs.hasMore,
      };
    },
    [playlistUuid],
  );

  // Prefer the active board for row rendering; mixed-board climbs resolve their
  // own board per row and dim when they do not fit the active board. The banner
  // still prompts a switch for list-level board mismatches.
  const { renderBoard, banner: boardBanner } = usePlaylistRenderBoard(
    playlist ? { boardType: playlist.boardType, layoutId: playlist.layoutId } : null,
  );

  const shouldOpenViewOnly = !!boardBanner;
  const resolveViewOnlyBoard = useCallback(
    (climb: Climb) => {
      if (!shouldOpenViewOnly) return null;
      const resolvedRenderBoard = resolvePlaylistClimbRenderBoard(climb, renderBoard);
      return resolvedRenderBoard?.incompatible ? resolvedRenderBoard.renderBoard : null;
    },
    [shouldOpenViewOnly, renderBoard],
  );

  const activate = usePlaylistActivation({
    sourceId: `playlist:${playlistUuid}`,
    allClimbs,
    fetchPage,
    viewOnlyBoard: resolveViewOnlyBoard,
    refreshErrorMessage: 'Failed to refresh playlist suggestions:',
  });

  const isOwner = playlist?.userRole === 'owner';
  const isFollowable = !!playlist?.isPublic && !isOwner;

  // Interactive state seeded from the loaded playlist, updated optimistically.
  const [isPinned, setIsPinned] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followerCount, setFollowerCount] = useState(0);
  const [followLoading, setFollowLoading] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [actionsVisible, setActionsVisible] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  // Climbs edit mode (reorder + remove). `editClimbs` is a frozen snapshot of the
  // loaded list seeded on entry; the list renders from it while editing so
  // moves/removals show instantly. A ref mirrors it for the async handlers' reads
  // and revert snapshots. Pagination is paused while editing (v1 edits the loaded
  // window); on exit we invalidate so the canonical server order reloads.
  const [editMode, setEditMode] = useState(false);
  const [editClimbs, setEditClimbs] = useState<Climb[]>([]);
  const editClimbsRef = useRef<Climb[]>([]);
  const pendingEditClimbsRef = useRef(false);
  // Always-current view of the loaded climbs so enterEditMode — which runs
  // asynchronously after the actions sheet finishes dismissing — seeds from the
  // latest data, not the snapshot captured when the menu opened.
  const allClimbsRef = useRef(allClimbs);
  allClimbsRef.current = allClimbs;

  const setEditList = useCallback((list: Climb[]) => {
    editClimbsRef.current = list;
    setEditClimbs(list);
  }, []);

  const enterEditMode = useCallback(() => {
    setEditList(allClimbsRef.current);
    setEditMode(true);
  }, [setEditList]);

  const exitEditMode = useCallback(() => {
    setEditMode(false);
    setEditList([]);
    void queryClient.invalidateQueries({ queryKey: ['playlistClimbs', playlistUuid] });
    void queryClient.invalidateQueries({ queryKey: ['playlist', playlistUuid] });
  }, [setEditList, queryClient, playlistUuid]);

  const handleReorderClimb = useCallback(
    async (climbUuid: string, newIndex: number) => {
      const current = editClimbsRef.current;
      const oldIndex = current.findIndex((climb) => climb.uuid === climbUuid);
      if (oldIndex === -1) return;
      // Clamp — the screen-reader actions can ask for an index past either edge.
      const target = Math.max(0, Math.min(newIndex, current.length - 1));
      if (oldIndex === target) return;
      const next = [...current];
      const [moved] = next.splice(oldIndex, 1);
      next.splice(target, 0, moved);
      setEditList(next);
      try {
        await reorderPlaylistClimb({ playlistId: playlistUuid, climbUuid, newIndex: target });
      } catch (err) {
        console.error('Failed to reorder playlist climb:', err);
        reportHandledError(err, { tags: { source: 'playlist', op: 'reorder-climb' } });
        // Only wholesale-restore the pre-move snapshot if no other edit landed in
        // the meantime; otherwise a concurrent op's optimistic state would be
        // clobbered, so reconcile from the server instead.
        if (editClimbsRef.current === next) {
          setEditList(current);
        } else {
          void queryClient.invalidateQueries({ queryKey: ['playlistClimbs', playlistUuid] });
        }
        showToast(t('editClimbs.reorderFailed'), 'error');
      }
    },
    [reorderPlaylistClimb, playlistUuid, setEditList, queryClient, showToast, t],
  );

  const handleRemoveClimb = useCallback(
    (climbUuid: string) => {
      const target = editClimbsRef.current.find((climb) => climb.uuid === climbUuid);
      Alert.alert(
        t('editClimbs.removeConfirm.title'),
        t('editClimbs.removeConfirm.message', { name: target?.name ?? '' }),
        [
          { text: t('editClimbs.removeConfirm.cancel'), style: 'cancel' },
          {
            text: t('editClimbs.removeConfirm.confirm'),
            style: 'destructive',
            onPress: async () => {
              const current = editClimbsRef.current;
              const next = current.filter((climb) => climb.uuid !== climbUuid);
              if (next.length === current.length) return;
              setEditList(next);
              // Optimistically decrement the hero climb count.
              queryClient.setQueryData<Playlist | null>(['playlist', playlistUuid], (prev) =>
                prev ? { ...prev, climbCount: Math.max(0, prev.climbCount - 1) } : prev,
              );
              try {
                await removeClimbFromPlaylist({ playlistId: playlistUuid, climbUuid });
              } catch (err) {
                console.error('Failed to remove playlist climb:', err);
                reportHandledError(err, { tags: { source: 'playlist', op: 'remove-climb' } });
                // Restore only if no concurrent edit landed since; otherwise
                // reconcile from the server so we don't clobber it.
                if (editClimbsRef.current === next) {
                  setEditList(current);
                } else {
                  void queryClient.invalidateQueries({ queryKey: ['playlistClimbs', playlistUuid] });
                }
                // Reconcile the climb count from the server rather than adding 1
                // back — a manual +1 would overshoot if a concurrent add already
                // bumped the count.
                void queryClient.invalidateQueries({ queryKey: ['playlist', playlistUuid] });
                showToast(t('editClimbs.removeFailed'), 'error');
              }
            },
          },
        ],
      );
    },
    [removeClimbFromPlaylist, playlistUuid, setEditList, queryClient, showToast, t],
  );

  // Re-seed interactive state whenever the cached playlist changes — including
  // after a mutation writes its response back via setQueryData. Safe because the
  // GraphQL payloads (the updatePlaylist response + our optimistic setQueryData)
  // all carry accurate isPinnedByMe/isFollowedByMe/followerCount (the update
  // resolver recomputes pin/follow stats), so reseeding can't clobber an
  // optimistic flip with a stale value.
  useEffect(() => {
    if (!playlist) return;
    setIsPinned(playlist.isPinnedByMe);
    setIsFollowing(playlist.isFollowedByMe);
    setFollowerCount(playlist.followerCount);
  }, [playlist]);

  // Record the open for the "recently opened" pinned fallback. Smart playlists
  // (a separate route) are deliberately not recorded — no uuid/board to match.
  // Guard on the uuid so optimistic `setQueryData` updates (pin/follow/edit),
  // which replace the `playlist` object reference, don't re-record + spuriously
  // refresh the library's recents fallback on every tap.
  const recordedUuidRef = useRef<string | null>(null);
  useEffect(() => {
    if (!playlist || recordedUuidRef.current === playlist.uuid) return;
    recordedUuidRef.current = playlist.uuid;
    void recordPlaylistOpen({
      uuid: playlist.uuid,
      boardType: playlist.boardType,
      layoutId: playlist.layoutId ?? null,
    });
  }, [playlist]);

  const handleTogglePin = useCallback(async () => {
    if (!playlist) return;
    const next = !isPinned;
    setIsPinned(next);
    // Update the cache before the await so the reseed effect mirrors the
    // optimistic value (not a stale one) if it fires mid-request.
    queryClient.setQueryData<Playlist | null>(['playlist', playlistUuid], (prev) =>
      prev ? { ...prev, isPinnedByMe: next } : prev,
    );
    try {
      if (next) await pinPlaylist(playlist.uuid);
      else await unpinPlaylist(playlist.uuid);
    } catch (err) {
      console.error('Failed to toggle pin:', err);
      reportHandledError(err, { tags: { source: 'playlist', op: 'toggle-pin' } });
      setIsPinned(!next);
      queryClient.setQueryData<Playlist | null>(['playlist', playlistUuid], (prev) =>
        prev ? { ...prev, isPinnedByMe: !next } : prev,
      );
      showToast(t(next ? 'library.pin.pinFailed' : 'library.pin.unpinFailed'), 'error');
    }
  }, [playlist, isPinned, pinPlaylist, unpinPlaylist, queryClient, playlistUuid, showToast, t]);

  const handleToggleFollow = useCallback(async () => {
    if (!playlist) return;
    const next = !isFollowing;
    const delta = next ? 1 : -1;
    setIsFollowing(next);
    setFollowerCount((count) => count + delta);
    // Update the cache before the await so a reseed mid-request mirrors the
    // optimistic count, and the error path can't double-revert from a stale one.
    queryClient.setQueryData<Playlist | null>(['playlist', playlistUuid], (prev) =>
      prev ? { ...prev, isFollowedByMe: next, followerCount: prev.followerCount + delta } : prev,
    );
    setFollowLoading(true);
    try {
      if (next) await followPlaylist(playlist.uuid);
      else await unfollowPlaylist(playlist.uuid);
    } catch (err) {
      console.error('Failed to toggle follow:', err);
      reportHandledError(err, { tags: { source: 'playlist', op: 'toggle-follow' } });
      setIsFollowing(!next);
      setFollowerCount((count) => count - delta);
      queryClient.setQueryData<Playlist | null>(['playlist', playlistUuid], (prev) =>
        prev ? { ...prev, isFollowedByMe: !next, followerCount: prev.followerCount - delta } : prev,
      );
      showToast(t('detail.followFailed'), 'error');
    } finally {
      setFollowLoading(false);
    }
  }, [playlist, isFollowing, followPlaylist, unfollowPlaylist, queryClient, playlistUuid, showToast, t]);

  const handleEditSubmit = useCallback(
    async (values: PlaylistFormValues) => {
      if (!playlist) return;
      setSavingEdit(true);
      try {
        const updated = await updatePlaylist({
          playlistId: playlist.uuid,
          name: values.name,
          // The form emits '' for cleared description/colour/icon in edit mode,
          // so the removals persist; pass them straight through.
          description: values.description,
          color: values.color,
          icon: values.icon,
          isPublic: values.isPublic,
        });
        queryClient.setQueryData(['playlist', playlistUuid], updated);
        // Also patch the Add-to-Playlist picker's react-query list (the shelves
        // refetch on focus, but this cache wouldn't until its staleTime lapses).
        queryClient.setQueryData<Playlist[]>(['userPlaylists'], (prev) =>
          prev?.map((entry) => (entry.uuid === updated.uuid || entry.id === updated.id ? updated : entry)),
        );
        setEditVisible(false);
        showToast(t('edit.messages.updated'), 'success');
      } catch (err) {
        console.error('Failed to update playlist:', err);
        reportHandledError(err, { tags: { source: 'playlist', op: 'update' } });
        showToast(t('edit.messages.updateFailed'), 'error');
      } finally {
        setSavingEdit(false);
      }
    },
    [playlist, updatePlaylist, queryClient, playlistUuid, showToast, t],
  );

  const handleDelete = useCallback(() => {
    if (!playlist) return;
    Alert.alert(t('detail.deleteConfirm.title'), t('detail.deleteConfirm.message', { name: playlist.name }), [
      { text: t('detail.deleteConfirm.cancel'), style: 'cancel' },
      {
        text: t('detail.deleteConfirm.confirm'),
        style: 'destructive',
        onPress: async () => {
          try {
            await deletePlaylist(playlist.uuid);
            queryClient.removeQueries({ queryKey: ['playlist', playlistUuid] });
            showToast(t('detail.deleted'), 'success');
            navigation.goBack();
          } catch (err) {
            console.error('Failed to delete playlist:', err);
            reportHandledError(err, { tags: { source: 'playlist', op: 'delete' } });
            showToast(t('detail.deleteFailed'), 'error');
          }
        },
      },
    ]);
  }, [playlist, deletePlaylist, queryClient, playlistUuid, showToast, t, navigation]);

  // Cog (shown in edit mode) → open the edit-details sheet directly. No menu is
  // involved, so no sheet-handoff dance is needed.
  const openEditDetails = useCallback(() => setEditVisible(true), []);

  // Collapsed overflow menu (owner): Pin toggles in place; Delete confirms; Edit
  // enters the climbs edit mode once the menu sheet has dismissed (deferred via
  // the pending ref so the sheet's exit animation doesn't fight the top-bar swap).
  const menuTogglePin = useCallback(() => {
    setActionsVisible(false);
    void handleTogglePin();
  }, [handleTogglePin]);

  const menuEnterEdit = useCallback(() => {
    pendingEditClimbsRef.current = true;
    setActionsVisible(false);
  }, []);

  const openDelete = useCallback(() => {
    setActionsVisible(false);
    handleDelete();
  }, [handleDelete]);

  const handleActionsClose = useCallback(() => {
    setActionsVisible(false);
    if (pendingEditClimbsRef.current) {
      pendingEditClimbsRef.current = false;
      enterEditMode();
    }
  }, [enterEditMode]);

  // Floating controls over the hero. Owners get a pin · edit · delete glass
  // toolbar that collapses to a single overflow ⋯ on scroll (and always on
  // Material, which asks for the collapsed form). Non-owners keep follow + pin.
  // Edit mode replaces everything with Done.
  const renderActions = useCallback(
    (collapsed: boolean) => {
      if (!playlist) return null;
      if (editMode) {
        return <PlaylistEditDoneButton onPress={exitEditMode} collapsed={collapsed} />;
      }
      if (isOwner) {
        if (collapsed) {
          return (
            <GlassIconButton
              iconName="more"
              iconColor={systemColors.label}
              onPress={() => setActionsVisible(true)}
              accessibilityLabel={t('detail.actions')}
              fallbackColor={systemColors.fill}
            />
          );
        }
        return (
          <PlaylistOwnerToolbar
            isPinned={isPinned}
            onTogglePin={handleTogglePin}
            onEdit={enterEditMode}
            onDelete={handleDelete}
          />
        );
      }
      return (
        <>
          {isAuthenticated && isFollowable ? (
            <PlaylistFollowButton
              isFollowing={isFollowing}
              onToggle={handleToggleFollow}
              loading={followLoading}
              collapsed={collapsed}
            />
          ) : null}
          {isAuthenticated ? (
            <GlassIconButton
              iconName={isPinned ? 'pin.fill' : 'pin'}
              iconColor={systemColors.label}
              onPress={() => {
                hapticSelection();
                void handleTogglePin();
              }}
              accessibilityLabel={isPinned ? t('library.pin.unpinAriaLabel') : t('library.pin.pinAriaLabel')}
              fallbackColor={systemColors.fill}
            />
          ) : null}
        </>
      );
    },
    [
      playlist,
      editMode,
      exitEditMode,
      isOwner,
      isPinned,
      handleTogglePin,
      enterEditMode,
      handleDelete,
      isAuthenticated,
      isFollowable,
      isFollowing,
      handleToggleFollow,
      followLoading,
      systemColors,
      brandColors,
      t,
    ],
  );

  const hero = useMemo(
    () => ({
      name: playlist?.name ?? t('metadata.detail.fallbackTitle'),
      climbCount: playlist?.climbCount ?? allClimbs.length,
      color: playlist?.color,
      icon: playlist?.icon,
      description: playlist?.description,
      boardType: playlist?.boardType,
      layoutId: playlist?.layoutId,
      showBoardBackdrop: !!playlist?.boardType,
      followerLabel: playlist?.isPublic ? t('detail.followerCount', { count: followerCount }) : undefined,
    }),
    [playlist, allClimbs.length, followerCount, t],
  );

  // Metadata fetch threw (network/server error): react-query leaves `playlist`
  // undefined (never null), so the not-found guard below would be skipped and
  // a blank fallback-titled hero would render as if it were a real empty
  // playlist. Surface an explicit error + retry instead. Distinct from the
  // resolved-null not-found case.
  if (metaError && !playlist) {
    return (
      <View style={styles.stateContainer}>
        <PlaylistBackFab />
        <Icon name="error" size={48} color={iosSystemColors.systemGray4} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('detail.errors.loadTitle')}
        </Text>
        <Text variant="subheadline" style={styles.stateSubtitle}>
          {t('detail.errors.loadDescription')}
        </Text>
        <Pressable
          onPress={() => {
            void refetchMeta();
            void query.refetch();
          }}
          accessibilityRole="button"
          accessibilityLabel={t('detail.errors.tryAgain')}
          hitSlop={8}
        >
          <Text variant="subheadline" color={brandColors.primary} style={styles.stateRetry}>
            {t('detail.errors.tryAgain')}
          </Text>
        </Pressable>
      </View>
    );
  }

  // Playlist not found (resolved, null) — distinct from still-loading.
  if (!metaLoading && playlist === null) {
    return (
      <View style={styles.stateContainer}>
        <PlaylistBackFab />
        <Icon name="error" size={48} color={iosSystemColors.systemGray4} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('detail.errors.notFoundTitle')}
        </Text>
        <Text variant="subheadline" style={styles.stateSubtitle}>
          {t('detail.errors.notFoundDescription')}
        </Text>
      </View>
    );
  }

  if (metaLoading && allClimbs.length === 0) {
    return (
      <View style={styles.skeletonContainer}>
        <PlaylistBackFab />
        <View style={styles.skeletonList}>
          {SKELETON_PLACEHOLDERS.map((key) => (
            <ClimbListRowSkeleton key={key} />
          ))}
        </View>
      </View>
    );
  }

  return (
    <>
      <PlaylistDetailView
        hero={hero}
        climbs={editMode ? editClimbs : allClimbs}
        renderBoard={renderBoard}
        boardBanner={boardBanner}
        isLoading={query.isLoading}
        // Pagination is paused while editing the loaded window.
        isFetchingNextPage={editMode ? false : query.isFetchingNextPage}
        hasNextPage={editMode ? false : (query.hasNextPage ?? false)}
        fetchNextPage={query.fetchNextPage}
        onActivateClimb={activate}
        emptyMessage={t('detail.empty')}
        actions={renderActions}
        editMode={editMode}
        onReorderClimb={handleReorderClimb}
        onRemoveClimb={handleRemoveClimb}
        onEditDetails={openEditDetails}
      />

      <PlaylistActionsMenu
        visible={actionsVisible}
        isPinned={isPinned}
        onTogglePin={menuTogglePin}
        onEdit={menuEnterEdit}
        onDelete={openDelete}
        onClose={handleActionsClose}
      />

      <PlaylistFormSheet
        mode="edit"
        visible={editVisible}
        submitting={savingEdit}
        playlist={playlist ?? null}
        onSubmit={handleEditSubmit}
        onClose={() => setEditVisible(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  stateContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 8,
  },
  skeletonContainer: {
    flex: 1,
  },
  skeletonList: {
    paddingTop: 64,
  },
  stateTitle: {
    marginTop: 12,
    opacity: 0.6,
  },
  stateSubtitle: {
    opacity: 0.4,
    textAlign: 'center',
  },
  stateRetry: {
    marginTop: 12,
    fontWeight: '600',
  },
});
