'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import MuiButton from '@mui/material/Button';
import Fab from '@mui/material/Fab';
import Typography from '@mui/material/Typography';
import { AddOutlined, LabelOutlined, LoginOutlined, SentimentDissatisfiedOutlined } from '@mui/icons-material';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import { executeGraphQL } from '@/app/lib/graphql/client';
import {
  type GetMySmartPlaylistCountsQueryResponse,
  type Playlist,
  type DiscoverablePlaylist,
  GET_MY_SMART_PLAYLIST_COUNTS,
} from '@boardsesh/graphql/operations/playlists';
import { useUserPlaylists } from '@/app/hooks/use-user-playlists';
import { useDiscoverPlaylists } from '@/app/hooks/use-discover-playlists';
import { usePinnedPlaylists } from '@/app/hooks/use-pinned-playlists';
import { SMART_PLAYLISTS, smartPlaylistHref } from '@/app/lib/smart-playlists';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useMyBoards } from '@/app/hooks/use-my-boards';
import { useQueueBridgeBoardInfo } from '@/app/components/queue-control/queue-bridge-context';
import { constructBoardSlugPlaylistsUrl } from '@/app/lib/url-utils';
import { findMatchingBoard } from '@/app/lib/find-matching-board';
import { deriveIsAuthenticated } from '@/app/lib/derive-auth-status';
import type { UserBoard, PopularBoardConfig } from '@boardsesh/shared-schema';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import PlaylistScrollSection from '@/app/components/library/playlist-scroll-section';
import PlaylistCard from '@/app/components/library/playlist-card';
import CreatePlaylistDrawer from '@/app/components/library/create-playlist-drawer';
import BoardDiscoveryScroll from '@/app/components/board-scroll/board-discovery-scroll';
import BoardSelectorDrawer from '@/app/components/board-selector-drawer/board-selector-drawer';
import SwipeableDrawer from '@/app/components/swipeable-drawer/swipeable-drawer';
import BoardFilterStrip from '@/app/components/board-scroll/board-filter-strip';
import { themeTokens } from '@/app/theme/theme-config';
import type { BoardConfigData } from '@/app/lib/server-board-configs';
import type { StoredBoardConfig } from '@/app/lib/saved-boards-db';
import styles from '@/app/components/library/library.module.css';

type SelectedBoardForCreate = { boardType: string; layoutId: number };

type PendingDrawerAction = { type: 'create'; context: SelectedBoardForCreate } | { type: 'custom' } | null;

type LibraryPageContentProps = {
  /** When set, the page was rendered from a board route and this board is pre-selected. */
  boardSlug?: string;
  /** Base path for playlist detail links (e.g. "/b/my-kilter/40/playlists" or "/kilter/original/12x12/default/45/playlists"). Defaults to "/playlists". */
  playlistsBasePath?: string;
  /** SSR-fetched user boards for instant rendering. */
  initialMyBoards?: UserBoard[] | null;
  /** SSR-fetched user playlists for instant rendering. The connection shape
   *  carries hasMore + totalCount so the client hook can seed both correctly
   *  and avoid a redundant first fetch. */
  initialPlaylists?: { playlists: Playlist[]; totalCount: number; hasMore: boolean } | null;
  /** SSR-fetched discover playlists for instant rendering. The connection
   *  shape carries per-stream hasMore + totalCount so the client hook can
   *  seed both correctly and avoid a redundant first fetch. */
  initialDiscoverPlaylists?: {
    popular: DiscoverablePlaylist[];
    recent: DiscoverablePlaylist[];
    popularHasMore: boolean;
    recentHasMore: boolean;
    popularTotalCount?: number;
    recentTotalCount?: number;
  } | null;
  /** Board configuration data for the custom-board picker path. */
  boardConfigs?: BoardConfigData;
  /** Analytics label that distinguishes which page the FAB is on. */
  createSource?: string;
};

export default function LibraryPageContent({
  boardSlug,
  playlistsBasePath = '/playlists',
  initialMyBoards,
  initialPlaylists,
  initialDiscoverPlaylists,
  boardConfigs,
  createSource = 'discover-fab',
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
  const { showMessage } = useSnackbar();
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

  // Owned playlists — paginated horizontal scroll. Reset on board filter change.
  const {
    playlists,
    isLoading: playlistsLoading,
    isLoadingMore: playlistsLoadingMore,
    hasMore: playlistsHasMore,
    hasError: playlistsHasError,
    loadMore: loadMorePlaylists,
    refetch: refetchPlaylists,
  } = useUserPlaylists({
    token: isAuthenticated ? token : null,
    boardType: selectedBoard?.boardType,
    layoutId: selectedBoard?.layoutId,
    pageSize: 20,
    initialData: hasInitialPlaylistData ? initialPlaylists.playlists : undefined,
    // Pass through the server's real hasMore + totalCount so the
    // IntersectionObserver doesn't fire a redundant first request just to
    // discover hasMore=false, and so any "X of Y" copy is correct on first
    // paint.
    initialHasMore: hasInitialPlaylistData ? initialPlaylists.hasMore : undefined,
    initialTotalCount: hasInitialPlaylistData ? initialPlaylists.totalCount : undefined,
  });

  // Pinned playlists — server first, IndexedDB recents fallback. Re-derives on
  // every playlists/board/recents change.
  const { pinned: pinnedPlaylists, isLoading: pinnedLoading } = usePinnedPlaylists({
    token: isAuthenticated ? token : null,
    boardType: selectedBoard?.boardType,
    layoutId: selectedBoard?.layoutId,
    candidatePlaylists: playlists,
  });

  // Discover playlists — paginated horizontal scroll. Reset on board filter
  // change. Two parallel cursors (popular + recent) live inside the hook;
  // exhausted streams stop pulling additional pages.
  const {
    popular: popularPlaylists,
    recent: recentPlaylists,
    isLoading: discoverLoading,
    isLoadingMore: discoverLoadingMore,
    hasMore: discoverHasMore,
    loadMore: loadMoreDiscover,
  } = useDiscoverPlaylists({
    boardType: selectedBoard?.boardType,
    layoutId: selectedBoard?.layoutId,
    pageSize: 10,
    initialData: hasInitialDiscoverData
      ? { popular: initialDiscoverPlaylists.popular, recent: initialDiscoverPlaylists.recent }
      : undefined,
    initialPopularHasMore: hasInitialDiscoverData ? initialDiscoverPlaylists.popularHasMore : undefined,
    initialRecentHasMore: hasInitialDiscoverData ? initialDiscoverPlaylists.recentHasMore : undefined,
  });
  const error = playlistsHasError;

  // Smart playlist counts — react-query handles caching across the session and
  // dedupes if the page remounts. The token is part of the key so we refetch
  // after sign-in/out, but a 5-minute staleTime avoids refetching every visit.
  const { data: smartCountsData } = useQuery({
    queryKey: ['mySmartPlaylistCounts', token ?? null],
    queryFn: async () => {
      const res = await executeGraphQL<GetMySmartPlaylistCountsQueryResponse, Record<string, never>>(
        GET_MY_SMART_PLAYLIST_COUNTS,
        {},
        token,
      );
      return res.mySmartPlaylistCounts;
    },
    enabled: !tokenLoading && isAuthenticated && !!token,
    staleTime: 5 * 60 * 1000,
  });
  const smartCounts = smartCountsData ?? [];

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
      // useUserPlaylists / useDiscoverPlaylists / usePinnedPlaylists all reset
      // themselves on filter change.

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

  // Create-playlist flow state. The *Rendered flags keep each drawer mounted
  // through its slide-out animation; the *Open flags drive the visible state.
  const [isCreateDrawerOpen, setIsCreateDrawerOpen] = useState(false);
  const [isCreateDrawerRendered, setIsCreateDrawerRendered] = useState(false);
  const [isBoardPickerOpen, setIsBoardPickerOpen] = useState(false);
  const [isBoardPickerRendered, setIsBoardPickerRendered] = useState(false);
  const [isCustomBoardOpen, setIsCustomBoardOpen] = useState(false);
  const [isCustomBoardRendered, setIsCustomBoardRendered] = useState(false);
  const [createBoardContext, setCreateBoardContext] = useState<SelectedBoardForCreate | null>(null);

  // Pending action to fire once the currently-closing drawer finishes its
  // slide-out, so two drawers are never mounted-and-animating at once.
  const [pendingDrawer, setPendingDrawer] = useState<PendingDrawerAction>(null);

  const openCreateDrawerFor = useCallback((boardType: string, layoutId: number) => {
    setCreateBoardContext({ boardType, layoutId });
    setIsCreateDrawerRendered(true);
    setIsCreateDrawerOpen(true);
  }, []);

  const fulfillPendingDrawer = useCallback(() => {
    if (!pendingDrawer) return;
    if (pendingDrawer.type === 'create') {
      openCreateDrawerFor(pendingDrawer.context.boardType, pendingDrawer.context.layoutId);
    } else if (pendingDrawer.type === 'custom') {
      setIsCustomBoardRendered(true);
      setIsCustomBoardOpen(true);
    }
    setPendingDrawer(null);
  }, [pendingDrawer, openCreateDrawerFor]);

  const handleCreateDrawerTransitionEnd = useCallback((open: boolean) => {
    if (!open) setIsCreateDrawerRendered(false);
  }, []);
  const handleBoardPickerTransitionEnd = useCallback(
    (open: boolean) => {
      if (!open) {
        setIsBoardPickerRendered(false);
        fulfillPendingDrawer();
      }
    },
    [fulfillPendingDrawer],
  );
  const handleCustomBoardTransitionEnd = useCallback(
    (open: boolean) => {
      if (!open) {
        setIsCustomBoardRendered(false);
        fulfillPendingDrawer();
      }
    },
    [fulfillPendingDrawer],
  );

  const handleCreateClick = useCallback(() => {
    // Prefer the filter strip's selectedBoard, but fall back to a fresh slug
    // lookup against myBoards: on board routes the auto-select effect runs
    // after first paint, so a fast tap can still find selectedBoard === null
    // even though the route already pins us to a specific board.
    const board = selectedBoard ?? (boardSlug ? findMatchingBoard(myBoards, boardSlug) : null);
    if (board) {
      openCreateDrawerFor(board.boardType, board.layoutId);
      return;
    }
    setIsBoardPickerRendered(true);
    setIsBoardPickerOpen(true);
  }, [selectedBoard, boardSlug, myBoards, openCreateDrawerFor]);

  const handlePickerBoardClick = useCallback((board: UserBoard) => {
    setPendingDrawer({ type: 'create', context: { boardType: board.boardType, layoutId: board.layoutId } });
    setIsBoardPickerOpen(false);
  }, []);

  const handlePickerConfigClick = useCallback((config: PopularBoardConfig) => {
    setPendingDrawer({ type: 'create', context: { boardType: config.boardType, layoutId: config.layoutId } });
    setIsBoardPickerOpen(false);
  }, []);

  const handlePickerCustomClick = useCallback(() => {
    if (!boardConfigs) {
      // Defensive: every parent route passes boardConfigs, so this is unexpected.
      // Tell the user instead of swallowing the tap silently.
      setIsBoardPickerOpen(false);
      showMessage(t('library.customUnavailable'), 'error');
      return;
    }
    setPendingDrawer({ type: 'custom' });
    setIsBoardPickerOpen(false);
  }, [boardConfigs, showMessage, t]);

  const handleCustomBoardSelected = useCallback(
    (_url: string, config?: StoredBoardConfig) => {
      if (config && config.layoutId > 0) {
        setPendingDrawer({ type: 'create', context: { boardType: config.board, layoutId: config.layoutId } });
        setIsCustomBoardOpen(false);
        return;
      }
      // BoardSelectorDrawer can fire onBoardSelected with no config (e.g. when it
      // navigates without a stored entry); we have nothing to feed the create
      // mutation, so surface the failure instead of dropping the tap.
      setIsCustomBoardOpen(false);
      showMessage(t('bottomTabBar.selectBoardForPlaylist'), 'error');
    },
    [showMessage, t],
  );

  const handlePlaylistCreated = useCallback(
    (created: Playlist) => {
      // Refetch first page so the new playlist shows up in "Jump Back In",
      // then navigate. Cheaper than doing both an optimistic prepend and a
      // full re-pull, and avoids divergence between local state and server
      // ordering once lastAccessedAt is touched on the detail page.
      refetchPlaylists();
      router.push(getPlaylistUrl(created.uuid));
    },
    [refetchPlaylists, router, getPlaylistUrl],
  );

  // Jump Back In list — pinned playlists lead, then the rest of the owned
  // playlists with pinned items removed so they don't appear twice. Server
  // query already filters by boardType + layoutId; no client-side filter needed.
  // Computed before the error-state early return so the hook order stays
  // stable across renders that switch into/out of the error UI.
  const jumpBackInPlaylists = useMemo(() => {
    const pinnedUuidSet = new Set(pinnedPlaylists.map((p) => p.uuid));
    return [...pinnedPlaylists, ...playlists.filter((p) => !pinnedUuidSet.has(p.uuid))];
  }, [pinnedPlaylists, playlists]);

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
        <MuiButton variant="outlined" onClick={refetchPlaylists}>
          {t('library.errors.tryAgain')}
        </MuiButton>
      </div>
    );
  }

  const isLoading = playlistsLoading || tokenLoading || (!hasServerUserData && sessionStatus === 'loading');
  const discoverItems = getDiscoverPlaylists();

  // Smart playlists prepended to the playlist card grid for the signed-in user.
  // Skip entries with count === 0 so the grid only shows non-empty smart playlists.
  // boardType/layoutId drive the board-preview backdrop on the smart cards;
  // pick the user's selected board if any, falling back to their primary
  // board so a Tension-only user doesn't see a Kilter visual.
  const currentUserId = session?.user?.id ?? null;
  const smartCardBoard = selectedBoard ?? myBoards[0] ?? null;

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

      {/* Smart playlists computed from the signed-in user's logbook. Sits
          above Pinned because the cards are auto-generated suggestions —
          a clean entry point at the top of the page. Only renders presets
          whose count is non-zero so users without enough history don't see
          empty cards. */}
      {isAuthenticated && currentUserId && smartCounts.some((c) => c.count > 0) && (
        <>
          <div className={styles.sectionTitle}>{t('library.sections.smart')}</div>
          <div className={styles.cardGrid}>
            {SMART_PLAYLISTS.map((preset, i) => {
              const found = smartCounts.find((c) => c.type === preset.type);
              const count = found?.count ?? 0;
              if (count === 0) return null;
              return (
                <PlaylistCard
                  key={preset.slug}
                  name={t(preset.titleI18nKey)}
                  climbCount={count}
                  boardType={smartCardBoard?.boardType ?? 'kilter'}
                  layoutId={smartCardBoard?.layoutId ?? null}
                  color={preset.color}
                  icon={preset.icon}
                  href={smartPlaylistHref(preset.slug, currentUserId)}
                  variant="grid"
                  index={i}
                  fetchPriority={i === 0 ? 'high' : undefined}
                />
              );
            })}
          </div>
        </>
      )}

      {/* Empty state if no playlists at all (authenticated, no pinned + no owned) */}
      {isAuthenticated && !isLoading && !pinnedLoading && playlists.length === 0 && pinnedPlaylists.length === 0 && (
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

      {/* Jump Back In — paginated horizontal scroll. Pinned playlists lead;
          the rest of the user's owned playlists follow. IntersectionObserver
          in PlaylistScrollSection fires loadMore when the right-edge sentinel
          comes into view. */}
      {isAuthenticated && (isLoading || jumpBackInPlaylists.length > 0) && (
        <PlaylistScrollSection
          title={t('library.sections.jumpBackIn')}
          loading={isLoading}
          onLoadMore={loadMorePlaylists}
          hasMore={playlistsHasMore}
          isLoadingMore={playlistsLoadingMore}
        >
          {jumpBackInPlaylists.map((p, i) => (
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

      {/* Discover — paginated horizontal scroll, popular + recent streams
          merged client-side. Same IntersectionObserver-driven loadMore as
          "Jump Back In". */}
      {(discoverLoading || discoverItems.length > 0) && (
        <PlaylistScrollSection
          title={t('library.sections.discover')}
          loading={discoverLoading}
          onLoadMore={loadMoreDiscover}
          hasMore={discoverHasMore}
          isLoadingMore={discoverLoadingMore}
        >
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
          size="small"
          onClick={handleCreateClick}
          aria-label={t('library.createFab.ariaLabel')}
          sx={{
            position: 'fixed',
            // Anchor the FAB to the right edge of .pageContainer (see --library-page-max-width
            // in library.module.css) so it doesn't drift to the browser edge on wide viewports.
            right: `max(${themeTokens.spacing[4]}px, calc((100vw - var(--library-page-max-width)) / 2 + ${themeTokens.spacing[4]}px))`,
            // --bottom-bar-height is set by persistent-session-wrapper after hydration with the
            // measured queue-control + tab-bar height; the 145px fallback matches the SSR estimate
            // declared in app/components/index.css and is what users see during first paint only.
            bottom: `calc(var(--bottom-bar-height, 145px) + ${themeTokens.spacing[4]}px)`,
            zIndex: themeTokens.zIndex.fixed,
          }}
        >
          <AddOutlined />
        </Fab>
      )}

      {/* Board picker shown when no board is currently selected */}
      {isBoardPickerRendered && (
        <SwipeableDrawer
          title={t('common:boardSelector.title')}
          placement="bottom"
          open={isBoardPickerOpen}
          onClose={() => setIsBoardPickerOpen(false)}
          onTransitionEnd={handleBoardPickerTransitionEnd}
        >
          <BoardDiscoveryScroll
            onBoardClick={handlePickerBoardClick}
            onConfigClick={handlePickerConfigClick}
            onCustomClick={handlePickerCustomClick}
            myBoards={myBoards}
          />
        </SwipeableDrawer>
      )}

      {/* Custom board configuration drawer (mounted only when boardConfigs is provided) */}
      {boardConfigs && isCustomBoardRendered && (
        <BoardSelectorDrawer
          open={isCustomBoardOpen}
          onClose={() => setIsCustomBoardOpen(false)}
          onTransitionEnd={handleCustomBoardTransitionEnd}
          boardConfigs={boardConfigs}
          placement="bottom"
          onBoardSelected={handleCustomBoardSelected}
        />
      )}

      {/* Create-playlist drawer */}
      {isCreateDrawerRendered && createBoardContext && (
        <CreatePlaylistDrawer
          open={isCreateDrawerOpen}
          onClose={() => setIsCreateDrawerOpen(false)}
          onTransitionEnd={handleCreateDrawerTransitionEnd}
          boardName={createBoardContext.boardType}
          layoutId={createBoardContext.layoutId}
          source={createSource}
          onCreated={handlePlaylistCreated}
        />
      )}
    </>
  );
}
