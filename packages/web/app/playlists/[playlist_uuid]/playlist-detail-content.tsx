'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import MuiButton from '@mui/material/Button';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import {
  PublicOutlined,
  LockOutlined,
  SentimentDissatisfiedOutlined,
  MoreVertOutlined,
  ElectricBoltOutlined,
  EditOutlined,
  DeleteOutlined,
  PeopleOutlined,
  IosShare,
  PushPin,
  PushPinOutlined,
} from '@mui/icons-material';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@/app/lib/types';
import { executeGraphQL, createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  type GetPlaylistQueryResponse,
  type GetPlaylistQueryVariables,
  type GetPlaylistClimbsQueryResponse,
  type Playlist,
  type UpdatePlaylistLastAccessedMutationVariables,
  type UpdatePlaylistLastAccessedMutationResponse,
  type DeletePlaylistMutationVariables,
  type DeletePlaylistMutationResponse,
  type AddClimbToPlaylistMutationResponse,
  type AddClimbToPlaylistMutationVariables,
  GET_PLAYLIST,
  GET_PLAYLIST_CLIMBS,
  DELETE_PLAYLIST,
  UPDATE_PLAYLIST_LAST_ACCESSED,
  ADD_CLIMB_TO_PLAYLIST,
  FOLLOW_PLAYLIST,
  UNFOLLOW_PLAYLIST,
  PIN_PLAYLIST,
  UNPIN_PLAYLIST,
  type PinPlaylistMutationResponse,
  type PinPlaylistMutationVariables,
  type UnpinPlaylistMutationResponse,
  type UnpinPlaylistMutationVariables,
  type GetPlaylistClimbsQueryVariables,
  type GetPlaylistClimbsInput,
  type PlaylistClimbsResult,
} from '@/app/lib/graphql/operations/playlists';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { shareWithFallback } from '@/app/lib/share-utils';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { EmptyState } from '@/app/components/ui/empty-state';
import FollowButton from '@/app/components/ui/follow-button';
import PlaylistPreviewSquare from '@/app/components/library/playlist-preview-square';
import { recordPlaylistOpen } from '@/app/lib/recent-playlists-db';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { getBoardDetailsForPlaylist, getDefaultAngleForBoard } from '@/app/lib/board-config-for-playlist';
import { themeTokens } from '@/app/theme/theme-config';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import BackButton from '@/app/components/back-button';
import { WorkoutGeneratorDrawer, type GeneratorTarget } from '@/app/components/workout-generator';
import PlaylistEditDrawer from '@/app/components/library/playlist-edit-drawer';
import CommentSection from '@/app/components/social/comment-section';
import MultiboardClimbList from '@/app/components/climb-list/multiboard-climb-list';
import { useMyBoards } from '@/app/hooks/use-my-boards';
import { findMatchingBoard, type BoardConfig } from '@/app/lib/find-matching-board';
import { ssrSeedMatchesQueryKey } from '@/app/lib/graphql/ssr-query-seed';
import type { UserBoard } from '@boardsesh/shared-schema';
import styles from '@/app/components/library/playlist-view.module.css';

// Validate hex color format
const isValidHexColor = (color: string): boolean => {
  return /^#([0-9A-Fa-f]{3}){1,2}$/.test(color);
};

const PLAYLIST_COLORS = [
  themeTokens.colors.primary,
  themeTokens.colors.accentGreen,
  themeTokens.colors.purple,
  themeTokens.colors.warning,
  themeTokens.colors.pink,
  themeTokens.colors.success,
  themeTokens.colors.accentRose,
  themeTokens.colors.amber,
];

type PlaylistDetailContentProps = {
  playlistUuid: string;
  /** Base path for navigating back to the playlists library (e.g. "/b/my-kilter/40/playlists"). Defaults to "/playlists". */
  playlistsBasePath?: string;
  /** When set from a board slug route, auto-selects the matching board filter. */
  boardSlug?: string;
  /** When set from a legacy route, auto-selects the matching board filter by config. */
  boardConfig?: BoardConfig;
  /** SSR-fetched user boards for instant board filter selection (avoids flash). */
  initialMyBoards?: UserBoard[] | null;
  /** SSR-fetched playlist to avoid first-load spinner. */
  initialPlaylist?: Playlist | null;
  /** SSR-fetched first page of climbs to avoid first-load spinner. */
  initialClimbs?: PlaylistClimbsResult | null;
};

export default function PlaylistDetailContent({
  playlistUuid,
  playlistsBasePath = '/playlists',
  boardSlug,
  boardConfig,
  initialMyBoards,
  initialPlaylist,
  initialClimbs,
}: PlaylistDetailContentProps) {
  const router = useLocaleRouter();
  const { showMessage } = useSnackbar();
  const { t } = useTranslation('playlists');
  const [playlist, setPlaylist] = useState<Playlist | null>(initialPlaylist ?? null);
  const [loading, setLoading] = useState(!initialPlaylist);
  const [error, setError] = useState<string | null>(null);
  const [editDrawerOpen, setEditDrawerOpen] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [listRefreshKey, setListRefreshKey] = useState(0);
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  // Initialize selectedBoard from SSR data immediately (avoids flash from "All" to selected board)
  const [selectedBoard, setSelectedBoard] = useState<UserBoard | null>(() =>
    findMatchingBoard(initialMyBoards, boardSlug, boardConfig),
  );
  const lastAccessedUpdatedRef = useRef(false);
  const defaultBoardAppliedRef = useRef(!!selectedBoard);
  // Tracks whether we have any playlist data (SSR or fetched). Read inside
  // fetchPlaylist's loading guard to avoid feeding reactive state back into
  // its dependency list — putting `playlist` in deps creates an infinite
  // setState → callback-recreate → effect-rerun loop.
  const hasPlaylistDataRef = useRef(!!initialPlaylist);
  // Treat SSR-seeded react-query data as fresh under staleTime; without this,
  // initialDataUpdatedAt defaults to 0 and triggers an immediate refetch.
  const ssrInitialClimbsUpdatedAtRef = useRef(initialClimbs ? Date.now() : 0);
  // Snapshot the query-key components that the SSR climbs payload was fetched
  // for. `initialData` is shared across keys, so without this gate a board
  // chip switch or a post-edit `listRefreshKey` bump would re-seed the new
  // key with the original SSR page and (because `initialDataUpdatedAt` puts
  // it inside `staleTime`) skip the fetch entirely.
  const ssrClimbsKeyRef = useRef({
    boardUuid: selectedBoard?.uuid ?? null,
    refreshKey: 0,
  });
  const { token, isLoading: tokenLoading } = useWsAuthToken();

  // Fetch user's boards (with SSR initial data to avoid loading skeleton).
  // These boards are forwarded to MultiboardClimbList via the `boards` prop so
  // we avoid duplicate GraphQL requests from MultiboardClimbList's internal hook.
  const { boards: myBoards, isLoading: boardsLoading } = useMyBoards(true, 50, initialMyBoards);

  // Auto-select the matching board once boards finish loading, but only when the
  // route explicitly provides a board context. Without a route-provided board,
  // default to "All Boards" so multi-board playlists show all their climbs.
  // Incompatible climbs are blocked at add-time by useQueueAddValidator.
  useEffect(() => {
    if (defaultBoardAppliedRef.current || boardsLoading || myBoards.length === 0) return;
    if (!(boardSlug || boardConfig)) {
      defaultBoardAppliedRef.current = true;
      return;
    }
    const match = findMatchingBoard(myBoards, boardSlug, boardConfig);
    if (match) {
      setSelectedBoard(match);
    }
    defaultBoardAppliedRef.current = true;
  }, [myBoards, boardsLoading, boardSlug, boardConfig]);

  const fetchPlaylist = useCallback(async () => {
    if (tokenLoading) return;

    try {
      if (!hasPlaylistDataRef.current) setLoading(true);
      setError(null);

      const response = await executeGraphQL<GetPlaylistQueryResponse, GetPlaylistQueryVariables>(
        GET_PLAYLIST,
        { playlistId: playlistUuid },
        token,
      );

      if (!response.playlist) {
        setError('not-found');
        return;
      }

      hasPlaylistDataRef.current = true;
      setPlaylist(response.playlist);
    } catch (err) {
      console.error('Error fetching playlist:', err);
      // Keep the SSR-rendered content on screen if a background refetch
      // hits a transient network error — we'd rather show slightly stale
      // data than blow it away with a full-page error state. Only escalate
      // when we genuinely have nothing to display.
      if (!hasPlaylistDataRef.current) {
        setError('load-failed');
      }
    } finally {
      setLoading(false);
    }
  }, [playlistUuid, token, tokenLoading]);

  useEffect(() => {
    void fetchPlaylist();
  }, [fetchPlaylist]);

  // Update lastAccessedAt when playlist loads (fire-and-forget, only for owners)
  useEffect(() => {
    if (playlist && token && playlist.userRole === 'owner' && !lastAccessedUpdatedRef.current) {
      lastAccessedUpdatedRef.current = true;
      executeGraphQL<UpdatePlaylistLastAccessedMutationResponse, UpdatePlaylistLastAccessedMutationVariables>(
        UPDATE_PLAYLIST_LAST_ACCESSED,
        { playlistId: playlistUuid },
        token,
      ).catch(() => {
        // Silently ignore - this is fire-and-forget
      });
    }
  }, [playlist, token, playlistUuid]);

  // Track per-device playlist opens so the library page can fall back to
  // "recently opened" when the user has nothing pinned. Records every load
  // (not just owners), since the recency list captures viewed playlists too.
  useEffect(() => {
    if (!playlist) return;
    void recordPlaylistOpen({
      uuid: playlist.uuid,
      boardType: playlist.boardType,
      layoutId: playlist.layoutId ?? null,
    });
  }, [playlist]);

  // === Playlist climbs data fetching (all-boards mode by default) ===

  // Only feed initialData to react-query when the current query key matches
  // the tuple the SSR climbs page was fetched for. Without this guard, every
  // new key (board switch, listRefreshKey bump after edits, …) would adopt
  // the same SSR page as fresh data and skip the actual fetch.
  const ssrClimbsApplicable = ssrSeedMatchesQueryKey(!!initialClimbs, ssrClimbsKeyRef.current, {
    boardUuid: selectedBoard?.uuid ?? null,
    refreshKey: listRefreshKey,
  });

  const {
    data: climbsData,
    fetchNextPage,
    hasNextPage,
    isFetching: isFetchingClimbs,
    isFetchingNextPage,
    isLoading: isClimbsLoading,
  } = useInfiniteQuery({
    queryKey: ['playlistClimbs', playlistUuid, selectedBoard?.uuid ?? 'all', listRefreshKey],
    queryFn: async ({ pageParam }) => {
      const client = createGraphQLHttpClient(token);

      const input: GetPlaylistClimbsInput = {
        playlistId: playlistUuid,
        page: pageParam,
        pageSize: 20,
        // Specific-board mode when a board is selected
        ...(selectedBoard && {
          boardName: selectedBoard.boardType,
          layoutId: selectedBoard.layoutId,
          sizeId: selectedBoard.sizeId,
          setIds: selectedBoard.setIds,
          angle: selectedBoard.angle ?? getDefaultAngleForBoard(selectedBoard.boardType),
        }),
      };

      const response = await client.request<GetPlaylistClimbsQueryResponse>(GET_PLAYLIST_CLIMBS, {
        input,
      } satisfies GetPlaylistClimbsQueryVariables);
      return response.playlistClimbs;
    },
    // Public playlists are readable without a token (the backend resolver
    // gates with verifyPlaylistAccess(userId ?? null)), so don't gate the
    // query on auth — otherwise signed-out viewers see the SSR first page
    // and "load more" silently does nothing.
    enabled: !tokenLoading,
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasMore) return undefined;
      return allPages.length;
    },
    staleTime: 5 * 60 * 1000,
    initialData:
      ssrClimbsApplicable && initialClimbs
        ? {
            pages: [initialClimbs],
            pageParams: [0],
          }
        : undefined,
    // Without this, react-query treats initialData as epoch-stale and fires
    // an immediate refetch, defeating the SSR optimisation. Only meaningful
    // when initialData itself is being supplied.
    initialDataUpdatedAt: ssrClimbsApplicable ? ssrInitialClimbsUpdatedAtRef.current : 0,
  });

  const allClimbs: Climb[] = useMemo(
    () => climbsData?.pages.flatMap((page) => page.climbs as Climb[]) ?? [],
    [climbsData],
  );

  // Collect unique board types for the filter
  const boardTypes = useMemo(() => {
    const types = new Set<string>();
    for (const climb of allClimbs) {
      if (climb.boardType) types.add(climb.boardType);
    }
    // Also include the playlist's own board type
    if (playlist?.boardType) types.add(playlist.boardType);
    return Array.from(types);
  }, [allClimbs, playlist?.boardType]);

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const handleEditSuccess = useCallback((updatedPlaylist: Playlist) => {
    setPlaylist(updatedPlaylist);
  }, []);

  const handlePlaylistUpdated = useCallback(() => {
    setListRefreshKey((prev) => prev + 1);
    void fetchPlaylist();
  }, [fetchPlaylist]);

  const handleDelete = useCallback(async () => {
    if (!token || !playlist) return;
    setMenuAnchor(null);

    try {
      await executeGraphQL<DeletePlaylistMutationResponse, DeletePlaylistMutationVariables>(
        DELETE_PLAYLIST,
        { playlistId: playlistUuid },
        token,
      );

      showMessage(t('detail.deleted'), 'success');
      router.push(playlistsBasePath);
    } catch (err) {
      console.error('Error deleting playlist:', err);
      showMessage(t('detail.deleteFailed'), 'error');
    }
  }, [token, playlist, playlistUuid, router, showMessage, playlistsBasePath, t]);

  const handleBoardSelect = useCallback((board: UserBoard | null) => {
    setSelectedBoard(board);
  }, []);

  const handleShare = useCallback(async () => {
    const shareUrl = `${window.location.origin}/playlists/${playlistUuid}`;
    await shareWithFallback({
      url: shareUrl,
      title: playlist?.name || t('detail.shareFallbackTitle'),
      text: t('detail.shareText'),
      trackingEvent: 'Playlist Shared',
      trackingProps: { playlistUuid },
      onClipboardSuccess: () => showMessage(t('detail.shareSuccess'), 'success'),
      onError: () => showMessage(t('detail.shareError'), 'error'),
    });
  }, [playlistUuid, playlist, showMessage, t]);

  // Pin / unpin from the detail header. Optimistically flip the local state
  // so the icon swaps immediately; revert on failure. Same mutation as the
  // grid card pin button on /playlists.
  const handleTogglePin = useCallback(async () => {
    if (!token || !playlist) return;
    const nextPinned = !playlist.isPinnedByMe;
    setPlaylist({ ...playlist, isPinnedByMe: nextPinned });
    try {
      if (nextPinned) {
        await executeGraphQL<PinPlaylistMutationResponse, PinPlaylistMutationVariables>(
          PIN_PLAYLIST,
          { input: { playlistUuid } },
          token,
        );
      } else {
        await executeGraphQL<UnpinPlaylistMutationResponse, UnpinPlaylistMutationVariables>(
          UNPIN_PLAYLIST,
          { input: { playlistUuid } },
          token,
        );
      }
    } catch (err) {
      console.error('Failed to toggle pin:', err);
      // Revert local state on failure.
      setPlaylist({ ...playlist, isPinnedByMe: !nextPinned });
      showMessage(t(nextPinned ? 'library.pin.pinFailed' : 'library.pin.unpinFailed'), 'error');
    }
  }, [token, playlist, playlistUuid, showMessage, t]);

  const isOwner = playlist?.userRole === 'owner';

  const getPlaylistColor = () => {
    if (playlist?.color && isValidHexColor(playlist.color)) {
      return playlist.color;
    }
    return PLAYLIST_COLORS[0];
  };

  // Board details for the generator drawer
  const generatorBoardDetails = useMemo(() => {
    if (!playlist) return null;
    return getBoardDetailsForPlaylist(playlist.boardType, playlist.layoutId);
  }, [playlist]);

  const generatorAngle = playlist ? getDefaultAngleForBoard(playlist.boardType) : 40;

  // Per-climb playlist write. Refreshes the playlist's climb list on success.
  const playlistGeneratorTarget = useMemo<GeneratorTarget>(
    () => ({
      saveClimb: async (climb) => {
        await executeGraphQL<AddClimbToPlaylistMutationResponse, AddClimbToPlaylistMutationVariables>(
          ADD_CLIMB_TO_PLAYLIST,
          {
            input: {
              playlistId: playlistUuid,
              climbUuid: climb.uuid,
              angle: generatorAngle,
            },
          },
          token,
        );
      },
      onComplete: (savedClimbs) => {
        if (savedClimbs.length > 0) handlePlaylistUpdated();
      },
    }),
    [playlistUuid, generatorAngle, token, handlePlaylistUpdated],
  );

  // With SSR data we have content to render, so don't gate on tokenLoading.
  // Showing the spinner during the first-tick auth bootstrap defeats the
  // no-spinner goal of seeding initialPlaylist from the server.
  if (loading || (tokenLoading && !playlist)) {
    return (
      <div className={styles.loadingContainer}>
        <LoadingSpinner size={48} />
      </div>
    );
  }

  if (error || !playlist) {
    const isNotFound = error === 'not-found';
    return (
      <div className={styles.errorContainer}>
        <SentimentDissatisfiedOutlined className={styles.errorIcon} />
        <div className={styles.errorTitle}>
          {isNotFound ? t('detail.errors.notFoundTitle') : t('detail.errors.loadTitle')}
        </div>
        <div className={styles.errorMessage}>
          {isNotFound ? t('detail.errors.notFoundDescription') : t('detail.errors.loadDescription')}
        </div>
        <MuiButton variant="outlined" onClick={fetchPlaylist}>
          {t('detail.errors.tryAgain')}
        </MuiButton>
      </div>
    );
  }

  return (
    <>
      {/* Back Button */}
      <div className={styles.actionsSection}>
        <BackButton fallbackUrl={playlistsBasePath} />
      </div>

      {/* Main Content */}
      <div className={styles.contentWrapper}>
        {/* Hero Card */}
        <div className={styles.heroSection}>
          <div className={styles.heroContent}>
            <div className={styles.heroSquare}>
              <PlaylistPreviewSquare
                boardType={playlist.boardType}
                layoutId={playlist.layoutId}
                color={getPlaylistColor()}
                icon={playlist.icon}
              />
            </div>
            <div className={styles.heroInfo}>
              <Typography
                variant="h5"
                component="h2"
                className={`${styles.heroName} ${playlist.isPublic ? styles.heroNameWithShare : ''}`}
              >
                {playlist.name}
              </Typography>
              <div className={styles.heroMeta}>
                <span className={styles.heroMetaItem}>{t('detail.climbCount', { count: playlist.climbCount })}</span>
                <span className={styles.heroMetaItem}>
                  <PeopleOutlined sx={{ fontSize: 14, verticalAlign: 'middle', mr: 0.5 }} />
                  {t('detail.followerCount', { count: playlist.followerCount })}
                </span>
                <span
                  className={`${styles.visibilityBadge} ${
                    playlist.isPublic ? styles.publicBadge : styles.privateBadge
                  }`}
                >
                  {playlist.isPublic ? (
                    <>
                      <PublicOutlined sx={{ fontSize: 14 }} /> {t('detail.visibility.public')}
                    </>
                  ) : (
                    <>
                      <LockOutlined sx={{ fontSize: 14 }} /> {t('detail.visibility.private')}
                    </>
                  )}
                </span>
              </div>
              {playlist.description && (
                <Typography variant="body2" className={styles.heroDescription}>
                  {playlist.description}
                </Typography>
              )}
              {/* Follow button for non-owners on public playlists */}
              {!isOwner && playlist.isPublic && (
                <Box sx={{ mt: 1 }}>
                  <FollowButton
                    entityId={playlist.uuid}
                    initialIsFollowing={playlist.isFollowedByMe}
                    followMutation={FOLLOW_PLAYLIST}
                    unfollowMutation={UNFOLLOW_PLAYLIST}
                    entityLabel="playlist"
                    getFollowVariables={(id) => ({ input: { playlistUuid: id } })}
                    onFollowChange={(isFollowing) => {
                      setPlaylist({
                        ...playlist,
                        followerCount: playlist.followerCount + (isFollowing ? 1 : -1),
                        isFollowedByMe: isFollowing,
                      });
                    }}
                  />
                </Box>
              )}
            </div>
          </div>

          {/* Share + Ellipsis Menu */}
          <Box
            sx={{
              position: 'absolute',
              top: 1.5,
              right: 1.5,
              display: 'flex',
              flexDirection: 'row',
              gap: 0.5,
            }}
          >
            {/* Pin toggle: any signed-in viewer can pin a playlist they can
                see (own private/public + others' public, gated server-side
                by verifyPlaylistAccess). Hidden for unauthenticated users. */}
            {token && (
              <IconButton
                onClick={handleTogglePin}
                aria-label={t(playlist.isPinnedByMe ? 'library.pin.unpinAriaLabel' : 'library.pin.pinAriaLabel')}
              >
                {playlist.isPinnedByMe ? <PushPin /> : <PushPinOutlined />}
              </IconButton>
            )}
            {playlist.isPublic && (
              <IconButton onClick={handleShare} aria-label={t('detail.share')}>
                <IosShare />
              </IconButton>
            )}
            <IconButton
              onClick={(e: React.MouseEvent<HTMLButtonElement>) => setMenuAnchor(e.currentTarget)}
              aria-label={t('detail.actions')}
            >
              <MoreVertOutlined />
            </IconButton>
          </Box>

          <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
            {isOwner && (
              <MenuItem
                onClick={() => {
                  setMenuAnchor(null);
                  setGeneratorOpen(true);
                }}
              >
                <ListItemIcon>
                  <ElectricBoltOutlined />
                </ListItemIcon>
                <ListItemText>{t('detail.menu.generate')}</ListItemText>
              </MenuItem>
            )}
            {isOwner && (
              <MenuItem
                onClick={() => {
                  setMenuAnchor(null);
                  setEditDrawerOpen(true);
                }}
              >
                <ListItemIcon>
                  <EditOutlined />
                </ListItemIcon>
                <ListItemText>{t('detail.menu.edit')}</ListItemText>
              </MenuItem>
            )}
            {isOwner && (
              <MenuItem onClick={handleDelete} sx={{ color: themeTokens.colors.error }}>
                <ListItemIcon>
                  <DeleteOutlined sx={{ color: themeTokens.colors.error }} />
                </ListItemIcon>
                <ListItemText>{t('detail.menu.delete')}</ListItemText>
              </MenuItem>
            )}
          </Menu>
        </div>

        {/* Climbs List with multi-board support */}
        <div className={styles.climbsSection}>
          {allClimbs.length === 0 && !isFetchingClimbs && !isClimbsLoading ? (
            <EmptyState description={t('detail.empty')} />
          ) : (
            <MultiboardClimbList
              climbs={allClimbs}
              isFetching={isFetchingClimbs}
              isLoading={isClimbsLoading}
              hasMore={hasNextPage ?? false}
              onLoadMore={handleLoadMore}
              showBoardFilter
              boardTypes={boardTypes}
              selectedBoard={selectedBoard}
              onBoardSelect={handleBoardSelect}
              fallbackBoardTypes={[playlist.boardType]}
              boards={myBoards}
              boardsLoading={boardsLoading}
            />
          )}
        </div>

        {/* Discussion */}
        {playlist.isPublic && (
          <div className={styles.discussionSection}>
            <CommentSection
              entityType="playlist_climb"
              entityId={`${playlistUuid}:_all`}
              title={t('detail.discussion')}
            />
          </div>
        )}
      </div>

      {/* Edit Drawer */}
      {playlist && (
        <PlaylistEditDrawer
          open={editDrawerOpen}
          playlist={playlist}
          onClose={() => setEditDrawerOpen(false)}
          onSuccess={handleEditSuccess}
        />
      )}

      {/* Generator Drawer */}
      {generatorBoardDetails && (
        <WorkoutGeneratorDrawer
          open={generatorOpen}
          onClose={() => setGeneratorOpen(false)}
          boardDetails={generatorBoardDetails}
          angle={generatorAngle}
          target={playlistGeneratorTarget}
          targetType="playlist"
        />
      )}
    </>
  );
}
