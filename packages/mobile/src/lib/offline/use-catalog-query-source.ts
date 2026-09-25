// Where an expensive catalogue read (similar climbs, later the hold heatmap)
// gets its answer for one board scope.
//
// Those server resolvers scan every hold row of a layout, so the server serves
// them to admins only. Everyone else reads the downloaded board on the phone,
// and a board that is not downloaded gets an offer to download it — never a
// network call that would come back as an auth error.
//
// The `local` predicate is the one `isBoardDownloadedLocally` (the
// `offlineAwareRequest` registration's `canServeLocal`) applies before its row
// probe: the scope is enabled in `syncEnabledBoards` AND has a completed
// download. So when this hook says `local` the interceptor serves local too;
// if the two ever disagree the local-only op returns its empty fallback, not a
// network call.
//
// Supporters become one more branch next to the admin check.

import { useMemo } from 'react';
import { offlineBoardKey } from '@boardsesh/offline-sync';
import { useSetting } from '../../settings';
import { useDownloadedScopeKeys } from '../../offline/use-downloaded-scope-keys';
import { useIsAdmin } from '../graphql/hooks/use-is-admin';

/**
 * - `local` — the scope is downloaded: read SQLite through `offlineAwareRequest`.
 * - `network` — not downloaded, but the viewer is an admin: ask the server directly.
 * - `download` — neither: show the download offer, run no query.
 */
export type CatalogQuerySource = 'local' | 'network' | 'download';

export type CatalogQueryScope = { boardName: string; layoutId: number; sizeId: number };

export type CatalogQuerySourceState = {
  source: CatalogQuerySource;
  /**
   * True while the answer could still change from `download` to something else
   * (the downloaded-scopes read or the admin flag is in flight). Show a loading
   * state rather than the download offer, so it cannot flash on a board that
   * turns out to be downloaded.
   */
  isResolving: boolean;
};

export function useCatalogQuerySourceState(scope: CatalogQueryScope | null): CatalogQuerySourceState {
  const [enabledScopeKeys] = useSetting('syncEnabledBoards');
  const { data: downloadedScopeKeys, isLoading: downloadedLoading } = useDownloadedScopeKeys();
  const scopeKey = scope
    ? offlineBoardKey({ boardType: scope.boardName, layoutId: scope.layoutId, sizeId: scope.sizeId })
    : null;
  const isLocal =
    scopeKey !== null && enabledScopeKeys.includes(scopeKey) && (downloadedScopeKeys ?? []).includes(scopeKey);
  // Only ask the server who the viewer is when the answer matters.
  const { isAdmin, isLoading: adminLoading } = useIsAdmin({ enabled: scopeKey !== null && !isLocal });

  return useMemo<CatalogQuerySourceState>(() => {
    if (isLocal) return { source: 'local', isResolving: false };
    if (isAdmin) return { source: 'network', isResolving: false };
    return { source: 'download', isResolving: scopeKey !== null && (downloadedLoading || adminLoading) };
  }, [isLocal, isAdmin, scopeKey, downloadedLoading, adminLoading]);
}

/** `useCatalogQuerySourceState(scope).source`. */
export function useCatalogQuerySource(scope: CatalogQueryScope | null): CatalogQuerySource {
  return useCatalogQuerySourceState(scope).source;
}
