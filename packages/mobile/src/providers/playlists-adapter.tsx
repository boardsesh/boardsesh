// Mobile-side wiring for `@boardsesh/playlists-react`. Mirrors `board-adapter.tsx`:
// forwards every playlist GraphQL operation through mobile's authenticated HTTP
// client (`authenticatedFetch` attaches the bearer token), and wires the
// AsyncStorage-backed recents adapter so the pinned hook falls back to
// recently-opened playlists (like web) when nothing is pinned.
//
// Mounted in `app/_layout.tsx` inside QueryProvider (the data hooks use
// react-query) and near BoardAdapterWrapper / DrawerHostProvider.

import { useMemo, type ReactNode } from 'react';
import { PlaylistsAdapterProvider, type PlaylistsAdapter } from '@boardsesh/playlists-react';
import { isBackendUnavailableError } from '../lib/connectivity/backend-unavailable-error';
import { offlineAwareRequest } from '../lib/graphql/offline-request';
import { mobileRecentsAdapter } from '../lib/playlists/recents-store';
import { GET_PLAYLIST_CLIMBS, GET_SMART_PLAYLIST } from '@boardsesh/graphql/operations';
import { stampCatalogPlaysScope } from '../lib/climb-play-count';
import { getCredentialGeneration } from '../lib/privacy/privacy-cache';

export function PlaylistsAdapterWrapper({ children }: { children: ReactNode }) {
  const adapter = useMemo<PlaylistsAdapter>(
    () => ({
      async executeGraphQL<TData, TVars extends object>(query: string, variables?: TVars): Promise<TData> {
        const credentialScope = getCredentialGeneration();
        const response = await offlineAwareRequest<TData>(query, variables);
        const scope = { credentialScope, authority: 'reference' } as const;
        if (query === GET_PLAYLIST_CLIMBS) return stampCatalogPlaysScope(response, 'playlistClimbs', scope);
        if (query === GET_SMART_PLAYLIST) return stampCatalogPlaysScope(response, 'smartPlaylist', scope);
        return response;
      },
      isExpectedRequestError: isBackendUnavailableError,
      recents: mobileRecentsAdapter,
    }),
    [],
  );

  return <PlaylistsAdapterProvider value={adapter}>{children}</PlaylistsAdapterProvider>;
}
