'use client';

import React, { useCallback, useMemo, useRef, useState } from 'react';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import MuiButton from '@mui/material/Button';
import { IosShare, SentimentDissatisfiedOutlined } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import type { BoardDetails, Climb } from '@/app/lib/types';
import type { UserBoard } from '@boardsesh/shared-schema';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  type GetSmartPlaylistQueryResponse,
  type GetSmartPlaylistQueryVariables,
  type SmartPlaylistResult,
  type SmartPlaylistType,
  GET_SMART_PLAYLIST,
} from '@boardsesh/graphql/operations/playlists';
import { useSmartPlaylist } from '@boardsesh/playlists-react';
import { type SmartPlaylistSlug, smartPlaylistByType } from '@/app/lib/smart-playlists';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useMyBoards } from '@/app/hooks/use-my-boards';
import { findMatchingBoard } from '@/app/lib/find-matching-board';
import { ssrSeedMatchesQueryKey } from '@/app/lib/graphql/ssr-query-seed';
import { shareWithFallback } from '@/app/lib/share-utils';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { EmptyState } from '@/app/components/ui/empty-state';
import PlaylistPreviewSquare from '@/app/components/library/playlist-preview-square';
import MultiboardClimbList from '@/app/components/climb-list/multiboard-climb-list';
import { PlaylistActivationProvider } from '@/app/components/climb-actions/playlist-activation-context';
import { useOptionalQueueActions } from '@/app/components/graphql-queue';
import { useQueueBridgeBoardInfo } from '@/app/components/queue-control/queue-bridge-context';
import { fetchPlaylistSuggestionClimbs } from '@/app/components/queue-control/playlist-suggestion-refresh';
import { useClearPlaylistSuggestionSourceOnUnmount } from '@/app/components/queue-control/use-clear-playlist-suggestion-source-on-unmount';
import { usePlaylistClimbActivation } from '@/app/components/queue-control/use-playlist-climb-activation';
import BackButton from '@/app/components/back-button';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getUserBoardDetails } from '@/app/lib/board-config-for-playlist';
import styles from '@/app/components/library/playlist-view.module.css';

type Props = {
  smartPlaylistType: SmartPlaylistType;
  smartPlaylistSlug: SmartPlaylistSlug;
  userId: string;
  initialMyBoards?: UserBoard[] | null;
  /** SSR-fetched first page so the hero + climbs paint without a spinner. */
  initialSmartPlaylist?: SmartPlaylistResult | null;
};

export default function SmartPlaylistContent({
  smartPlaylistType,
  smartPlaylistSlug,
  userId,
  initialMyBoards,
  initialSmartPlaylist,
}: Props) {
  const { t } = useTranslation('playlists');
  const { showMessage } = useSnackbar();
  const { token, isLoading: tokenLoading } = useWsAuthToken();
  const queueActions = useOptionalQueueActions();
  const activeQueueBoardInfo = useQueueBridgeBoardInfo();
  const preset = smartPlaylistByType(smartPlaylistType);
  // Recommendations are personal to the viewer (the backend returns empty for
  // anyone else), so they aren't shareable — hide the share affordance.
  const isRecommendation = smartPlaylistType.startsWith('RECOMMENDED_');

  const [selectedBoard, setSelectedBoard] = useState<UserBoard | null>(() => findMatchingBoard(initialMyBoards));
  useClearPlaylistSuggestionSourceOnUnmount(queueActions);
  const { boards: myBoards, isLoading: boardsLoading } = useMyBoards(true, 50, initialMyBoards);
  // Mark SSR data fresh so react-query honours staleTime instead of triggering
  // an immediate refetch (initialDataUpdatedAt defaults to 0 = epoch).
  const ssrInitialUpdatedAtRef = useRef(initialSmartPlaylist ? Date.now() : 0);
  // Snapshot the key the SSR payload was fetched for. Without this gate, the
  // same initialData would be reused for every board-chip switch (and any
  // future key changes) instead of triggering a real fetch.
  const ssrSmartKeyRef = useRef({ boardUuid: selectedBoard?.uuid ?? null });
  // Single source of truth for "is the SSR payload still applicable to the
  // live query key?" — used to gate both `initialData` and
  // `initialDataUpdatedAt` so they can never disagree.
  const ssrSmartApplicable = ssrSeedMatchesQueryKey(!!initialSmartPlaylist, ssrSmartKeyRef.current, {
    boardUuid: selectedBoard?.uuid ?? null,
  });

  // Web injects its token-aware transport explicitly so token semantics match
  // the previous inline query (public-readable smart playlists still send the
  // header when signed in).
  const executeSmartPlaylistGraphQL = useMemo<Parameters<typeof useSmartPlaylist>[0]['executeGraphQL']>(
    () => (query, variables) => createGraphQLHttpClient(token).request(query, variables),
    [token],
  );

  const {
    query: smartPlaylistQuery,
    allClimbs: sharedAllClimbs,
    meta,
  } = useSmartPlaylist({
    smartPlaylistType,
    userId,
    boardUuid: selectedBoard?.uuid ?? null,
    ...(selectedBoard ? { boardName: selectedBoard.boardType } : {}),
    pageSize: 20,
    tokenLoading,
    // Only seed when the current query key still matches the tuple the SSR
    // payload was fetched for. Beyond the obvious first-render case this also
    // avoids re-applying stale SSR data if the user switches away from and back
    // to the default view much later.
    initialData: initialSmartPlaylist,
    initialDataApplicable: ssrSmartApplicable,
    initialDataUpdatedAt: ssrInitialUpdatedAtRef.current,
    executeGraphQL: executeSmartPlaylistGraphQL,
  });

  const { fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, isLoading, isError, refetch } =
    smartPlaylistQuery;

  // TYPE SEAM: the shared hook returns the structurally-wider queue `Climb`;
  // this screen (MultiboardClimbList, the activation adapter) uses web `Climb`.
  // Runtime objects are the same flattened GraphQL climbs, so cast once here.
  const allClimbs = sharedAllClimbs as unknown as Climb[];

  const boardTypes = useMemo(() => {
    const types = new Set<string>();
    for (const climb of allClimbs) {
      if (climb.boardType) types.add(climb.boardType);
    }
    return Array.from(types);
  }, [allClimbs]);

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const selectedBoardDetails = useMemo(
    () => (selectedBoard ? getUserBoardDetails(selectedBoard) : null),
    [selectedBoard],
  );

  const fetchSmartPlaylistClimbsForBoard = useCallback(
    async ({
      boardDetails,
      activatedClimbUuid,
      signal,
    }: {
      boardDetails: BoardDetails;
      angle: number;
      activatedClimbUuid: string;
      signal: AbortSignal;
    }): Promise<Climb[]> => {
      const client = createGraphQLHttpClient(token);

      return fetchPlaylistSuggestionClimbs({
        activatedClimbUuid,
        signal,
        fetchPage: async ({ page, pageSize, signal: requestSignal }) => {
          const response = await client.request<GetSmartPlaylistQueryResponse, GetSmartPlaylistQueryVariables>({
            document: GET_SMART_PLAYLIST,
            variables: {
              input: {
                type: smartPlaylistType,
                userId,
                boardName: boardDetails.board_name,
                page,
                pageSize,
              },
            },
            signal: requestSignal,
          });

          return {
            climbs: response.smartPlaylist.climbs as Climb[],
            hasMore: response.smartPlaylist.hasMore,
          };
        },
      });
    },
    [smartPlaylistType, token, userId],
  );

  const activateSmartPlaylistClimb = usePlaylistClimbActivation({
    queueActions,
    activeQueueBoardInfo,
    selectedBoardDetails,
    selectedBoard,
    fallbackBoardType: selectedBoard?.boardType,
    fallbackLayoutId: selectedBoard?.layoutId,
    sourceId: `smart:${smartPlaylistType}:${userId}`,
    allClimbs,
    fetchClimbsForBoard: fetchSmartPlaylistClimbsForBoard,
    refreshErrorMessage: 'Failed to refresh smart playlist suggestions:',
  });

  const playlistActivationValue = useMemo(
    () => ({ activatePlaylistClimb: activateSmartPlaylistClimb }),
    [activateSmartPlaylistClimb],
  );

  const handleShare = useCallback(async () => {
    const url = `${window.location.origin}/discover/${smartPlaylistSlug}/${encodeURIComponent(userId)}`;
    await shareWithFallback({
      url,
      title: t(preset.titleI18nKey),
      text: meta ? t('library.smart.shareText', { name: meta.userName }) : t(preset.titleI18nKey),
      trackingEvent: 'Smart Playlist Shared',
      trackingProps: { smartPlaylistType, userId },
      onClipboardSuccess: () => showMessage(t('detail.shareSuccess'), 'success'),
      onError: () => showMessage(t('detail.shareError'), 'error'),
    });
  }, [smartPlaylistSlug, smartPlaylistType, userId, t, meta, preset.titleI18nKey, showMessage]);

  // With SSR data we have meta + first page; skip the full-page spinner.
  // Only gate on tokenLoading when we don't have SSR-seeded content yet.
  if ((tokenLoading || isLoading) && !meta) {
    return (
      <div className={styles.loadingContainer}>
        <LoadingSpinner size={48} />
      </div>
    );
  }

  // Note: when SSR-seeded `initialData` is in play, react-query keeps the
  // overall query state as `success` even if a background refetch errors —
  // `isError` only flips when there's no `data` to fall back to. That means
  // a transient network blip after hydration leaves the SSR-rendered hero +
  // climbs on screen instead of replacing them with the error UI. This is
  // intentional resilience: same trade-off as `fetchPlaylist`'s catch block
  // in PlaylistDetailContent. The error UI here only fires on a true cold
  // failure (no SSR, no cache, refetch errored).
  if (isError || !meta) {
    return (
      <div className={styles.errorContainer}>
        <SentimentDissatisfiedOutlined className={styles.errorIcon} />
        <div className={styles.errorTitle}>{t('detail.errors.loadTitle')}</div>
        <div className={styles.errorMessage}>{t('detail.errors.loadDescription')}</div>
        <MuiButton variant="outlined" onClick={() => void refetch()}>
          {t('detail.errors.tryAgain')}
        </MuiButton>
      </div>
    );
  }

  const climbList =
    allClimbs.length === 0 && !isFetching ? (
      <EmptyState description={t('library.smart.empty')} />
    ) : (
      <MultiboardClimbList
        climbs={allClimbs}
        isFetching={isFetching}
        isLoading={isLoading}
        hasMore={hasNextPage ?? false}
        onLoadMore={handleLoadMore}
        showBoardFilter
        boardTypes={boardTypes}
        selectedBoard={selectedBoard}
        onBoardSelect={setSelectedBoard}
        boards={myBoards}
        boardsLoading={boardsLoading}
      />
    );

  return (
    <>
      <div className={styles.actionsSection}>
        <BackButton fallbackUrl="/playlists" />
      </div>

      <div className={styles.contentWrapper}>
        <div className={styles.heroSection}>
          <div className={styles.heroContent}>
            <div className={styles.heroSquare}>
              <PlaylistPreviewSquare
                boardType={selectedBoard?.boardType ?? 'kilter'}
                layoutId={selectedBoard?.layoutId ?? null}
                color={preset.color}
                icon={preset.icon}
              />
            </div>
            <div className={styles.heroInfo}>
              <Typography variant="h5" component="h1" className={`${styles.heroName} ${styles.heroNameWithShare}`}>
                {t(preset.titleI18nKey)}
              </Typography>
              <div className={styles.heroMeta}>
                <span className={styles.heroMetaItem}>{t('detail.climbCount', { count: meta.climbCount })}</span>
                <span className={styles.heroMetaItem}>
                  <LocaleLink href={`/profile/${meta.userId}`}>{meta.userName}</LocaleLink>
                </span>
              </div>
              <Typography variant="body2" className={styles.heroDescription}>
                {t(preset.descriptionI18nKey)}
              </Typography>
            </div>
          </div>

          {!isRecommendation && (
            <div className={styles.heroActions}>
              <IconButton onClick={handleShare} aria-label={t('detail.share')}>
                <IosShare />
              </IconButton>
            </div>
          )}
        </div>

        <div className={styles.climbsSection}>
          {queueActions ? (
            <PlaylistActivationProvider value={playlistActivationValue}>{climbList}</PlaylistActivationProvider>
          ) : (
            climbList
          )}
        </div>
      </div>
    </>
  );
}
