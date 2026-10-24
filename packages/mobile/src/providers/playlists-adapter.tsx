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
import { offlineAwareRequest } from '../lib/graphql/offline-request';
import { mobileRecentsAdapter } from '../lib/playlists/recents-store';

export function PlaylistsAdapterWrapper({ children }: { children: ReactNode }) {
  const adapter = useMemo<PlaylistsAdapter>(
    () => ({
      executeGraphQL: (query, variables) => offlineAwareRequest(query, variables),
      recents: mobileRecentsAdapter,
    }),
    [],
  );

  return <PlaylistsAdapterProvider value={adapter}>{children}</PlaylistsAdapterProvider>;
}
