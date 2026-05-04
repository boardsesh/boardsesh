'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import MuiButton from '@mui/material/Button';
import Fab from '@mui/material/Fab';
import Typography from '@mui/material/Typography';
import { AddOutlined, LabelOutlined, LoginOutlined, SentimentDissatisfiedOutlined } from '@mui/icons-material';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import { executeGraphQL } from '@/app/lib/graphql/client';
import {
  type GetAllUserPlaylistsQueryResponse,
  type GetAllUserPlaylistsInput,
  type DiscoverPlaylistsQueryResponse,
  type DiscoverPlaylistsInput,
  type Playlist,
  type DiscoverablePlaylist,
  GET_ALL_USER_PLAYLISTS,
  DISCOVER_PLAYLISTS,
} from '@/app/lib/graphql/operations/playlists';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useMyBoards } from '@/app/hooks/use-my-boards';
import { useQueueBridgeBoardInfo } from '@/app/components/queue-control/queue-bridge-context';
import { constructBoardSlugPlaylistsUrl } from '@/app/lib/url-utils';
import { findMatchingBoard } from '@/app/lib/find-matching-board';
import { deriveIsAuthenticated } from '@/app/lib/derive-auth-status';
import { getDefaultAngleForBoard } from '@/app/lib/board-config-for-playlist';
import { themeTokens } from '@/app/theme/theme-config';
import type { UserBoard, PopularBoardConfig } from '@boardsesh/shared-schema';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import PlaylistCardGrid from '@/app/components/library/playlist-card-grid';
import PlaylistScrollSection from '@/app/components/library/playlist-scroll-section';
import PlaylistCard from '@/app/components/library/playlist-card';
import BoardFilterStrip from '@/app/components/board-scroll/board-filter-strip';
import BoardDiscoveryScroll from '@/app/components/board-scroll/board-discovery-scroll';
import SwipeableDrawer from '@/app/components/swipeable-drawer/swipeable-drawer';
import CreatePlaylistDrawer from '@/app/components/library/create-playlist-drawer';
import styles from '@/app/components/library/library.module.css';

type CreateBoardContext = {
  boardName: string;
  layoutId: number;
  angle: number;
};

type LibraryPageContentProps = {
  /** When set, the page was rendered from a board route and this board is pre-selected. */
  boardSlug?: string;
  /** Base path for playlist detail links (e.g. "/b/my-kilter/40/playlists" or "/kilter/original/12x12/default/45/playlists"). Defaults to "/playlists". */
  playlistsBasePath?: string;
  /** SSR-fetched user boards for instant rendering. */
  initialMyBoards?: UserBoard[] | null;
  /** SSR-fetched user playlists for instant rendering. */
  initialPlaylists?: Playlist[] | null;
  /** SSR-fetched discover playlists for instant rendering. */
  initialDiscoverPlaylists?: {
    popular: DiscoverablePlaylist[];
    recent: DiscoverablePlaylist[];
  } | null;
};

export default function LibraryPageContent({
  boardSlug,
  playlistsBasePath = '/playlists',
  initialMyBoards,
  initialPlaylists,
  initialDiscoverPlaylists,
}: LibraryPageContentProps) {
  const { data: session, status: sessionStatus } = useSession();
  const { token, isLoading: tokenLoading } = useWsAuthToken();
  const router = useLocaleRouter();
  const { t } = useTranslation('playlists');

  const hasInitialBoardData = initialMyBoards != null && initialMyBoards.length > 0;
  const hasInitialPlaylistData = initialPlaylists != null;
  const hasInitialDiscoverData = initialDiscoverPlaylists != null;

  const hasServerUserData = hasInitialPlaylistData || hasInitialBoardData;
  const isAuthenticated = deriveIsAuthenticated(sessionStatus, hasServerUserData);
  // Initialize selectedBoard from SSR data immediately when boardSlug is provided
  const [selectedBoard, setSelectedBoard] = useState<UserBoard | null>(() =>
    findMatchingBoard(initialMyBoards, boardSlug),
  );
  const { openAuthModal } = useAuthModal();
  const defaultBoardAppliedRef = useRef(!!selectedBoard);

  // Fetch user's boards for the board selector (with SSR initial data)
  const { boards: myBoards, isLoading: boardsLoading } = useMyBoards(
    hasInitialBoardData || sessionStatus === 'authenticated',
    50,
    initialMyBoards,
  );

  // Get current session/queue board info to use as default selection (global route only)
  const { boardDetails: currentBoardDetails, hasActiveQueue } = useQueueBridgeBoardInfo();

  // Auto-select the matching board once boards finish loading (fallback for non-SSR paths)
  useEffect(() => {
    if (defaultBoardAppliedRef.current || boardsLoading || myBoards.length === 0) return;

    if (boardSlug) {
      // Board route: match by slug
      const match = myBoards.find((b) => b.slug === boardSlug);
      if (match) {
        setSelectedBoard(match);
      }
      defaultBoardAppliedRef.current = true;
    } else {
      // Global route: match from current session/queue board
      // Wait if there's an active queue but board details haven't loaded yet
      if (!currentBoardDetails && hasActiveQueue) return;

      const match = currentBoardDetails
        ? findMatchingBoard(myBoards, undefined, {
            boardType: currentBoardDetails.board_name,
            layoutId: currentBoardDetails.layout_id,
            sizeId: currentBoardDetails.size_id,
          })
        : null;
      if (match) {
        setSelectedBoard(match);
      }
      defaultBoardAppliedRef.current = true;
    }
  }, [myBoards, boardsLoading, currentBoardDetails, hasActiveQueue, boardSlug]);

  // Data states — initialized from SSR data when available
  const [playlists, setPlaylists] = useState<Playlist[]>(initialPlaylists ?? []);
  const [popularPlaylists, setPopularPlaylists] = useState<DiscoverablePlaylist[]>(
    initialDiscoverPlaylists?.popular ?? [],
  );
  const [recentPlaylists, setRecentPlaylists] = useState<DiscoverablePlaylist[]>(
    initialDiscoverPlaylists?.recent ?? [],
  );

  // Loading states — skip loading when SSR data is available
  const [playlistsLoading, setPlaylistsLoading] = useState(!hasInitialPlaylistData);
  const [discoverLoading, setDiscoverLoading] = useState(!hasInitialDiscoverData);
  const [error, setError] = useState<string | null>(null);

  // Track whether we already have data to avoid re-showing loading skeleton on refetches
  const hasPlaylistDataRef = useRef(hasInitialPlaylistData);
  const hasDiscoverDataRef = useRef(hasInitialDiscoverData);

  // Fetch user data
  const fetchUserData = useCallback(async () => {
    if (tokenLoading || !isAuthenticated) {
      setPlaylistsLoading(false);
      return;
    }

    try {
      // Only show loading if we don't already have data
      if (!hasPlaylistDataRef.current) {
        setPlaylistsLoading(true);
      }
      setError(null);

      const input: GetAllUserPlaylistsInput = selectedBoard
        ? { boardType: selectedBoard.boardType, layoutId: selectedBoard.layoutId }
        : {};

      const playlistsRes = await executeGraphQL<GetAllUserPlaylistsQueryResponse, { input: GetAllUserPlaylistsInput }>(
        GET_ALL_USER_PLAYLISTS,
        { input },
        token,
      );

      setPlaylists(playlistsRes.allUserPlaylists);
      hasPlaylistDataRef.current = true;
    } catch (err) {
      console.error('Error fetching user data:', err);
      setError(t('library.errors.loadFailed'));
    } finally {
      setPlaylistsLoading(false);
    }
  }, [selectedBoard, token, tokenLoading, isAuthenticated, t]);

  // Fetch discover playlists (works for both "All" and specific board)
  const fetchDiscoverData = useCallback(async () => {
    try {
      // Only show loading if we don't already have data
      if (!hasDiscoverDataRef.current) {
        setDiscoverLoading(true);
      }

      const baseInput: DiscoverPlaylistsInput = {
        pageSize: 10,
        ...(selectedBoard && {
          boardType: selectedBoard.boardType,
          layoutId: selectedBoard.layoutId,
        }),
      };

      const [popularRes, recentRes] = await Promise.all([
        executeGraphQL<DiscoverPlaylistsQueryResponse, { input: DiscoverPlaylistsInput }>(DISCOVER_PLAYLISTS, {
          input: { ...baseInput, sortBy: 'popular' },
        }),
        executeGraphQL<DiscoverPlaylistsQueryResponse, { input: DiscoverPlaylistsInput }>(DISCOVER_PLAYLISTS, {
          input: { ...baseInput, sortBy: 'recent' },
        }),
      ]);

      setPopularPlaylists(popularRes.discoverPlaylists.playlists);
      setRecentPlaylists(recentRes.discoverPlaylists.playlists);
      hasDiscoverDataRef.current = true;
    } catch (err) {
      console.error('Error fetching discover playlists:', err);
    } finally {
      setDiscoverLoading(false);
    }
  }, [selectedBoard]);

  useEffect(() => {
    void fetchUserData();
  }, [fetchUserData]);

  useEffect(() => {
    void fetchDiscoverData();
  }, [fetchDiscoverData]);

  const getPlaylistUrl = useCallback(
    (playlistUuid: string) => {
      return `${playlistsBasePath}/${playlistUuid}`;
    },
    [playlistsBasePath],
  );

  // Filter discover playlists to exclude user's own
  const getDiscoverPlaylists = useCallback(() => {
    const userId = session?.user?.id;
    const combined = [...popularPlaylists, ...recentPlaylists];
    const seen = new Set<string>();
    const filtered: DiscoverablePlaylist[] = [];

    for (const p of combined) {
      if (seen.has(p.uuid)) continue;
      if (userId && p.creatorId === userId) continue;
      seen.add(p.uuid);
      filtered.push(p);
    }

    return filtered;
  }, [popularPlaylists, recentPlaylists, session?.user?.id]);

  const handleBoardSelect = useCallback(
    (board: UserBoard | null) => {
      setSelectedBoard(board);
      // Reset data refs so loading skeletons show for new board filter
      hasPlaylistDataRef.current = false;
      hasDiscoverDataRef.current = false;

      // When rendered from a board route, switching boards navigates to the correct URL
      if (boardSlug || playlistsBasePath !== '/playlists') {
        if (board) {
          const nextPlaylistsPath = constructBoardSlugPlaylistsUrl(board.slug, board.angle);
          router.push(nextPlaylistsPath);
        } else {
          router.push('/playlists');
        }
      }
    },
    [boardSlug, playlistsBasePath, router],
  );

  // Create-playlist FAB flow
  const [createBoardContext, setCreateBoardContext] = useState<CreateBoardContext | null>(null);
  const [isCreateDrawerOpen, setIsCreateDrawerOpen] = useState(false);
  const [isBoardPickerOpen, setIsBoardPickerOpen] = useState(false);
  const [isBoardPickerRendered, setIsBoardPickerRendered] = useState(false);

  const handleCreatePlaylistClick = useCallback(() => {
    if (selectedBoard) {
      setCreateBoardContext({
        boardName: selectedBoard.boardType,
        layoutId: selectedBoard.layoutId,
        angle: selectedBoard.angle,
      });
      setIsCreateDrawerOpen(true);
      return;
    }
    setIsBoardPickerRendered(true);
    setIsBoardPickerOpen(true);
  }, [selectedBoard]);

  const handlePickerBoardClick = useCallback((board: UserBoard) => {
    setCreateBoardContext({
      boardName: board.boardType,
      layoutId: board.layoutId,
      angle: board.angle,
    });
    setIsBoardPickerOpen(false);
    setIsCreateDrawerOpen(true);
  }, []);

  const handlePickerConfigClick = useCallback((config: PopularBoardConfig) => {
    setCreateBoardContext({
      boardName: config.boardType,
      layoutId: config.layoutId,
      angle: getDefaultAngleForBoard(config.boardType),
    });
    setIsBoardPickerOpen(false);
    setIsCreateDrawerOpen(true);
  }, []);

  const handlePickerCustomClick = useCallback(() => {
    // The custom-board flow lives elsewhere (board selector drawer); close the picker.
    setIsBoardPickerOpen(false);
  }, []);

  const handlePickerTransitionEnd = useCallback((open: boolean) => {
    if (!open) setIsBoardPickerRendered(false);
  }, []);

  const handlePlaylistCreated = useCallback(
    (playlist: Playlist) => {
      router.push(getPlaylistUrl(playlist.uuid));
    },
    [router, getPlaylistUrl],
  );

  // Error state (only for authenticated users with fetch errors)
  if (isAuthenticated && error) {
    return (
      <div className={styles.errorContainer}>
        <SentimentDissatisfiedOutlined className={styles.errorIcon} />
        <Typography variant="h6" component="h4" sx={{ mb: 1 }}>
          {t('library.errors.loadTitle')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('library.errors.loadDescription')}
        </Typography>
        <MuiButton variant="outlined" onClick={fetchUserData}>
          {t('library.errors.tryAgain')}
        </MuiButton>
      </div>
    );
  }

  const isLoading = playlistsLoading || tokenLoading || (!hasServerUserData && sessionStatus === 'loading');
  const discoverItems = getDiscoverPlaylists();

  // Server query already filters by boardType + layoutId; no client-side filter needed
  const filteredPlaylists = playlists;

  return (
    <>
      {/* Board Selector */}
      <BoardFilterStrip
        boards={myBoards}
        loading={boardsLoading && myBoards.length === 0}
        selectedBoard={selectedBoard}
        onBoardSelect={handleBoardSelect}
      />

      {/* Placeholder to reserve space while auth status resolves (prevents CLS) */}
      {!hasServerUserData && sessionStatus === 'loading' && (
        <div className={styles.signInBannerPlaceholder} aria-hidden="true" />
      )}

      {/* Sign-in banner for non-authenticated users */}
      {!hasServerUserData && !isAuthenticated && sessionStatus !== 'loading' && (
        <div className={styles.signInBanner}>
          <LoginOutlined sx={{ color: 'text.secondary', fontSize: 28 }} />
          <div className={styles.signInBannerText}>
            <Typography variant="body2" fontWeight={600}>
              {t('library.signInBanner.title')}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t('library.signInBanner.description')}
            </Typography>
          </div>
          <MuiButton
            variant="contained"
            size="small"
            onClick={() =>
              openAuthModal({
                title: t('library.signInBanner.modalTitle'),
                description: t('library.signInBanner.modalDescription'),
              })
            }
          >
            {t('library.signInBanner.cta')}
          </MuiButton>
        </div>
      )}

      {/* Authenticated: Recent Playlists Grid */}
      {isAuthenticated && (
        <PlaylistCardGrid playlists={filteredPlaylists} getPlaylistUrl={getPlaylistUrl} loading={isLoading} />
      )}

      {/* Empty state if no playlists (authenticated only) */}
      {isAuthenticated && !isLoading && playlists.length === 0 && (
        <div className={styles.emptyContainer}>
          <LabelOutlined className={styles.emptyIcon} />
          <Typography variant="h6" component="h4" sx={{ mb: 1 }}>
            {t('library.empty.title')}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 300, mb: 2 }}>
            {t('library.empty.description')}
          </Typography>
        </div>
      )}

      {/* Jump Back In (authenticated only) */}
      {isAuthenticated && (isLoading || filteredPlaylists.length > 0) && (
        <PlaylistScrollSection title={t('library.sections.jumpBackIn')} loading={isLoading}>
          {filteredPlaylists.slice(0, 10).map((p, i) => (
            <PlaylistCard
              key={p.uuid}
              name={p.name}
              climbCount={p.climbCount}
              boardType={p.boardType}
              layoutId={p.layoutId}
              color={p.color}
              icon={p.icon}
              href={getPlaylistUrl(p.uuid)}
              variant="scroll"
              index={i}
            />
          ))}
        </PlaylistScrollSection>
      )}

      {/* Discover */}
      {(discoverLoading || discoverItems.length > 0) && (
        <PlaylistScrollSection title={t('library.sections.discover')} loading={discoverLoading}>
          {discoverItems.map((p, i) => (
            <PlaylistCard
              key={p.uuid}
              name={p.name}
              climbCount={p.climbCount}
              boardType={p.boardType}
              layoutId={p.layoutId}
              color={p.color}
              icon={p.icon}
              href={getPlaylistUrl(p.uuid)}
              variant="scroll"
              index={i}
              fetchPriority={i === 0 ? 'high' : undefined}
            />
          ))}
        </PlaylistScrollSection>
      )}

      {/* Create Playlist FAB (authenticated users only) */}
      {isAuthenticated && (
        <Fab
          color="primary"
          aria-label={t('library.createFab.ariaLabel')}
          onClick={handleCreatePlaylistClick}
          sx={{
            position: 'fixed',
            right: themeTokens.spacing[4],
            bottom: `calc(var(--tab-bar-safe-area-padding, 0px) + 88px)`,
            zIndex: 1000,
          }}
        >
          <AddOutlined />
        </Fab>
      )}

      {/* Board picker drawer (only when no board is filter-selected) */}
      {isBoardPickerRendered && (
        <SwipeableDrawer
          title={t('common:boardSelector.title')}
          placement="bottom"
          open={isBoardPickerOpen}
          onClose={() => setIsBoardPickerOpen(false)}
          onTransitionEnd={handlePickerTransitionEnd}
        >
          <BoardDiscoveryScroll
            onBoardClick={handlePickerBoardClick}
            onConfigClick={handlePickerConfigClick}
            onCustomClick={handlePickerCustomClick}
          />
        </SwipeableDrawer>
      )}

      {/* Create Playlist Drawer */}
      {createBoardContext && (
        <CreatePlaylistDrawer
          open={isCreateDrawerOpen}
          onClose={() => setIsCreateDrawerOpen(false)}
          boardName={createBoardContext.boardName}
          layoutId={createBoardContext.layoutId}
          angle={createBoardContext.angle}
          source="discover-fab"
          onCreated={handlePlaylistCreated}
        />
      )}
    </>
  );
}
