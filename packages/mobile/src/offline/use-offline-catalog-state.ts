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
import { useOfflineDownloadsEnabled, useOfflineNudgesEnabled } from '../providers/feature-flags-provider';
import { useSetting } from '../settings';
import { useDownloadedScopeKeys } from './use-downloaded-scope-keys';

/**
 * `'missing'` — nothing downloaded and nothing asked for: offer the download.
 * `'queued'` — the user already asked; it lands on the next reconnect.
 * `null` — the catalog is here, or there is no board, so say nothing about it.
 *
 * Both flags are read HERE and not only inside the CTA, because each state is a
 * promise the screen makes on its own:
 *
 *   Kill switch off — `OfflineSyncBridge` starts no scheduler, no listeners and
 *   no pull, so a scope left enabled in settings from before the flip is never
 *   downloading. "It lands on the next reconnect" would simply be false.
 *
 *   Nudges off — `'missing'` exists to host the download offer, and the offer
 *   checks the same flag. Selecting it anyway leaves the screen telling the
 *   user their board isn't on their phone with nothing to do about it, which is
 *   a worse dead end than the generic empty state it replaced. `'queued'`
 *   survives: that board was armed from My Boards, and the wait is real.
 */
export function useOfflineCatalogState(board: OfflineBoardLike | null | undefined): OfflineCatalogState {
  const offlineEngineEnabled = useOfflineDownloadsEnabled();
  const nudgesEnabled = useOfflineNudgesEnabled();
  const [enabledScopeKeys] = useSetting('syncEnabledBoards');
  // One cheap indexed read, shared with My Boards / the boards picker via the
  // ['downloadedScopeKeys'] cache entry — not a useSyncStatus() subscription,
  // which republishes on every progress frame and would churn these lists.
  const { data: downloadedScopeKeys } = useDownloadedScopeKeys();
  const scopeKey = board ? offlineBoardKeyForBoard(board) : null;
  return useMemo(() => {
    if (!offlineEngineEnabled) return null;
    const state = offlineCatalogState({ scopeKey, enabledScopeKeys, downloadedScopeKeys });
    if (state === 'missing' && !nudgesEnabled) return null;
    return state;
  }, [scopeKey, enabledScopeKeys, downloadedScopeKeys, offlineEngineEnabled, nudgesEnabled]);
}
