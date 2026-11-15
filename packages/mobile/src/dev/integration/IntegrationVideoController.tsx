import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router, useGlobalSearchParams, usePathname } from 'expo-router';
import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useTranslation } from 'react-i18next';
import { fetchAllMyBoards } from '../../lib/graphql/hooks';
import { useActiveBoard, useSetActiveBoard } from '../../lib/graphql/use-active-board';
import { INFINITE_SEARCH_CLIMBS_QUERY_KEY } from '../../lib/graphql/query-keys';
import {
  SEARCH_CLIMBS,
  type SearchClimbsQueryResponse,
  type SearchClimbsQueryVariables,
} from '../../lib/graphql/operations';
import { offlineAwareRequest } from '../../lib/graphql/offline-request';
import { toQueueClimbs } from '../../lib/climb-types';
import { usePlaylistActivation } from '../../lib/playlists/use-playlist-activation';
import { boardSelectors } from './config';
import { matchScreenshotBoardCandidates } from './screenshot-board-matching';
import { selectSmokeClimb } from './select-smoke-climb';
import { reportScreenshotSmokeError } from './screenshot-smoke';

type Command = { id: string; board: UserBoard; openFirst: boolean; slot: number | null };
type LoadedSearch = { input: SearchClimbsQueryVariables['input']; pages: SearchClimbsQueryResponse[] };
const first = (parameter: string | string[] | undefined) => (Array.isArray(parameter) ? parameter[0] : parameter);

async function reportCommand(id: string, state: 'ready' | 'error'): Promise<void> {
  const readyUrl = process.env.EXPO_PUBLIC_SCREENSHOT_READY_URL;
  if (!readyUrl) throw new Error('Recording signal server is missing');
  const response = await fetch(new URL(`/set/integration-${state}-${id}`, readyUrl));
  if (!response.ok) throw new Error('Recording signal delivery failed');
}

/** Real owned-board selection and list activation, kept entirely at the dev composition boundary. */
export function IntegrationVideoController() {
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ command?: string; boardIndex?: string; openFirst?: string }>();
  const { data: activeBoard } = useActiveBoard();
  const activateBoard = useSetActiveBoard();
  const queryClient = useQueryClient();
  const roster = useQuery({ queryKey: ['integrationOwnedBoards'], queryFn: fetchAllMyBoards, staleTime: Infinity });
  const consumed = useRef<string | null>(null);
  const [pending, setPending] = useState<Command | null>(null);
  const [loaded, setLoaded] = useState<LoadedSearch | null>(null);
  const commandId = first(params.command);
  const boardIndex = first(params.boardIndex);
  const openFirst = first(params.openFirst) === '1';
  const fail = useCallback((id: string, cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    reportScreenshotSmokeError(error);
    console.error(`[integration-video] error ${id} ${error.message}`);
    void reportCommand(id, 'error').catch(() => undefined);
    setPending(null);
    setLoaded(null);
  }, []);
  useEffect(() => {
    if (
      pathname !== '/dev/integration/video' ||
      !commandId ||
      consumed.current === commandId ||
      !roster.data ||
      !activeBoard
    )
      return;
    consumed.current = commandId;
    if (!/^[a-z0-9-]{1,40}$/.test(commandId)) {
      fail(commandId, new Error('Invalid recording command'));
      return;
    }
    let board = activeBoard;
    if (boardIndex !== undefined) {
      const slot = Number(boardIndex);
      const selector = Number.isInteger(slot) && slot >= 0 ? boardSelectors[slot] : undefined;
      const matches = selector ? matchScreenshotBoardCandidates(roster.data, selector) : [];
      if (matches.length !== 1) {
        fail(commandId, new Error(`Board slot ${boardIndex} must match exactly one owned board`));
        return;
      }
      board = matches[0];
    }
    const selected = board;
    void (async () => {
      if (selected.uuid !== activeBoard.uuid) await activateBoard(selected);
      if (consumed.current !== commandId) return;
      setLoaded(null);
      setPending({
        id: commandId,
        board: selected,
        openFirst,
        slot: boardIndex === undefined ? null : Number(boardIndex),
      });
      router.replace('/climbs');
    })().catch((error: unknown) => fail(commandId, error));
  }, [pathname, commandId, boardIndex, openFirst, roster.data, activeBoard, activateBoard, fail]);

  useEffect(() => {
    if (!pending) return;
    const timeout = setTimeout(() => fail(pending.id, new Error('Recording board/list did not become ready')), 60000);
    return () => clearTimeout(timeout);
  }, [pending, fail]);
  useEffect(() => {
    if (!pending || pathname !== '/climbs' || activeBoard?.uuid !== pending.board.uuid) return;
    const board = pending.board;
    const slot = pending.slot;
    if (slot !== null)
      console.log(
        `[screenshot] board[${slot}] "${boardSelectors[slot]}" -> ${board.name} (${board.layoutName ?? board.boardType} L${board.layoutId} S${board.sizeId} @${board.angle}°, ${board.boardType})`,
      );
    const cache = queryClient.getQueryCache();
    const inspect = () => {
      const candidates = cache
        .findAll({ queryKey: INFINITE_SEARCH_CLIMBS_QUERY_KEY, type: 'active' })
        .flatMap((query) => {
          if (query.state.status !== 'success' || query.state.fetchStatus !== 'idle') return [];
          const result = query.state.data as InfiniteData<SearchClimbsQueryResponse> | undefined;
          return result
            ? [{ input: query.queryKey[1], pages: result.pages, updatedAt: query.state.dataUpdatedAt }]
            : [];
        });
      const match = candidates.find((candidate) => selectSmokeClimb([candidate], board));
      if (!match) return;
      if (pending.openFirst)
        setLoaded({ input: match.input as SearchClimbsQueryVariables['input'], pages: match.pages });
      else
        void reportCommand(pending.id, 'ready')
          .then(() => setPending(null))
          .catch((error: unknown) => fail(pending.id, error));
    };
    const unsubscribe = cache.subscribe(inspect);
    inspect();
    return unsubscribe;
  }, [pending, pathname, activeBoard, queryClient, boardIndex, fail]);
  const complete = useCallback(() => {
    if (!pending) return;
    void reportCommand(pending.id, 'ready')
      .then(() => {
        setPending(null);
        setLoaded(null);
      })
      .catch((error: unknown) => fail(pending.id, error));
  }, [pending, fail]);
  return pending && loaded ? (
    <ActivateLoadedVideoClimb
      key={pending.id}
      search={loaded}
      onComplete={complete}
      onError={(error) => fail(pending.id, error)}
    />
  ) : null;
}

function ActivateLoadedVideoClimb({
  search,
  onComplete,
  onError,
}: {
  search: LoadedSearch;
  onComplete: () => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation('session');
  const climbs = useMemo(() => toQueueClimbs(search.pages.flatMap((page) => page.searchClimbs.climbs)), [search.pages]);
  const fetchPage = useCallback(
    async ({ page, pageSize }: { page: number; pageSize: number }) => {
      const response = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, {
        input: { ...search.input, page, pageSize },
      });
      return { climbs: toQueueClimbs(response.searchClimbs.climbs), hasMore: response.searchClimbs.hasMore };
    },
    [search.input],
  );
  const activation = usePlaylistActivation({
    sourceId: 'climblist',
    refreshErrorMessage: 'Recording list refresh failed:',
    allClimbs: climbs,
    fetchPage,
    loadedRowsArePages: true,
    label: t('playView.track.searchResults'),
  });
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !climbs[0]) return;
    started.current = true;
    void activation.activate(climbs[0]).then(onComplete).catch(onError);
  }, [activation, climbs, onComplete, onError]);
  return null;
}
