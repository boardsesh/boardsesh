// The one hook every offline-nudge surface mounts. It answers "may I show this,
// for this board", fires the impression event exactly once, and hands back the
// accept / dismiss actions already wired to persistence and analytics.
//
// Deliberately does NOT read `useSyncStatus()`. The only distinction the gate
// needs is `'off'` vs everything else, and `boardDownloadState` returns `'off'`
// exactly when the scope is absent from `syncEnabledBoards` — so the live sync
// frame adds nothing but a re-render on every progress tick, on screens that are
// virtualised lists (see docs/react-native-performance.md).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { boardDownloadState } from '../../components/board-discovery/board-offline-state';
import { useOfflineDownloadsEnabled, useOfflineNudgesEnabled } from '../../providers/feature-flags-provider';
import { useDownloadedScopeKeys } from '../../offline/use-downloaded-scope-keys';
import { offlineBoardKeyForBoard, useSetting } from '../../settings';
import {
  emptyNudgeState,
  shouldShowNudge,
  withNudgeAccepted,
  withNudgeDismissed,
  withNudgeShown,
} from './nudge-policy';
import type { NudgeSurface, OfflineNudgeState } from './nudge-policy';
import { loadNudgeState, saveNudgeState } from './nudge-storage';
import { trackNudgeAccepted, trackNudgeDismissed, trackNudgeShown } from './nudge-analytics';
import type { NudgeAcceptAction, NudgeEventContext } from './nudge-analytics';

export type UseOfflineNudgeInput = {
  surface: NudgeSurface;
  /** The board to suggest. `null` (no active board) means nothing to suggest. */
  board: UserBoard | null | undefined;
  /**
   * `post_session` only: a store-review prompt is going to appear on this
   * screen, so stay out of its way. Must be the resolved decision, not the bare
   * "≥3 sends" eligibility — see `usePostSessionPrompt`.
   */
  storeReviewWillPrompt?: boolean;
};

export type OfflineNudgeController = {
  /** Render the nudge. False until the persisted state has loaded. */
  visible: boolean;
  /**
   * Record the accept. The caller passes what it actually did, because only the
   * caller knows: the hook can see connectivity, and connectivity is exactly
   * what lies on captive-portal wifi.
   */
  accept: (action: NudgeAcceptAction) => void;
  dismiss: (dismissKind: 'once' | 'forever') => void;
};

export function useOfflineNudge({ surface, board, storeReviewWillPrompt }: UseOfflineNudgeInput) {
  const offlineEngineEnabled = useOfflineDownloadsEnabled();
  const nudgesEnabled = useOfflineNudgesEnabled();
  const [enabledBoards] = useSetting('syncEnabledBoards');
  const [autoOfflineBoards] = useSetting('autoOfflineBoards');
  const { data: downloadedScopeKeys } = useDownloadedScopeKeys();

  // `null` until AsyncStorage answers. Nothing renders before that, so a nudge
  // can't flash on screen and then retract when the cap turns out to be spent.
  const [nudgeState, setNudgeState] = useState<OfflineNudgeState | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadNudgeState()
      .then((loaded) => {
        if (!cancelled) setNudgeState(loaded);
      })
      // loadNudgeState resolves a read failure to the suppress-everything state,
      // so this only catches a genuinely unexpected throw. Stay silent either way.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const scopeKey = board ? offlineBoardKeyForBoard(board) : null;
  const offlineState = useMemo(
    () =>
      boardDownloadState({
        scopeKey: scopeKey ?? '',
        enabled: scopeKey !== null && enabledBoards.includes(scopeKey),
        downloaded: scopeKey !== null && (downloadedScopeKeys ?? []).includes(scopeKey),
        isSyncing: false,
        currentTable: null,
      }),
    [scopeKey, enabledBoards, downloadedScopeKeys],
  );

  // "Not now" has to take the card off the screen even on the affordances, which
  // carry no cooldown by design. That is a this-mount decision, not persisted
  // state: come back to the screen and the empty state offers the download again
  // rather than staying a dead end.
  const [dismissedThisMount, setDismissedThisMount] = useState(false);

  const visible =
    board != null &&
    scopeKey !== null &&
    nudgeState !== null &&
    !dismissedThisMount &&
    shouldShowNudge({
      surface,
      state: nudgeState,
      nowMs: Date.now(),
      offlineEngineEnabled,
      nudgesEnabled,
      offlineState,
      autoOfflineBoards: autoOfflineBoards === true,
      storeReviewWillPrompt,
    });

  const eventContext = useMemo<NudgeEventContext | null>(
    () =>
      board && scopeKey
        ? {
            surface,
            boardType: board.boardType,
            layoutId: board.layoutId,
            scopeKey,
            downloadedBoardCount: (downloadedScopeKeys ?? []).length,
          }
        : null,
    [surface, board, scopeKey, downloadedScopeKeys],
  );

  // One impression per scope per mount. Keyed on the scope so switching boards
  // on a live screen still counts, but a re-render never double-counts.
  const shownScopeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !eventContext || nudgeState === null) return;
    if (shownScopeKeyRef.current === eventContext.scopeKey) return;
    shownScopeKeyRef.current = eventContext.scopeKey;
    trackNudgeShown(eventContext);
    void saveNudgeState(withNudgeShown(nudgeState, surface, Date.now()));
    // Deliberately not re-running on `nudgeState`: recording the show writes it
    // back, and depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, eventContext, surface]);

  const accept = useCallback(
    (action: NudgeAcceptAction) => {
      if (eventContext) trackNudgeAccepted(eventContext, action);
      void saveNudgeState(withNudgeAccepted(nudgeState ?? emptyNudgeState(), surface, Date.now()));
      setNudgeState((previous) => withNudgeAccepted(previous ?? emptyNudgeState(), surface, Date.now()));
    },
    [eventContext, nudgeState, surface],
  );

  const dismiss = useCallback(
    (dismissKind: 'once' | 'forever') => {
      if (eventContext) trackNudgeDismissed(eventContext, dismissKind);
      const next = withNudgeDismissed(nudgeState ?? emptyNudgeState(), surface, dismissKind, Date.now());
      void saveNudgeState(next);
      setNudgeState(next);
      setDismissedThisMount(true);
    },
    [eventContext, nudgeState, surface],
  );

  return { visible, accept, dismiss } satisfies OfflineNudgeController;
}
