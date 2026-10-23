import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  GET_PLAYLIST_SETTERS,
  type GetPlaylistSettersQueryResponse,
  type PlaylistSetter,
  type PlaylistSettersInput,
  type SmartPlaylistType,
} from '@boardsesh/graphql/operations/playlists';
import { usePlaylistsAdapter, type ExecutePlaylistsGraphQL } from './adapter';

/**
 * The list whose setters a picker shows (#6651): a user playlist, or one of the
 * logbook smart lists (Liked, Five Stars, Projects, Most repeated). Either way
 * the rows are the ones the list screen shows without a view, across every
 * board: the screen asks for its climbs with no board fields, so the setters
 * are asked for with none either, and the counts match the list.
 */
export type PlaylistSetterSource =
  | { kind: 'playlist'; playlistId: string }
  | { kind: 'smart'; smartType: SmartPlaylistType; userId: string };

/**
 * The most setters one `playlistSetters` answer holds, most climbs first. Mirrors
 * `PLAYLIST_SETTERS_LIMIT` in the backend's validation schemas. An answer this
 * long may be cut short, so a name search then asks the server, which searches
 * every setter.
 */
export const PLAYLIST_SETTERS_ANSWER_LIMIT = 200;

/** The longest search the server takes (`search: max(100)` in the backend's validation schemas). */
const PLAYLIST_SETTERS_SEARCH_MAX_LENGTH = 100;

/**
 * The query key one source's setters are cached under. Every key starts with
 * the playlist's id (or the smart list's type and owner), so
 * `invalidateQueries({ queryKey: ['playlistSetters', playlistUuid] })` drops
 * every search of that playlist, as the editor does once climbs move.
 */
export function playlistSettersQueryKey(source: PlaylistSetterSource, search: string) {
  return source.kind === 'playlist'
    ? (['playlistSetters', source.playlistId, search] as const)
    : (['playlistSetters', 'smart', source.smartType, source.userId, search] as const);
}

/**
 * The request for one source, built field by field from `PlaylistSettersInput`:
 * a user playlist by id, a smart list by type and owner, and the search only
 * when there is one. Never a list screen's own input: that one carries angle and
 * active-board fields this query does not take.
 */
export function playlistSettersInput(source: PlaylistSetterSource, search: string): PlaylistSettersInput {
  const listInput: PlaylistSettersInput =
    source.kind === 'playlist'
      ? { playlistId: source.playlistId }
      : { smartType: source.smartType, userId: source.userId };
  return search.length > 0 ? { ...listInput, search } : listInput;
}

function namesAList(source: PlaylistSetterSource): boolean {
  return source.kind === 'playlist' ? source.playlistId.length > 0 : source.userId.length > 0;
}

/** The server's search rule on the device: the username starts with the search, ignoring case. */
function setterNameStartsWith(setter: PlaylistSetter, search: string): boolean {
  return setter.username.toLowerCase().startsWith(search.toLowerCase());
}

export type UsePlaylistSettersOptions = {
  source: PlaylistSetterSource;
  /** What the climber typed, already debounced. Empty for every setter. */
  search?: string;
  /** Override the adapter's `executeGraphQL` (used in tests). */
  executeGraphQL?: ExecutePlaylistsGraphQL;
};

export type UsePlaylistSettersResult = {
  /** The setters matching the search, most climbs first; undefined until the first answer. */
  setters: PlaylistSetter[] | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
};

/**
 * The setters of a list's climbs for the setter picker in its filter sheet.
 *
 * One request lists them all, and a typed name filters that answer on the
 * device, at once and without another request. Only when the answer came back
 * full (`PLAYLIST_SETTERS_ANSWER_LIMIT`), so setters may be missing from it, does
 * a name go to the server, which searches every setter. While that search loads
 * the device's own filter stands in, so the list never flashes empty or full.
 */
export function usePlaylistSetters({
  source,
  search = '',
  executeGraphQL: executeGraphQLOverride,
}: UsePlaylistSettersOptions): UsePlaylistSettersResult {
  const adapter = usePlaylistsAdapter();
  const executeGraphQL = executeGraphQLOverride ?? adapter.executeGraphQL;
  const enabled = namesAList(source);
  const trimmedSearch = search.trim();

  const fetchSetters = (searchText: string) => async () => {
    const response = await executeGraphQL<GetPlaylistSettersQueryResponse, { input: PlaylistSettersInput }>(
      GET_PLAYLIST_SETTERS,
      { input: playlistSettersInput(source, searchText) },
    );
    return response.playlistSetters;
  };

  const everySetter = useQuery({
    queryKey: playlistSettersQueryKey(source, ''),
    queryFn: fetchSetters(''),
    enabled,
    staleTime: 60 * 1000,
  });
  const answerMayBeCut = (everySetter.data?.length ?? 0) >= PLAYLIST_SETTERS_ANSWER_LIMIT;
  const serverSearch = answerMayBeCut ? trimmedSearch.slice(0, PLAYLIST_SETTERS_SEARCH_MAX_LENGTH) : '';
  const searchedSetters = useQuery({
    queryKey: playlistSettersQueryKey(source, serverSearch),
    queryFn: fetchSetters(serverSearch),
    enabled: enabled && serverSearch.length > 0,
    staleTime: 60 * 1000,
  });

  const searchesServer = serverSearch.length > 0;
  // The server's answer once it is in; until then the names already here,
  // filtered by the same rule, so the list never shows setters the search drops.
  const serverAnswerIsCurrent = searchedSetters.data !== undefined;
  const setters = useMemo(() => {
    if (searchesServer && serverAnswerIsCurrent) return searchedSetters.data;
    if (!everySetter.data || trimmedSearch.length === 0) return everySetter.data;
    return everySetter.data.filter((setter) => setterNameStartsWith(setter, trimmedSearch));
  }, [searchesServer, serverAnswerIsCurrent, searchedSetters.data, everySetter.data, trimmedSearch]);

  const activeQuery = searchesServer ? searchedSetters : everySetter;
  const { refetch: refetchActive } = activeQuery;
  const refetch = useCallback(() => void refetchActive(), [refetchActive]);
  return { setters, isLoading: everySetter.isLoading, isError: activeQuery.isError, refetch };
}
