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
  DeleteOutlined,
  PeopleOutlined,
  IosShare,
  PushPin,
  PushPinOutlined,
} from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@/app/lib/types';
import type { ClimbThumbnailCrop } from '@/app/lib/climb-thumbnail-crop';
import { executeGraphQL, createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  type GetPlaylistQueryResponse,
  type GetPlaylistQueryVariables,
  type Playlist,
  type UpdatePlaylistLastAccessedMutationVariables,
  type UpdatePlaylistLastAccessedMutationResponse,
  type DeletePlaylistMutationVariables,
  type DeletePlaylistMutationResponse,
  GET_PLAYLIST,
  DELETE_PLAYLIST,
  UPDATE_PLAYLIST_LAST_ACCESSED,
  FOLLOW_PLAYLIST,
  UNFOLLOW_PLAYLIST,
  PIN_PLAYLIST,
  UNPIN_PLAYLIST,
  type PinPlaylistMutationResponse,
  type PinPlaylistMutationVariables,
  type UnpinPlaylistMutationResponse,
  type UnpinPlaylistMutationVariables,
  type PlaylistClimbsResult,
} from '@boardsesh/graphql/operations/playlists';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { shareWithFallback } from '@/app/lib/share-utils';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { EmptyState } from '@/app/components/ui/empty-state';
import FollowButton from '@/app/components/ui/follow-button';
import PlaylistPreviewSquare from '@/app/components/playlists/playlist-preview-square';
import PlaylistCoverMosaic from '@/app/components/playlists/playlist-cover-mosaic';
import { recordPlaylistOpen } from '@/app/lib/recent-playlists-db';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { isSessionSuperseded } from '@/app/lib/auth/session-guard';
import { getDefaultAngleForBoard } from '@/app/lib/board-config-for-playlist';
import { currentBrandColor } from '@boardsesh/velvet-tokens';
import { themeTokens } from '@/app/theme/theme-config';
import { DEFAULT_LOCALE, isSupportedLocale } from '@/app/lib/i18n/config';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import type { PlaylistGradeBandSummary } from '@/app/lib/playlist-grade-band';
import BackButton from '@/app/components/back-button';
import CommentSection from '@/app/components/social/comment-section';
import MultiboardClimbList from '@/app/components/climb-list/multiboard-climb-list';
import { usePlaylistClimbs, type PlaylistClimbsBoardInput } from '@boardsesh/playlists-react';
import { useMyBoards } from '@/app/hooks/use-my-boards';
import { findMatchingBoard, type BoardConfig } from '@/app/lib/find-matching-board';
import { ssrSeedMatchesQueryKey } from '@/app/lib/graphql/ssr-query-seed';
import type { UserBoard } from '@boardsesh/shared-schema';
import styles from '@/app/components/ui/page-container.module.css';
import shellStyles from '@/app/components/ui/page-shell/page-shell.module.css';
import PlaylistHeroCta from './playlist-hero-cta';
import PlaylistSubline, { playlistBoardTypes } from './playlist-subline';

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

// Named here, not left to the global `h1, h2` rule: a MUI Typography variant
// sets its own font-family, and that class beats the element selector.
const titleSx = {
  m: 0,
  fontFamily: 'var(--font-display), sans-serif',
  fontWeight: themeTokens.typography.fontWeight.bold,
  letterSpacing: '-0.025em',
  textWrap: 'balance',
} as const;

// The call to action's distance from the description or follow button above it.
const heroCtaSx = { mt: `${themeTokens.spacing[5]}px` } as const;

// Outlined circles beside the hand-off, the size of a comfortable tap.
const heroIconButtonSx = {
  width: 44,
  height: 44,
  border: '1px solid var(--control-border)',
} as const;

type PlaylistDetailContentProps = {
  playlistUuid: string;
  /** The page's locale, for the subline's list of boards and the hand-off event. */
  locale: string;
  /**
   * The playlist's grade band, from the server. Null for a private playlist or
   * one with no graded climb; the subline then leaves the band out.
   */
  gradeSummary?: PlaylistGradeBandSummary | null;
  thumbnailCropsByClimb?: Record<string, ClimbThumbnailCrop>;
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
  /**
   * The laptop's QR card, server-rendered by the page so `qrcode.react` never
   * reaches the client. Absent when the server read the playlist as private or
   * could not read it, and shown only while the playlist on screen is public.
   */
  qrCard?: React.ReactNode;
};

export default function PlaylistDetailContent({
  playlistUuid,
  locale,
  gradeSummary,
  thumbnailCropsByClimb,
  playlistsBasePath = '/playlists',
  boardSlug,
  boardConfig,
  initialMyBoards,
  initialPlaylist,
  initialClimbs,
  qrCard,
}: PlaylistDetailContentProps) {
  const router = useLocaleRouter();
  const { showMessage } = useSnackbar();
  const { t } = useTranslation('playlists');
  const { t: tMarketing, i18n: marketingI18n } = useTranslation('marketing');
  const [playlist, setPlaylist] = useState<Playlist | null>(initialPlaylist ?? null);
  const [loading, setLoading] = useState(!initialPlaylist);
  const [error, setError] = useState<string | null>(null);
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
  // chip switch would re-seed the new key with the original SSR page and
  // (because `initialDataUpdatedAt` puts it inside `staleTime`) skip the fetch
  // entirely.
  const ssrClimbsKeyRef = useRef({ boardUuid: selectedBoard?.uuid ?? null });
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
      // A reply for an earlier account: the fetch for the current one owns the state.
      if (isSessionSuperseded(err)) return;
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
  // the tuple the SSR climbs page was fetched for. Without this guard, a board
  // switch would adopt the same SSR page as fresh data and skip the actual
  // fetch.
  const ssrClimbsApplicable = ssrSeedMatchesQueryKey(!!initialClimbs, ssrClimbsKeyRef.current, {
    boardUuid: selectedBoard?.uuid ?? null,
  });

  // Specific-board mode when a board is selected; all-boards otherwise.
  const playlistClimbsBoardInput = useMemo<PlaylistClimbsBoardInput | undefined>(() => {
    if (!selectedBoard) return undefined;
    return {
      boardName: selectedBoard.boardType,
      layoutId: selectedBoard.layoutId,
      sizeId: selectedBoard.sizeId,
      setIds: selectedBoard.setIds,
      angle: selectedBoard.angle ?? getDefaultAngleForBoard(selectedBoard.boardType),
    };
  }, [selectedBoard]);

  // Web injects its token-aware transport explicitly so token semantics match
  // the previous inline query. Public playlists are readable without a token,
  // so the shared hook only gates on token resolution (tokenLoading), not auth.
  const executePlaylistClimbsGraphQL = useMemo<Parameters<typeof usePlaylistClimbs>[0]['executeGraphQL']>(
    () => (query, variables) => createGraphQLHttpClient(token).request(query, variables),
    [token],
  );

  const { query: playlistClimbsQuery, allClimbs: sharedAllClimbs } = usePlaylistClimbs({
    playlistUuid,
    boardUuid: selectedBoard?.uuid ?? null,
    refreshKey: 0,
    boardInput: playlistClimbsBoardInput,
    pageSize: 20,
    tokenLoading,
    initialData: initialClimbs,
    initialDataApplicable: ssrClimbsApplicable,
    initialDataUpdatedAt: ssrInitialClimbsUpdatedAtRef.current,
    executeGraphQL: executePlaylistClimbsGraphQL,
  });

  const {
    fetchNextPage,
    hasNextPage,
    isFetching: isFetchingClimbs,
    isFetchingNextPage,
    isLoading: isClimbsLoading,
  } = playlistClimbsQuery;

  // TYPE SEAM: the shared hook returns the structurally-wider queue `Climb`;
  // this screen uses web `Climb`. Runtime objects are the same flattened GraphQL
  // climbs, so cast once here.
  const allClimbs = sharedAllClimbs as unknown as Climb[];
  const usableThumbnailCrops = useMemo(() => {
    const initialByUuid = new Map(initialClimbs?.climbs.map((climb) => [climb.uuid, climb]));
    return Object.fromEntries(
      allClimbs.flatMap((climb) => {
        const initial = initialByUuid.get(climb.uuid);
        const crop = thumbnailCropsByClimb?.[climb.uuid];
        return crop &&
          initial?.frames === climb.frames &&
          initial.boardType === climb.boardType &&
          initial.layoutId === climb.layoutId
          ? [[climb.uuid, crop]]
          : [];
      }),
    );
  }, [allClimbs, initialClimbs, thumbnailCropsByClimb]);

  // The cover and the subline describe the playlist, not the current board
  // filter, so they read the server's unfiltered first page while it exists.
  const firstPageClimbs = useMemo<Climb[]>(
    () => (initialClimbs ? (initialClimbs.climbs as unknown as Climb[]) : allClimbs),
    [initialClimbs, allClimbs],
  );
  const playlistBoardType = playlist?.boardType;
  const boardTypes = useMemo(
    () => (playlistBoardType ? playlistBoardTypes(playlistBoardType, firstPageClimbs) : []),
    [playlistBoardType, firstPageClimbs],
  );

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

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
      return currentBrandColor(playlist.color);
    }
    return PLAYLIST_COLORS[0];
  };

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

  const climbList = (
    <MultiboardClimbList
      climbs={allClimbs}
      thumbnailCropsByClimb={usableThumbnailCrops}
      isFetching={isFetchingClimbs}
      isLoading={isClimbsLoading}
      hasMore={hasNextPage ?? false}
      onLoadMore={handleLoadMore}
      selectedBoard={selectedBoard}
      fallbackBoardTypes={[playlist.boardType]}
      boards={myBoards}
      // www has no bottom tab bar to clear; the spacer left an empty band
      // under a short list.
      showBottomSpacer={false}
    />
  );

  return (
    // PageShell's frame (header clearance, page width, gutters) without its
    // header: the h1 sits beside the cover, which PageShell's title cannot.
    <Box component="main" className={shellStyles.pageShell}>
      <Box className={`${shellStyles.inner} ${shellStyles.wide}`}>
        <Box className={shellStyles.breadcrumb}>
          <BackButton fallbackUrl={playlistsBasePath} />
        </Box>

        <Box component="header" className={styles.hero}>
          <div className={styles.heroCover}>
            <PlaylistCoverMosaic
              climbs={firstPageClimbs}
              fallbackBoardType={playlist.boardType}
              cropsByClimb={thumbnailCropsByClimb}
              fallback={
                <div className={styles.heroSquare}>
                  <PlaylistPreviewSquare
                    boardType={playlist.boardType}
                    layoutId={playlist.layoutId}
                    color={getPlaylistColor()}
                    icon={playlist.icon}
                  />
                </div>
              }
            />
          </div>

          <div className={styles.heroTitle}>
            <Typography variant="h2" component="h1" sx={titleSx}>
              {playlist.name}
            </Typography>
            <PlaylistSubline
              boardTypes={boardTypes}
              // The list's own count, which the meta description and share card
              // print too. `climbCount` also counts drafts and hidden spray climbs.
              climbCount={initialClimbs?.totalCount ?? playlist.climbCount}
              gradeSummary={gradeSummary}
              locale={locale}
            />
          </div>

          <div className={styles.heroBody}>
            <div className={styles.heroMeta}>
              <span className={styles.heroMetaItem}>
                <PeopleOutlined sx={{ fontSize: 14 }} />
                {t('detail.followerCount', { count: playlist.followerCount })}
              </span>
              <span
                className={`${styles.visibilityBadge} ${playlist.isPublic ? styles.publicBadge : styles.privateBadge}`}
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
              <Box sx={{ mt: 1.5 }}>
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

            <Box sx={heroCtaSx}>
              <PlaylistHeroCta
                playlistUuid={playlistUuid}
                boardType={playlist.boardType}
                layoutId={playlist.layoutId}
                isPublic={playlist.isPublic}
                locale={locale}
                labels={{
                  // The badges' own words, and the language they are in, which picks the artwork.
                  store: {
                    ios: tMarketing('home.hero.ctaInstallIos'),
                    android: tMarketing('home.hero.ctaInstallAndroid'),
                    update: tMarketing('home.hero.ctaUpdate'),
                    locale: isSupportedLocale(marketingI18n.language) ? marketingI18n.language : DEFAULT_LOCALE,
                  },
                  storeHelper: t('detail.cta.getAppHelper'),
                  // The playlist's own words: the climb page's "open it" names
                  // a climb, which reads wrong where a playlist is feminine.
                  handoffMobile: t('detail.cta.openInBrowserMobile'),
                  handoffDesktop: t('detail.cta.openInBrowser'),
                }}
                // The live visibility, not the server's: a playlist read as
                // private after the server rendered the card gets no code.
                qrCard={playlist.isPublic ? qrCard : null}
                actions={
                  <>
                    {/* Pin toggle: any signed-in viewer can pin a playlist they can
                        see (own private/public + others' public, gated server-side
                        by verifyPlaylistAccess). Hidden for unauthenticated users. */}
                    {token && (
                      <IconButton
                        color="primary"
                        sx={heroIconButtonSx}
                        onClick={handleTogglePin}
                        aria-label={t(
                          playlist.isPinnedByMe ? 'library.pin.unpinAriaLabel' : 'library.pin.pinAriaLabel',
                        )}
                      >
                        {playlist.isPinnedByMe ? <PushPin /> : <PushPinOutlined />}
                      </IconButton>
                    )}
                    {playlist.isPublic && (
                      <IconButton
                        color="primary"
                        sx={heroIconButtonSx}
                        onClick={handleShare}
                        aria-label={t('detail.share')}
                      >
                        <IosShare />
                      </IconButton>
                    )}
                    {/* Delete is the menu's only item and only the owner may use it,
                        so nobody else gets a button that opens an empty menu. */}
                    {isOwner && (
                      <IconButton
                        color="primary"
                        sx={heroIconButtonSx}
                        onClick={(e: React.MouseEvent<HTMLButtonElement>) => setMenuAnchor(e.currentTarget)}
                        aria-label={t('detail.actions')}
                      >
                        <MoreVertOutlined />
                      </IconButton>
                    )}
                  </>
                }
              />
            </Box>
          </div>

          {isOwner && (
            <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
              <MenuItem onClick={handleDelete} sx={{ color: 'var(--color-error)' }}>
                <ListItemIcon>
                  <DeleteOutlined sx={{ color: 'var(--color-error)' }} />
                </ListItemIcon>
                <ListItemText>{t('detail.menu.delete')}</ListItemText>
              </MenuItem>
            </Menu>
          )}
        </Box>

        <div className={styles.contentWrapper}>
          {/* Climbs List with multi-board support */}
          <div className={styles.climbsSection}>
            {allClimbs.length === 0 && !isFetchingClimbs && !isClimbsLoading ? (
              <EmptyState description={t('detail.empty')} />
            ) : (
              climbList
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
      </Box>
    </Box>
  );
}
