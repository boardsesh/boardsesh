import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GET_MY_PINNED_PLAYLISTS,
  type GetMyPinnedPlaylistsQueryResponse,
  type GetMyPinnedPlaylistsQueryVariables,
  type Playlist,
} from '@boardsesh/graphql/operations/playlists';
import { usePlaylistsAdapter, type ExecutePlaylistsGraphQL } from './adapter';
import type { RecentPlaylistEntry, RecentsStorageAdapter } from './recents-adapter';

export type UsePinnedPlaylistsOptions = {
  /** Auth token (when null, server-side pinned is skipped). */
  token: string | null;
  /** Optional board filter. Re-fetches when changed. */
  boardType?: string;
  /** Optional layout filter. Re-fetches when changed. */
  layoutId?: number;
  /** Pool of full playlist records to intersect against the recents fallback.
   *  Without this, recents would only have uuids and couldn't render full
   *  card data. */
  candidatePlaylists: Playlist[];
  /** Override the adapter's `executeGraphQL` (used in tests). */
  executeGraphQL?: ExecutePlaylistsGraphQL;
  /** Override the adapter's recents storage (used in tests). */
  recents?: RecentsStorageAdapter;
};

export type PinnedSource = 'pinned' | 'recent' | 'empty';

type PlaylistRequestScope = {
  token: string | null;
  boardType?: string;
  layoutId?: number;
  executeGraphQL: ExecutePlaylistsGraphQL;
  recentsAdapter: RecentsStorageAdapter;
};

type ScopedPlaylistEntries<Entry> = {
  scope: PlaylistRequestScope;
  entries: Entry[];
  isLoading: boolean;
};

const EMPTY_PLAYLISTS: Playlist[] = [];
const EMPTY_RECENTS: RecentPlaylistEntry[] = [];

export type UsePinnedPlaylistsResult = {
  pinned: Playlist[];
  source: PinnedSource;
  isLoading: boolean;
  refetch: () => void;
};

/**
 * Resolve the playlists shown in the small "Pinned" grid.
 *
 * Server-side pin state is the source of truth. When the user has not pinned
 * anything, fall back to the per-device list of recently-opened playlists,
 * intersected with whatever rows the screen has already loaded (so we have
 * full card data to render).
 *
 * Subscribes to the recents adapter's change notifier so the section refreshes
 * when the user opens a playlist elsewhere and returns to the library.
 */
export function usePinnedPlaylists({
  token,
  boardType,
  layoutId,
  candidatePlaylists,
  executeGraphQL: executeGraphQLOverride,
  recents: recentsOverride,
}: UsePinnedPlaylistsOptions): UsePinnedPlaylistsResult {
  const adapter = usePlaylistsAdapter();
  const executeGraphQL = executeGraphQLOverride ?? adapter.executeGraphQL;
  const recentsAdapter = recentsOverride ?? adapter.recents;

  // Keep results tagged with their request context so a render for another
  // account or board never displays the previous scope while effects catch up.
  const requestScope = useMemo<PlaylistRequestScope>(
    () => ({ token, boardType, layoutId, executeGraphQL, recentsAdapter }),
    [token, boardType, layoutId, executeGraphQL, recentsAdapter],
  );
  const activeScopeRef = useRef<PlaylistRequestScope | null>(null);
  // Pins and recents run independently. A refresh of one must neither revive
  // an older response nor invalidate the other stream's current request.
  const pinnedRequestIdRef = useRef(0);
  const recentsRequestIdRef = useRef(0);
  const [pinnedState, setPinnedState] = useState<ScopedPlaylistEntries<Playlist>>({
    scope: requestScope,
    entries: [],
    isLoading: true,
  });
  const [recentsState, setRecentsState] = useState<ScopedPlaylistEntries<RecentPlaylistEntry>>({
    scope: requestScope,
    entries: [],
    isLoading: true,
  });

  const fetchPinned = useCallback(async () => {
    if (activeScopeRef.current !== requestScope) return;
    const requestId = ++pinnedRequestIdRef.current;
    const isCurrentRequest = () => activeScopeRef.current === requestScope && pinnedRequestIdRef.current === requestId;
    if (!requestScope.token) {
      setPinnedState({ scope: requestScope, entries: [], isLoading: false });
      return;
    }
    setPinnedState((previous) => ({
      scope: requestScope,
      entries: previous.scope === requestScope ? previous.entries : [],
      isLoading: true,
    }));
    try {
      const variables: GetMyPinnedPlaylistsQueryVariables = {
        input: { boardType: requestScope.boardType, layoutId: requestScope.layoutId },
      };
      const response = await requestScope.executeGraphQL<
        GetMyPinnedPlaylistsQueryResponse,
        GetMyPinnedPlaylistsQueryVariables
      >(GET_MY_PINNED_PLAYLISTS, variables);
      if (!isCurrentRequest()) return;
      setPinnedState({ scope: requestScope, entries: response.myPinnedPlaylists, isLoading: false });
    } catch (err: unknown) {
      if (!isCurrentRequest()) return;
      console.error('Failed to fetch pinned playlists:', err);
      setPinnedState({ scope: requestScope, entries: [], isLoading: false });
    }
  }, [requestScope]);

  const fetchRecents = useCallback(async () => {
    if (activeScopeRef.current !== requestScope) return;
    const requestId = ++recentsRequestIdRef.current;
    const isCurrentRequest = () => activeScopeRef.current === requestScope && recentsRequestIdRef.current === requestId;
    setRecentsState((previous) => ({
      scope: requestScope,
      entries: previous.scope === requestScope ? previous.entries : [],
      isLoading: true,
    }));
    try {
      const recentPlaylists = await requestScope.recentsAdapter.getRecentPlaylists();
      if (!isCurrentRequest()) return;
      setRecentsState({ scope: requestScope, entries: recentPlaylists, isLoading: false });
    } catch (err: unknown) {
      if (!isCurrentRequest()) return;
      console.error('Failed to fetch recent playlists:', err);
      setRecentsState({ scope: requestScope, entries: [], isLoading: false });
    }
  }, [requestScope]);

  useEffect(() => {
    activeScopeRef.current = requestScope;
    void fetchPinned();
    void fetchRecents();
    return () => {
      activeScopeRef.current = null;
      pinnedRequestIdRef.current += 1;
      recentsRequestIdRef.current += 1;
    };
  }, [requestScope, fetchPinned, fetchRecents]);

  const pinned = pinnedState.scope === requestScope ? pinnedState.entries : EMPTY_PLAYLISTS;
  const recents = recentsState.scope === requestScope ? recentsState.entries : EMPTY_RECENTS;
  const isLoading =
    pinnedState.scope !== requestScope ||
    recentsState.scope !== requestScope ||
    pinnedState.isLoading ||
    recentsState.isLoading;

  // Refresh recents when other tabs / screens record opens.
  useEffect(() => {
    const handler = () => {
      void fetchRecents();
    };
    const unsubscribe = recentsAdapter.subscribe?.(handler);
    return unsubscribe;
  }, [recentsAdapter, fetchRecents]);

  const { result, source } = useMemo<{ result: Playlist[]; source: PinnedSource }>(() => {
    if (pinned.length > 0) {
      return { result: pinned, source: 'pinned' };
    }
    if (recents.length === 0 || candidatePlaylists.length === 0) {
      return { result: [], source: 'empty' };
    }
    // Intersect recents (uuid + board metadata) with the loaded playlist rows
    // so we have full data to render. Filter by the active board filter so the
    // pinned section matches the rest of the screen.
    const byUuid = new Map(candidatePlaylists.map((playlist) => [playlist.uuid, playlist]));
    const recentMatches: Playlist[] = [];
    for (const entry of recents) {
      if (boardType && entry.boardType !== boardType) continue;
      if (layoutId != null && entry.layoutId != null && entry.layoutId !== layoutId) continue;
      const match = byUuid.get(entry.uuid);
      if (match) recentMatches.push(match);
    }
    return recentMatches.length > 0 ? { result: recentMatches, source: 'recent' } : { result: [], source: 'empty' };
  }, [pinned, recents, candidatePlaylists, boardType, layoutId]);

  return { pinned: result, source, isLoading, refetch: fetchPinned };
}
