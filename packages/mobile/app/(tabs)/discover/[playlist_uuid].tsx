import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, Alert } from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { usePlaylistClimbs, usePlaylistMutations } from '@boardsesh/playlists-react';
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
  PlaylistFormSheet,
  PlaylistActionsMenu,
  PlaylistFollowButton,
  PlaylistBackFab,
  SKELETON_PLACEHOLDERS,
  type PlaylistFormValues,
  type PlaylistMaterialActions,
} from '../../../src/components/playlist';
import { GlassIconButton } from '../../../src/components/GlassIconButton';
import { getHttpClient } from '../../../src/lib/graphql/client';
import { usePlaylistActivation } from '../../../src/lib/playlists/use-playlist-activation';
import { recordPlaylistOpen } from '../../../src/lib/playlists/recents-store';
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
  const { t: tCommon } = useTranslation('common');
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();
  const { showToast } = useToast();
  const { systemColors, brandColors } = useTheme();
  const { updatePlaylist, deletePlaylist, pinPlaylist, unpinPlaylist, followPlaylist, unfollowPlaylist } =
    usePlaylistMutations();

  // Playlist metadata for the hero (name, climb count, colour, icon, ownership,
  // pin/follow state).
  const { data: playlist, isLoading: metaLoading } = useQuery({
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

  const { query, allClimbs } = usePlaylistClimbs({ playlistUuid });

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

  const activate = usePlaylistActivation({
    sourceId: `playlist:${playlistUuid}`,
    allClimbs,
    fetchPage,
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
        setEditVisible(false);
        showToast(t('edit.messages.updated'), 'success');
      } catch (err) {
        console.error('Failed to update playlist:', err);
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
            showToast(t('detail.deleteFailed'), 'error');
          }
        },
      },
    ]);
  }, [playlist, deletePlaylist, queryClient, playlistUuid, showToast, t, navigation]);

  // Hand the menu → edit sheet off sequentially: close the menu first, then
  // open the edit sheet from the menu's onClose. Opening both in one tick would
  // animate two gorhom sheets (and their backdrops) at once.
  const pendingEditRef = useRef(false);
  const openEdit = useCallback(() => {
    pendingEditRef.current = true;
    setActionsVisible(false);
  }, []);

  const openDelete = useCallback(() => {
    setActionsVisible(false);
    handleDelete();
  }, [handleDelete]);

  const handleActionsClose = useCallback(() => {
    setActionsVisible(false);
    if (pendingEditRef.current) {
      pendingEditRef.current = false;
      setEditVisible(true);
    }
  }, []);

  // Floating action FABs over the hero (the native header bar is gone): follow
  // (public non-owner) + pin (auth) + owner more-menu. Rendered with the current
  // collapse state so the follow control swaps to an icon FAB in header mode.
  const renderActions = useCallback(
    (collapsed: boolean) =>
      playlist ? (
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
              iconColor={isPinned ? brandColors.primary : systemColors.label}
              onPress={() => {
                hapticSelection();
                handleTogglePin();
              }}
              accessibilityLabel={isPinned ? t('library.pin.unpinAriaLabel') : t('library.pin.pinAriaLabel')}
              fallbackColor={systemColors.fill}
            />
          ) : null}
          {isOwner ? (
            <GlassIconButton
              iconName="more"
              iconColor={systemColors.label}
              onPress={() => setActionsVisible(true)}
              accessibilityLabel={t('detail.actions')}
              fallbackColor={systemColors.fill}
            />
          ) : null}
        </>
      ) : null,
    [
      playlist,
      isAuthenticated,
      isFollowable,
      isFollowing,
      handleToggleFollow,
      followLoading,
      isPinned,
      handleTogglePin,
      isOwner,
      systemColors,
      brandColors,
      t,
    ],
  );

  // Material-branch equivalent of `renderActions`: the same follow / pin / more
  // capabilities, as structured descriptors the Paper header renders as
  // `Appbar.Action`s + an overflow `Menu`. Owners keep edit/delete here too —
  // the regression this fixes was Material owners losing those controls.
  const materialActions = useMemo<PlaylistMaterialActions | undefined>(() => {
    if (!playlist) return undefined;
    const inline: NonNullable<PlaylistMaterialActions['inline']> = [];
    if (isAuthenticated && isFollowable) {
      inline.push({
        key: 'follow',
        icon: isFollowing ? 'check.small' : 'person.badge.plus',
        accessibilityLabel: isFollowing ? tCommon('follow.following') : tCommon('follow.follow'),
        onPress: handleToggleFollow,
        disabled: followLoading,
        tint: isFollowing ? brandColors.primary : undefined,
      });
    }
    if (isAuthenticated) {
      inline.push({
        key: 'pin',
        icon: isPinned ? 'pin.fill' : 'pin',
        accessibilityLabel: isPinned ? t('library.pin.unpinAriaLabel') : t('library.pin.pinAriaLabel'),
        onPress: () => {
          hapticSelection();
          handleTogglePin();
        },
        tint: isPinned ? brandColors.primary : undefined,
      });
    }
    // Wire edit straight to the form sheet (not `openEdit`, which sequences the
    // glass actions bottom sheet's dismiss → open handoff that Material doesn't
    // use). The Paper `Menu` closes itself before invoking onPress, so there's no
    // double-sheet animation to coordinate.
    const menu: NonNullable<PlaylistMaterialActions['menu']> = isOwner
      ? [
          { key: 'edit', title: t('detail.menu.edit'), icon: 'edit', onPress: () => setEditVisible(true) },
          { key: 'delete', title: t('detail.menu.delete'), icon: 'delete', onPress: handleDelete, destructive: true },
        ]
      : [];
    if (inline.length === 0 && menu.length === 0) return undefined;
    return { inline, menu };
  }, [
    playlist,
    isAuthenticated,
    isFollowable,
    isFollowing,
    handleToggleFollow,
    followLoading,
    isPinned,
    handleTogglePin,
    isOwner,
    handleDelete,
    brandColors,
    t,
    tCommon,
  ]);

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
        climbs={allClimbs}
        isLoading={query.isLoading}
        isFetchingNextPage={query.isFetchingNextPage}
        hasNextPage={query.hasNextPage ?? false}
        fetchNextPage={query.fetchNextPage}
        onActivateClimb={activate}
        emptyMessage={t('detail.empty')}
        actions={renderActions}
        materialActions={materialActions}
      />

      <PlaylistActionsMenu
        visible={actionsVisible}
        onEdit={openEdit}
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
});
