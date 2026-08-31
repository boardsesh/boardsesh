// Which offline empty state the catalog screens (Climbs, the boards picker)
// should show for a given board.
//
// One hook rather than two hand-rolled predicates because the two screens have
// to agree with each other AND with the download CTA's own gate: the CTA takes
// itself away the moment the scope leaves `'off'`, so a screen still asking
// "is it downloaded?" would keep the offer-the-download copy after the offer
// had gone — the dead end again, one tap later.

import { useMemo } from 'react';
import type { OfflineBoardLike } from '@boardsesh/offline-sync';
import { offlineBoardKeyForBoard } from '@boardsesh/offline-sync';
import { offlineCatalogState, type OfflineCatalogState } from '../components/board-discovery/board-offline-state';
import { useOfflineDownloadsEnabled } from '../providers/feature-flags-provider';
import { useSetting } from '../settings';
import { useDownloadedScopeKeys } from './use-downloaded-scope-keys';

/**
 * `'missing'` — nothing downloaded and nothing asked for: offer the download.
 * `'queued'` — the user already asked; it lands on the next reconnect.
 * `null` — the catalog is here, or there is no board, so say nothing about it.
 *
 * The engine gate is read HERE and not only inside the CTA, because each state
 * is a promise the screen makes on its own: with the engine off (the Expo web
 * fork) `OfflineSyncBridge` starts no scheduler, no listeners and no pull, so a
 * scope left enabled in settings is never downloading and "it lands on the next
 * reconnect" would simply be false.
 */
export function useOfflineCatalogState(board: OfflineBoardLike | null | undefined): OfflineCatalogState {
  const offlineEngineEnabled = useOfflineDownloadsEnabled();
  const [enabledScopeKeys] = useSetting('syncEnabledBoards');
  // One cheap indexed read, shared with My Boards / the boards picker via the
  // ['downloadedScopeKeys'] cache entry — not a useSyncStatus() subscription,
  // which republishes on every progress frame and would churn these lists.
  const { data: downloadedScopeKeys } = useDownloadedScopeKeys();
  const scopeKey = board ? offlineBoardKeyForBoard(board) : null;
  return useMemo(() => {
    if (!offlineEngineEnabled) return null;
    return offlineCatalogState({ scopeKey, enabledScopeKeys, downloadedScopeKeys });
  }, [scopeKey, enabledScopeKeys, downloadedScopeKeys, offlineEngineEnabled]);
}
