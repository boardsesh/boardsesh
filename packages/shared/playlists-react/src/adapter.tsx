import { createContext, useContext, type ReactNode } from 'react';
import type { RecentsStorageAdapter } from './recents-adapter';

// HTTP transport for playlist queries. Query is a `string` since the `gql`
// template tag in `graphql-request` returns the source string at runtime —
// both platforms use that. TVars is constrained to `object` to match the
// graphql-request signature.
export type ExecutePlaylistsGraphQL = <TData, TVars extends object = Record<string, unknown>>(
  query: string,
  variables?: TVars,
) => Promise<TData>;

export type PlaylistsAdapter = {
  /**
   * Execute a playlist GraphQL query/mutation over HTTP. Web wires its
   * token-aware `executeGraphQL`; mobile wires its own authenticated client.
   * Individual hooks accept an `executeGraphQL` option to override this for
   * tests.
   */
  executeGraphQL: ExecutePlaylistsGraphQL;
  /** Local request refusals that should settle the pinned fallback without error logging. */
  isExpectedRequestError?: (error: unknown) => boolean;
  /** Per-device recently-opened-playlists storage (used by the pinned hook). */
  recents: RecentsStorageAdapter;
};

const PlaylistsAdapterContext = createContext<PlaylistsAdapter | undefined>(undefined);

export function PlaylistsAdapterProvider({ value, children }: { value: PlaylistsAdapter; children: ReactNode }) {
  return <PlaylistsAdapterContext.Provider value={value}>{children}</PlaylistsAdapterContext.Provider>;
}

export function usePlaylistsAdapter(): PlaylistsAdapter {
  const adapter = useOptionalPlaylistsAdapter();
  if (adapter === undefined) {
    throw new Error(
      'usePlaylistsAdapter must be used within a PlaylistsAdapterProvider. Mount the provider near the root of your app with platform-specific GraphQL + recents wiring.',
    );
  }
  return adapter;
}

/** Hooks with an explicit transport can run without the platform adapter. */
export function useOptionalPlaylistsAdapter(): PlaylistsAdapter | undefined {
  return useContext(PlaylistsAdapterContext);
}
