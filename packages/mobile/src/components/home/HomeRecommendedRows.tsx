import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import type { Climb } from '@boardsesh/queue';
import {
  usePlaylistClimbs,
  useSmartPlaylist,
  useRecommendedPlaylists,
  type PlaylistClimbsBoardInput,
} from '@boardsesh/playlists-react';
import {
  GET_PLAYLIST_CLIMBS,
  GET_SMART_PLAYLIST,
  type DiscoverablePlaylist,
  type GetPlaylistClimbsInput,
  type GetPlaylistClimbsQueryResponse,
  type GetSmartPlaylistInput,
  type GetSmartPlaylistQueryResponse,
} from '@boardsesh/graphql/operations/playlists';
import { SEARCH_CLIMBS, type SearchClimbsQueryResponse } from '../../lib/graphql/operations';
import { useInfiniteSearchClimbs } from '../../lib/graphql/hooks/use-infinite-search-climbs';
import { usePlaylistActivation } from '../../lib/playlists/use-playlist-activation';
import { toQueueClimbs } from '../../lib/climb-types';
import { getHttpClient } from '../../lib/graphql/client';
import { HomeClimbRow, type HomeRowBoard } from './HomeClimbRow';

const REFRESH_ERROR = 'Failed to refresh recommended climbs:';
const ROW_PAGE_SIZE = 12;
const SEARCH_STALE_TIME = 5 * 60 * 1000;

/** Per-page fetch args the activation hook passes to refresh the swipe list. */
type RowFetchArgs = {
  page: number;
  pageSize: number;
  board: { boardName: string; layoutId: number; sizeId: number; setIds: string; angle: number };
  signal: AbortSignal;
};

export type HomeRecommendedRowsProps = {
  board: HomeRowBoard;
  /** Active board uuid — scopes query keys and the owned-board AT_LEVEL target. */
  boardUuid: string;
  /** Whether the user owns the active board (gates the personalized row). */
  isOwned: boolean;
  /** Authenticated user id, or null when signed out. */
  userId: string | null;
};

/** Section title from a generated cohort name ("Crowd Favorites · …" → "Crowd Favorites"). */
function cohortTitle(name: string): string {
  const separator = name.indexOf(' · ');
  return separator > 0 ? name.slice(0, separator) : name;
}

/**
 * The curated/recommended climb rows for Home. Prefers the board's public
 * recommendation cohorts (Crowd Favorites / Hidden Gems / Fresh); when the
 * board config has no generated cohort, falls back to popularity/quality/recency
 * sorts of the catalog. Adds a personalized "At your level" row for signed-in
 * board owners.
 */
export function HomeRecommendedRows({ board, boardUuid, isOwned, userId }: HomeRecommendedRowsProps) {
  const { t } = useTranslation('playlists');
  const { playlists: cohorts, isLoading } = useRecommendedPlaylists({
    boardType: board.boardName,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    angle: board.angle,
  });

  return (
    <>
      {isLoading ? null : cohorts.length > 0 ? (
        cohorts.map((playlist) => (
          <HomeCohortRow key={playlist.uuid} playlist={playlist} board={board} boardUuid={boardUuid} />
        ))
      ) : (
        <>
          <HomeSearchRow board={board} sortBy="ascents" title={t('home.popular')} />
          <HomeSearchRow board={board} sortBy="quality" title={t('home.topRated')} />
          <HomeSearchRow board={board} sortBy="creation" title={t('home.fresh')} />
        </>
      )}
      {isOwned && userId ? (
        <HomeAtLevelRow board={board} boardUuid={boardUuid} userId={userId} title={t('home.atLevel')} />
      ) : null}
    </>
  );
}

/** A cohort playlist rendered as a horizontal climb row. */
function HomeCohortRow({
  playlist,
  board,
  boardUuid,
}: {
  playlist: DiscoverablePlaylist;
  board: HomeRowBoard;
  boardUuid: string;
}) {
  const boardInput = useMemo<PlaylistClimbsBoardInput>(
    () => ({
      boardName: board.boardName,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: board.setIds,
      angle: board.angle,
    }),
    [board.boardName, board.layoutId, board.sizeId, board.setIds, board.angle],
  );

  const { allClimbs, query } = usePlaylistClimbs({
    playlistUuid: playlist.uuid,
    boardUuid,
    boardInput,
    pageSize: ROW_PAGE_SIZE,
  });

  const fetchPage = useCallback(
    async ({ page, pageSize, board: target }: RowFetchArgs) => {
      const input: GetPlaylistClimbsInput = {
        playlistId: playlist.uuid,
        page,
        pageSize,
        boardName: target.boardName,
        layoutId: target.layoutId,
        sizeId: target.sizeId,
        setIds: target.setIds,
        angle: target.angle,
      };
      const response = await getHttpClient().request<GetPlaylistClimbsQueryResponse>(GET_PLAYLIST_CLIMBS, { input });
      return { climbs: toQueueClimbs(response.playlistClimbs.climbs), hasMore: response.playlistClimbs.hasMore };
    },
    [playlist.uuid],
  );

  const activate = usePlaylistActivation({
    sourceId: `home:cohort:${playlist.uuid}`,
    allClimbs,
    fetchPage,
    refreshErrorMessage: REFRESH_ERROR,
  });

  return (
    <HomeClimbRow
      title={cohortTitle(playlist.name)}
      climbs={allClimbs}
      board={board}
      onPressClimb={(climb: Climb) => void activate(climb)}
      loading={query.isLoading}
    />
  );
}

/** A catalog sort (popular / top-rated / fresh) rendered as a horizontal row. */
function HomeSearchRow({ board, sortBy, title }: { board: HomeRowBoard; sortBy: string; title: string }) {
  const baseInput = useMemo<ClimbSearchInput>(
    () => ({
      boardName: board.boardName,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: board.setIds,
      angle: board.angle,
      sortBy,
      sortOrder: 'desc',
      pageSize: ROW_PAGE_SIZE,
    }),
    [board.boardName, board.layoutId, board.sizeId, board.setIds, board.angle, sortBy],
  );

  const query = useInfiniteSearchClimbs(baseInput, true, { staleTime: SEARCH_STALE_TIME });
  const climbs = useMemo(() => toQueueClimbs(query.data?.pages.flatMap((page) => page.climbs) ?? []), [query.data]);

  const fetchPage = useCallback(
    async ({ page, pageSize, board: target }: RowFetchArgs) => {
      const input: ClimbSearchInput = {
        boardName: target.boardName,
        layoutId: target.layoutId,
        sizeId: target.sizeId,
        setIds: target.setIds,
        angle: target.angle,
        sortBy,
        sortOrder: 'desc',
        page,
        pageSize,
      };
      const response = await getHttpClient().request<SearchClimbsQueryResponse>(SEARCH_CLIMBS, { input });
      return { climbs: toQueueClimbs(response.searchClimbs.climbs), hasMore: response.searchClimbs.hasMore };
    },
    [sortBy],
  );

  const activate = usePlaylistActivation({
    sourceId: `home:search:${sortBy}:${board.boardName}:${board.layoutId}:${board.sizeId}:${board.angle}`,
    allClimbs: climbs,
    fetchPage,
    refreshErrorMessage: REFRESH_ERROR,
  });

  return (
    <HomeClimbRow
      title={title}
      climbs={climbs}
      board={board}
      onPressClimb={(climb: Climb) => void activate(climb)}
      loading={query.isLoading}
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
      }}
      isLoadingMore={query.isFetchingNextPage}
    />
  );
}

/** Personalized "At your level" row — owner-private, board-targeted. */
function HomeAtLevelRow({
  board,
  boardUuid,
  userId,
  title,
}: {
  board: HomeRowBoard;
  boardUuid: string;
  userId: string;
  title: string;
}) {
  const { allClimbs, query } = useSmartPlaylist({
    smartPlaylistType: 'RECOMMENDED_AT_LEVEL',
    userId,
    boardUuid,
    pageSize: ROW_PAGE_SIZE,
  });

  const fetchPage = useCallback(
    async ({ page, pageSize, board: target }: RowFetchArgs) => {
      const input: GetSmartPlaylistInput = {
        type: 'RECOMMENDED_AT_LEVEL',
        userId,
        boardUuid,
        boardName: target.boardName,
        page,
        pageSize,
      };
      const response = await getHttpClient().request<GetSmartPlaylistQueryResponse>(GET_SMART_PLAYLIST, { input });
      return { climbs: toQueueClimbs(response.smartPlaylist.climbs), hasMore: response.smartPlaylist.hasMore };
    },
    [userId, boardUuid],
  );

  const activate = usePlaylistActivation({
    sourceId: `home:atlevel:${boardUuid}:${userId}`,
    allClimbs,
    fetchPage,
    refreshErrorMessage: REFRESH_ERROR,
  });

  return (
    <HomeClimbRow
      title={title}
      climbs={allClimbs}
      board={board}
      onPressClimb={(climb: Climb) => void activate(climb)}
      loading={query.isLoading}
    />
  );
}
