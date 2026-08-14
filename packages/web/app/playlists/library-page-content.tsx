'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import MuiButton from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { LabelOutlined, LoginOutlined, SentimentDissatisfiedOutlined } from '@mui/icons-material';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import { type Playlist, type DiscoverablePlaylist } from '@boardsesh/graphql/operations/playlists';
import { useUserPlaylists } from '@/app/hooks/use-user-playlists';
import { useDiscoverPlaylists } from '@/app/hooks/use-discover-playlists';
import { usePinnedPlaylists } from '@/app/hooks/use-pinned-playlists';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useMyBoards } from '@/app/hooks/use-my-boards';
import { findMatchingBoard } from '@/app/lib/find-matching-board';
import { deriveIsAuthenticated } from '@/app/lib/derive-auth-status';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import PlaylistLinkCard from '@/app/components/playlists/playlist-link-card';
import styles from '@/app/components/ui/page-container.module.css';

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
};

/**
 * The read-only playlists directory. Every playlist is a real
 * `<a href="/playlists/{uuid}">` in a plain grid, so a crawler (and a
 * cmd-click) can reach it.
 *
 * Creating a playlist, filtering by board and building a custom board all live
 * in the app now — this surface reads, it does not write.
 */
export default function LibraryPageContent({
  boardSlug,
  playlistsBasePath = '/playlists',
  initialMyBoards,
  initialPlaylists,
  initialDiscoverPlaylists,
}: LibraryPageContentProps) {
  const { data: session, status: sessionStatus } = useSession();
  const { token, isLoading: tokenLoading } = useWsAuthToken();
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

  // Fetch user's boards so a board route can resolve its slug (with SSR initial data)
  const { boards: myBoards, isLoading: boardsLoading } = useMyBoards(
    hasInitialBoardData || sessionStatus === 'authenticated',
    50,
    initialMyBoards,
  );

  // Auto-select the route's board once boards finish loading (fallback for
  // non-SSR paths). Only board routes pin a board now — the global route shows
  // every playlist, because there is no queue on this page to infer one from.
  useEffect(() => {
    if (defaultBoardAppliedRef.current || boardsLoading || myBoards.length === 0) return;
    if (!boardSlug) {
      defaultBoardAppliedRef.current = true;
      return;
    }
    const match = myBoards.find((board) => board.slug === boardSlug);
    if (match) {
      setSelectedBoard(match);
    }
    defaultBoardAppliedRef.current = true;
  }, [myBoards, boardsLoading, boardSlug]);

  // Owned playlists — paginated grid. Reset on board filter change.
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

  // Discover playlists — paginated grid. Reset on board filter change. Two
  // parallel cursors (popular + recent) live inside the hook; exhausted
  // streams stop pulling additional pages.
  const {
    popular: popularPlaylists,
    recent: recentPlaylists,
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

  return (
    <>
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

      {/* Jump Back In — pinned playlists lead, the rest of the user's own
          playlists follow. One page at a time behind an explicit control, so
          nothing loads on scroll and every card is in the server HTML. */}
      {isAuthenticated && jumpBackInPlaylists.length > 0 && (
        <>
          <div className={styles.sectionTitle}>{t('library.sections.jumpBackIn')}</div>
          <div className={styles.cardGrid}>
            {jumpBackInPlaylists.map((p, i) => (
              <PlaylistLinkCard
                key={p.uuid}
                name={p.name}
                climbCount={p.climbCount}
                boardType={p.boardType}
                layoutId={p.layoutId}
                color={p.color}
                icon={p.icon}
                href={getPlaylistUrl(p.uuid)}
                index={i}
                fetchPriority={i === 0 ? 'high' : undefined}
              />
            ))}
          </div>
          {playlistsHasMore && (
            <MuiButton variant="text" onClick={loadMorePlaylists} disabled={playlistsLoadingMore}>
              {t('library.showMore')}
            </MuiButton>
          )}
        </>
      )}

      {/* Discover — popular + recent streams merged client-side. */}
      {discoverItems.length > 0 && (
        <>
          <div className={styles.sectionTitle}>{t('library.sections.discover')}</div>
          <div className={styles.cardGrid}>
            {discoverItems.map((p, i) => (
              <PlaylistLinkCard
                key={p.uuid}
                name={p.name}
                climbCount={p.climbCount}
                boardType={p.boardType}
                layoutId={p.layoutId}
                color={p.color}
                icon={p.icon}
                href={getPlaylistUrl(p.uuid)}
                index={i}
                fetchPriority={i === 0 && !isAuthenticated ? 'high' : undefined}
              />
            ))}
          </div>
          {discoverHasMore && (
            <MuiButton variant="text" onClick={loadMoreDiscover} disabled={discoverLoadingMore}>
              {t('library.showMore')}
            </MuiButton>
          )}
        </>
      )}
    </>
  );
}
