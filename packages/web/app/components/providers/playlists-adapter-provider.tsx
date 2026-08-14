'use client';

import React, { useMemo, useRef } from 'react';
import {
  PlaylistsAdapterProvider as SharedPlaylistsAdapterProvider,
  type ExecutePlaylistsGraphQL,
  type PlaylistsAdapter,
} from '@boardsesh/playlists-react';
import { executeGraphQL } from '@/app/lib/graphql/client';
import { webRecentsAdapter } from '@/app/lib/recent-playlists-adapter';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';

/**
 * Web wiring for the shared `@boardsesh/playlists-react` adapter.
 *
 * The package's data hooks read their GraphQL transport + recents storage from
 * `usePlaylistsAdapter()`. This provider supplies the web implementations:
 *  - `executeGraphQL` delegates to web's token-aware `executeGraphQL`, reading
 *    the *current* WS auth token through a ref so the transport identity stays
 *    stable across token refreshes (no remount of the consuming hooks) while
 *    every request still carries the latest token.
 *  - `recents` wraps `recent-playlists-db` (IndexedDB + the
 *    `RECENT_PLAYLISTS_CHANGED_EVENT` window event) for the pinned-playlists
 *    fallback.
 *
 * Mounted once at the app root so every playlist surface shares the same
 * wiring: /playlists, /playlists/[uuid], and the queue-control paths that
 * activate a playlist. Nothing under /discover reads it any more. The
 * smart-playlist route it used to serve is gone (W-13a) and only
 * `app/discover/layout.tsx` is left standing there.
 *
 * The standalone web wrapper hooks still pass explicit
 * `executeGraphQL`/`recents` overrides so their unit tests can run without this
 * provider; this provider is what keeps the package's unconditional
 * `usePlaylistsAdapter()` call satisfied in the app.
 */
export default function PlaylistsAdapterProvider({ children }: { children: React.ReactNode }) {
  const { token } = useWsAuthToken();

  // Hold the current token in a ref so `executeGraphQL` keeps a stable identity
  // (it's a useMemo with no deps) yet always reads the freshest token at call
  // time. This mirrors today's behaviour where each request is built from the
  // token in scope at call time, without churning the adapter on every refresh.
  const tokenRef = useRef<string | null>(token);
  tokenRef.current = token;

  const adapter = useMemo<PlaylistsAdapter>(() => {
    const executePlaylistsGraphQL: ExecutePlaylistsGraphQL = (query, variables) =>
      executeGraphQL(query, variables, tokenRef.current);
    return {
      executeGraphQL: executePlaylistsGraphQL,
      recents: webRecentsAdapter,
    };
  }, []);

  return <SharedPlaylistsAdapterProvider value={adapter}>{children}</SharedPlaylistsAdapterProvider>;
}
