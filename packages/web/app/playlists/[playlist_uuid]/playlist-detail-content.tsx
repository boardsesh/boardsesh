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
} from '@mui/icons-material';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Climb } from '@/app/lib/types';
import { executeGraphQL, createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_PLAYLIST,
  GET_PLAYLIST_CLIMBS,
  DELETE_PLAYLIST,
  UPDATE_PLAYLIST_LAST_ACCESSED,
  FOLLOW_PLAYLIST,
  UNFOLLOW_PLAYLIST,
  GetPlaylistQueryResponse,
  GetPlaylistQueryVariables,
  GetPlaylistClimbsQueryResponse,
  type GetPlaylistClimbsQueryVariables,
  type GetPlaylistClimbsInput,
  Playlist,
  UpdatePlaylistLastAccessedMutationVariables,
  UpdatePlaylistLastAccessedMutationResponse,
  DeletePlaylistMutationVariables,
  DeletePlaylistMutationResponse,
} from '@/app/lib/graphql/operations/playlists';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { shareWithFallback } from '@/app/lib/share-utils';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { EmptyState } from '@/app/components/ui/empty-state';
import FollowButton from '@/app/components/ui/follow-button';
import PlaylistPreviewSquare from '@/app/components/library/playlist-preview-square';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { getBoardDetailsForPlaylist, getDefaultAngleForBoard } from '@/app/lib/board-config-for-playlist';
import { themeTokens } from '@/app/theme/theme-config';
import { useRouter } from 'next/navigation';
import BackButton from '@/app/components/back-button';
import { PlaylistGeneratorDrawer } from '@/app/components/playlist-generator';
import PlaylistEditDrawer from '@/app/components/library/playlist-edit-drawer';
import CommentSection from '@/app/components/social/comment-section';
import MultiboardClimbList from '@/app/components/climb-list/multiboard-climb-list';
import { useMyBoards } from '@/app/hooks/use-my-boards';
import { findMatchingBoard, type BoardConfig } from '@/app/lib/find-matching-board';
import type { UserBoard } from '@boardsesh/shared-schema';
import styles from '@/app/components/library/playlist-view.module.css';

// Validate hex color format
const isValidHexColor = (color: string): boolean => {
  return /^#([0-9A-Fa-f]{3}){1,2}$/.test(color);
};

const PLAYLIST_COLORS = [
  themeTokens.colors.primary,
  themeTokens.colors.logoGreen,
  themeTokens.colors.purple,
  themeTokens.colors.warning,
  themeTokens.colors.pink,
  themeTokens.colors.success,
  themeTokens.colors.logoRose,
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
};

export default function PlaylistDetailContent({
  playlistUuid,
  playlistsBasePath = '/playlists',
  boardSlug,
  boardConfig,
  initialMyBoards,
}: PlaylistDetailContentProps) {
  const router = useRouter();
  const { showMessage } = useSnackbar();
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [loading, setLoading] = useState(true);
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
  const { token, isLoading: tokenLoading } = useWsAuthToken();

  // Fetch user's boards (with SSR initial data to avoid loading skeleton).
  // These boards are forwarded to MultiboardClimbList via the `boards` prop so
  // we avoid duplicate GraphQL requests from MultiboardClimbList's internal hook.
  const { boards: myBoards, isLoading: boardsLoading } = useMyBoards(true, 50, initialMyBoards);

  // Auto-select the matching board once boards finish loading, but only when the
  // route explicitly provides a board context. Without a route-provided board,
  // default to "All Boards" so multi-board playlists show all their climbs.
  // Cross-board adds now prompt via the `QueueAddConfirmProvider` gate
  // instead of being silently blocked.
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
      setLoading(true);
      setError(null);

      const response = await executeGraphQL<GetPlaylistQueryResponse, GetPlaylistQueryVariables>(
        GET_PLAYLIST,
        { playlistId: playlistUuid },
        token,
      );

      if (!response.playlist) {
        setError('Playlist not found');
        return;
      }

      setPlaylist(response.playlist);
    } catch (err) {
      console.error('Error fetching playlist:', err);
      setError('Failed to load playlist');
    } finally {
      setLoading(false);
    }
  }, [playlistUuid, token, tokenLoading]);

  useEffect(() => {
    fetchPlaylist();
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

  // === Playlist climbs data fetching (all-boards mode by default) ===

  const {
    data: climbsData,
    fetchNextPage,
    hasNextPage,
    isFetching: isFetchingClimbs,
    isFetchingNextPage,
    isLoading: isClimbsLoading,
  } = useInfiniteQuery({
    queryKey: ['playlistClimbs', playlistUuid, selectedBoard?.uuid ?? 'all', listRefreshKey],
    queryFn: async ({ pageParam = 0 }) => {
      const client = createGraphQLHttpClient(token);

      const input: GetPlaylistClimbsInput = {
        playlistId: playlistUuid,
        page: pageParam as number,
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
    enabled: !tokenLoading && !!token,
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasMore) return undefined;
      return allPages.length;
    },
    staleTime: 5 * 60 * 1000,
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
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const handleEditSuccess = useCallback((updatedPlaylist: Playlist) => {
    setPlaylist(updatedPlaylist);
  }, []);

  const handlePlaylistUpdated = useCallback(() => {
    setListRefreshKey((prev) => prev + 1);
    fetchPlaylist();
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

      showMessage('Playlist deleted', 'success');
      router.push(playlistsBasePath);
    } catch (err) {
      console.error('Error deleting playlist:', err);
      showMessage('Failed to delete playlist', 'error');
    }
  }, [token, playlist, playlistUuid, router, showMessage, playlistsBasePath]);

  const handleBoardSelect = useCallback((board: UserBoard | null) => {
    setSelectedBoard(board);
  }, []);

  const handleShare = useCallback(async () => {
    const shareUrl = `${window.location.origin}/playlists/${playlistUuid}`;
    await shareWithFallback({
      url: shareUrl,
      title: playlist?.name || 'Playlist',
      text: 'Check out this climbing playlist on Boardsesh',
      trackingEvent: 'Playlist Shared',
      trackingProps: { playlistUuid },
      onClipboardSuccess: () => showMessage('Link copied to clipboard!', 'success'),
      onError: () => showMessage('Failed to share', 'error'),
    });
  }, [playlistUuid, playlist, showMessage]);

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

  if (loading || tokenLoading) {
    return (
      <div className={styles.loadingContainer}>
        <LoadingSpinner size={48} />
      </div>
    );
  }

  if (error || !playlist) {
    return (
      <div className={styles.errorContainer}>
        <SentimentDissatisfiedOutlined className={styles.errorIcon} />
        <div className={styles.errorTitle}>
          {error === 'Playlist not found' ? 'Playlist Not Found' : 'Unable to Load Playlist'}
        </div>
        <div className={styles.errorMessage}>
          {error === 'Playlist not found'
            ? 'This playlist may have been deleted or you may not have permission to view it.'
            : 'There was an error loading this playlist. Please try again.'}
        </div>
        <MuiButton variant="outlined" onClick={fetchPlaylist}>
          Try Again
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
              <Typography variant="h5" component="h2" className={styles.heroName}>
                {playlist.name}
              </Typography>
              <div className={styles.heroMeta}>
                <span className={styles.heroMetaItem}>
                  {playlist.climbCount} {playlist.climbCount === 1 ? 'climb' : 'climbs'}
                </span>
                <span className={styles.heroMetaItem}>
                  <PeopleOutlined sx={{ fontSize: 14, verticalAlign: 'middle', mr: 0.5 }} />
                  {playlist.followerCount} {playlist.followerCount === 1 ? 'follower' : 'followers'}
                </span>
                <span
                  className={`${styles.visibilityBadge} ${
                    playlist.isPublic ? styles.publicBadge : styles.privateBadge
                  }`}
                >
                  {playlist.isPublic ? (
                    <>
                      <PublicOutlined sx={{ fontSize: 14 }} /> Public
                    </>
                  ) : (
                    <>
                      <LockOutlined sx={{ fontSize: 14 }} /> Private
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
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            {playlist.isPublic && (
              <IconButton onClick={handleShare} aria-label="Share playlist">
                <IosShare />
              </IconButton>
            )}
            <IconButton
              className={styles.heroMenuButton}
              onClick={(e: React.MouseEvent<HTMLButtonElement>) => setMenuAnchor(e.currentTarget)}
              aria-label="Playlist actions"
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
                <ListItemText>Generate</ListItemText>
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
                <ListItemText>Edit</ListItemText>
              </MenuItem>
            )}
            {isOwner && (
              <MenuItem onClick={handleDelete} sx={{ color: themeTokens.colors.error }}>
                <ListItemIcon>
                  <DeleteOutlined sx={{ color: themeTokens.colors.error }} />
                </ListItemIcon>
                <ListItemText>Delete</ListItemText>
              </MenuItem>
            )}
          </Menu>
        </div>

        {/* Climbs List with multi-board support */}
        <div className={styles.climbsSection}>
          {allClimbs.length === 0 && !isFetchingClimbs && !isClimbsLoading ? (
            <EmptyState description="No climbs in this playlist yet" />
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
            <CommentSection entityType="playlist_climb" entityId={`${playlistUuid}:_all`} title="Discussion" />
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
        <PlaylistGeneratorDrawer
          open={generatorOpen}
          onClose={() => setGeneratorOpen(false)}
          playlistUuid={playlistUuid}
          boardDetails={generatorBoardDetails}
          angle={generatorAngle}
          onSuccess={handlePlaylistUpdated}
        />
      )}
    </>
  );
}
