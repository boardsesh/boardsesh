import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  GET_USER_LOGGED_SETTERS,
  type GetUserLoggedSettersQueryResponse,
  type GetUserLoggedSettersQueryVariables,
} from '@boardsesh/graphql/operations/ticks';
import { getHttpClient } from '../client';

/**
 * One page of setters is enough for nearly every logbook. Each request walks the
 * climber's whole logbook through the feed's privacy rules, so the picker asks
 * once per board scope and filters that page on the device as the climber types.
 */
export const LOGGED_SETTERS_PAGE_LIMIT = 200;

/** Only a full first page can hide a setter, so only then does a search also go to the server. */
const SERVER_SEARCH_DEBOUNCE_MS = 300;
const LOGGED_SETTERS_STALE_TIME_MS = 5 * 60 * 1000;

export type LoggedSetter = GetUserLoggedSettersQueryResponse['userLoggedSetters'][number];

/** The board scope the picker lists setters for: the Logbook's own Board filter. */
export type LoggedSettersScope = { boardType: string; layoutIds: readonly number[] };

type LoggedSettersInput = NonNullable<GetUserLoggedSettersQueryVariables['input']>;

function scopeInput(scope: LoggedSettersScope): Pick<LoggedSettersInput, 'boardTypes' | 'layoutIds'> {
  if (!scope.boardType) return {};
  return {
    boardTypes: [scope.boardType],
    ...(scope.layoutIds.length > 0 ? { layoutIds: [...scope.layoutIds] } : {}),
  };
}

async function fetchLoggedSetters(userId: string, input: LoggedSettersInput): Promise<LoggedSetter[]> {
  const response = await getHttpClient().request<GetUserLoggedSettersQueryResponse, GetUserLoggedSettersQueryVariables>(
    GET_USER_LOGGED_SETTERS,
    { userId, input },
  );
  return response.userLoggedSetters;
}

/** Union by username, most-logged first then A–Z, the order the server returns. */
function mergeSetters(
  localMatches: LoggedSetter[] | undefined,
  serverMatches: LoggedSetter[] | undefined,
): LoggedSetter[] | undefined {
  if (!serverMatches) return localMatches;
  const byUsername = new Map<string, LoggedSetter>();
  for (const setter of localMatches ?? []) byUsername.set(setter.setterUsername, setter);
  for (const setter of serverMatches) byUsername.set(setter.setterUsername, setter);
  return [...byUsername.values()].sort(
    (left, right) => right.tickCount - left.tickCount || left.setterUsername.localeCompare(right.setterUsername),
  );
}

function useDebouncedValue<Value>(value: Value, delayMs: number): Value {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Setters of the climbs in a climber's logbook, most-logged first, narrowed by
 * `search` (case-insensitive, matched anywhere in the name).
 *
 * The first page (up to {@link LOGGED_SETTERS_PAGE_LIMIT}) is fetched once per
 * user and board scope and filtered locally. When that page came back full, a
 * search also runs on the server (debounced) and its results are merged with the
 * local matches: the setter the climber wants may rank past the first page even
 * when a longer name containing the same letters is on it.
 */
export function useUserLoggedSetters(userId: string | undefined, scope: LoggedSettersScope, search: string) {
  // The scope arrives as a fresh object from route params; key on its contents.
  const { boardType } = scope;
  const layoutKey = scope.layoutIds.join(',');
  const baseInput = useMemo(() => {
    const layoutIds = layoutKey ? layoutKey.split(',').map(Number) : [];
    return { ...scopeInput({ boardType, layoutIds }), limit: LOGGED_SETTERS_PAGE_LIMIT };
  }, [boardType, layoutKey]);
  const firstPage = useQuery({
    queryKey: ['userLoggedSetters', userId, baseInput],
    queryFn: () => fetchLoggedSetters(userId as string, baseInput),
    enabled: !!userId,
    staleTime: LOGGED_SETTERS_STALE_TIME_MS,
  });

  const normalizedSearch = search.trim().toLowerCase();
  const localMatches = useMemo(() => {
    if (!firstPage.data) return undefined;
    if (!normalizedSearch) return firstPage.data;
    return firstPage.data.filter((setter) => setter.setterUsername.toLowerCase().includes(normalizedSearch));
  }, [firstPage.data, normalizedSearch]);

  const firstPageFull = (firstPage.data?.length ?? 0) >= LOGGED_SETTERS_PAGE_LIMIT;
  const wantsServerSearch = firstPageFull && normalizedSearch.length > 0;
  const serverSearch = useDebouncedValue(wantsServerSearch ? normalizedSearch : '', SERVER_SEARCH_DEBOUNCE_MS);
  const serverSearchInput = useMemo(() => ({ ...baseInput, search: serverSearch }), [baseInput, serverSearch]);
  const searchPage = useQuery({
    queryKey: ['userLoggedSetters', userId, serverSearchInput],
    queryFn: () => fetchLoggedSetters(userId as string, serverSearchInput),
    enabled: !!userId && wantsServerSearch && serverSearch.length > 0,
    staleTime: LOGGED_SETTERS_STALE_TIME_MS,
  });

  const awaitingServer = wantsServerSearch && (serverSearch !== normalizedSearch || searchPage.isPending);
  const serverMatches = wantsServerSearch && !awaitingServer ? searchPage.data : undefined;
  const setters = useMemo(() => mergeSetters(localMatches, serverMatches), [localMatches, serverMatches]);
  const hasLocalMatches = (localMatches?.length ?? 0) > 0;
  return {
    // Local matches show at once; while the server search waits out its debounce
    // or loads with nothing local to show, say "loading" rather than "No matches".
    setters: awaitingServer && !hasLocalMatches ? undefined : setters,
    isLoading: firstPage.isPending || (awaitingServer && !hasLocalMatches),
    isError: firstPage.isError || (wantsServerSearch && searchPage.isError && !hasLocalMatches),
    refetch: () => {
      void firstPage.refetch();
      if (wantsServerSearch) void searchPage.refetch();
    },
  };
}
