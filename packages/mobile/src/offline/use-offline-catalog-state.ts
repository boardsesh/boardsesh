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
import { useSetting } from '../settings';
import { useDownloadedScopeKeys } from './use-downloaded-scope-keys';

/**
 * `'missing'` — nothing downloaded and nothing asked for: offer the download.
 * `'queued'` — the user already asked; it lands on the next reconnect.
 * `null` — the catalog is here, or there is no board, so say nothing about it.
 */
export function useOfflineCatalogState(board: OfflineBoardLike | null | undefined): OfflineCatalogState {
  const [enabledScopeKeys] = useSetting('syncEnabledBoards');
  // One cheap indexed read, shared with My Boards / the boards picker via the
  // ['downloadedScopeKeys'] cache entry — not a useSyncStatus() subscription,
  // which republishes on every progress frame and would churn these lists.
  const { data: downloadedScopeKeys } = useDownloadedScopeKeys();
  const scopeKey = board ? offlineBoardKeyForBoard(board) : null;
  return useMemo(
    () => offlineCatalogState({ scopeKey, enabledScopeKeys, downloadedScopeKeys }),
    [scopeKey, enabledScopeKeys, downloadedScopeKeys],
  );
}
