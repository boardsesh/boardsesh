// Mobile-side wiring for `@boardsesh/playlists-react`. Mirrors `board-adapter.tsx`:
// forwards every playlist GraphQL operation through mobile's authenticated HTTP
// client (`authenticatedFetch` attaches the bearer token), and wires the
// AsyncStorage-backed recents adapter so the pinned hook falls back to
// recently-opened playlists (like web) when nothing is pinned.
//
// Mounted in `app/_layout.tsx` inside QueryProvider (the data hooks use
// react-query) and near BoardAdapterWrapper / DrawerHostProvider.

import { useMemo, type ReactNode } from 'react';
import { randomUUID } from 'expo-crypto';
import { PlaylistsAdapterProvider, type PlaylistsAdapter } from '@boardsesh/playlists-react';
import { getHttpClient } from '../lib/graphql/client';
import { mobileRecentsAdapter } from '../lib/playlists/recents-store';
import { useAuth } from './auth-provider';
import { getDatabaseHandle } from '../db';
import {
  createPlaylistLocal,
  deletePlaylistLocal,
  getPlaylistClimbsLocal,
  getPlaylistLocal,
  getPlaylistsLocal,
  removeClimbFromPlaylistLocal,
  reorderPlaylistClimbLocal,
  updatePlaylistLocal,
} from '../hooks/use-offline-mutations';
import { useSetting } from '../settings';

export function PlaylistsAdapterWrapper({ children }: { children: ReactNode }) {
  const { accessCapabilities } = useAuth();
  const canUseLocalPlaylists = accessCapabilities.useLocalPlaylists;
  const [workOffline] = useSetting('workOffline');
  const accountWorkOffline =
    accessCapabilities.chooseLocalProfile && accessCapabilities.useAccountFeatures && workOffline;
  const useLocalPlaylistLibrary = canUseLocalPlaylists || accountWorkOffline;
  const localDelivery = accountWorkOffline ? 'account' : 'local-only';
  const adapter = useMemo<PlaylistsAdapter>(
    () => ({
      executeGraphQL: useLocalPlaylistLibrary
        ? async () => {
            throw new Error(
              accountWorkOffline
                ? 'Go online to use playlist sharing and follows'
                : 'Local playlists cannot use GraphQL',
            );
          }
        : (query, variables) => getHttpClient().request(query, variables),
      localLibrary: useLocalPlaylistLibrary
        ? {
            list: async (input) => {
              const db = getDatabaseHandle();
              if (!db) throw new Error('Local storage unavailable');
              const allPlaylists = (await getPlaylistsLocal(db)).filter(
                (playlist) =>
                  (input.boardType === undefined || playlist.boardType === input.boardType) &&
                  (input.layoutId === undefined || playlist.layoutId === input.layoutId),
              );
              const page = input.page ?? 0;
              const pageSize = input.pageSize ?? 20;
              const start = page * pageSize;
              return {
                playlists: allPlaylists.slice(start, start + pageSize),
                totalCount: allPlaylists.length,
                hasMore: start + pageSize < allPlaylists.length,
              };
            },
            get: async (playlistUuid) => {
              const db = getDatabaseHandle();
              if (!db) throw new Error('Local storage unavailable');
              return getPlaylistLocal(db, playlistUuid);
            },
            listClimbs: async (input) => {
              const db = getDatabaseHandle();
              if (!db) throw new Error('Local storage unavailable');
              return getPlaylistClimbsLocal(db, input);
            },
            create: async (input) => {
              const db = getDatabaseHandle();
              if (!db) throw new Error('Local storage unavailable');
              return createPlaylistLocal(db, input, input.uuid ?? randomUUID(), localDelivery);
            },
            update: async (input) => {
              const db = getDatabaseHandle();
              if (!db) throw new Error('Local storage unavailable');
              return updatePlaylistLocal(db, input, localDelivery);
            },
            delete: async (playlistUuid) => {
              const db = getDatabaseHandle();
              if (!db) throw new Error('Local storage unavailable');
              return deletePlaylistLocal(db, playlistUuid, localDelivery);
            },
            removeClimb: async (input) => {
              const db = getDatabaseHandle();
              if (!db) throw new Error('Local storage unavailable');
              return removeClimbFromPlaylistLocal(db, input, localDelivery);
            },
            reorderClimb: async (input) => {
              const db = getDatabaseHandle();
              if (!db) throw new Error('Local storage unavailable');
              return reorderPlaylistClimbLocal(db, input, localDelivery);
            },
          }
        : undefined,
      recents: mobileRecentsAdapter,
    }),
    [accountWorkOffline, localDelivery, useLocalPlaylistLibrary],
  );

  return <PlaylistsAdapterProvider value={adapter}>{children}</PlaylistsAdapterProvider>;
}
