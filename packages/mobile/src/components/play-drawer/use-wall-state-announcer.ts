// Who narrates the wall state, and when.
//
// This lives in the HOST, not in the pill, for two reasons the pill can't fix:
//
//  - the announcement has to outlive the pill. The commonest way a browse latch
//    ends (a plain preview with no BLE link and no session) leaves no pill
//    behind at all — `resolveWallPillState` returns null — so an effect inside
//    the pill would unmount with it and the state change that ENDS browsing
//    would be silent while the one that began it was narrated;
//  - the words depend on the TRANSITION, not on where you landed. "Back to live"
//    and "X is on the wall" are both `browsing` → something-else; only the
//    action the climber took tells them apart.
//
// The decision itself is pure and table-tested in `wall-state.ts`; this is the
// wiring — the previous-state and exit-marker bookkeeping, plus the debounce.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AccessibilityInfo } from 'react-native';
import { useTranslation } from 'react-i18next';
import { resolveWallStateAnnouncement, type WallLatchExit, type WallPillState } from './wall-state';

// Debounced so a fast session (rapid latch/commit flips) can't spam the speech
// queue — the WallStatusCapsule budget.
const ANNOUNCE_DEBOUNCE_MS = 600;

/**
 * Narrates wall-state transitions to assistive tech, and hands back the marker
 * the latch's own exits use to say which exit they were.
 */
export function useWallStateAnnouncer({
  pillState,
  climbName,
}: {
  pillState: WallPillState;
  /** The displayed climb's name — rides the commit / back-to-live sentences. */
  climbName: string | null;
}): { markLatchExit: (exit: WallLatchExit) => void; suppressBrowseAnnouncement: () => void } {
  const { t } = useTranslation('session');
  const previousStateRef = useRef<WallPillState | undefined>(undefined);
  const exitRef = useRef<WallLatchExit | null>(null);
  const suppressBrowseRef = useRef(false);

  const markLatchExit = useCallback((exit: WallLatchExit) => {
    exitRef.current = exit;
  }, []);

  // The one-shot joined-a-crew notice says the same thing as the browse sentence,
  // in more words, at the same moment — so when the host shows it, it speaks and
  // this stands down. Checked at fire time rather than at schedule time because
  // the host claims the notice in a LATER effect of the same commit: by then this
  // effect has already scheduled its announcement.
  const suppressBrowseAnnouncement = useCallback(() => {
    suppressBrowseRef.current = true;
  }, []);

  const sentences = useMemo(
    () => ({
      browse: t('playView.wallState.a11y.browseAnnounce'),
      committed: t('playView.wallState.a11y.committed', { name: climbName ?? '' }),
      backToLive: t('playView.wallState.a11y.backToLive', { name: climbName ?? '' }),
    }),
    [t, climbName],
  );
  // Read through a ref so the effect can key on the transition alone: a climb
  // name changing mid-latch is not a state change, and re-running there would
  // cancel a pending announcement through the cleanup.
  const sentencesRef = useRef(sentences);
  sentencesRef.current = sentences;

  useEffect(() => {
    const previous = previousStateRef.current;
    previousStateRef.current = pillState;
    const exit = exitRef.current;
    exitRef.current = null;
    // A new transition, so any suppression left over from the last one is spent.
    suppressBrowseRef.current = false;

    const announcement = resolveWallStateAnnouncement({ previous, next: pillState, exit });
    if (announcement === null) return;

    const text = sentencesRef.current[announcement];
    const handle = setTimeout(() => {
      if (announcement === 'browse' && suppressBrowseRef.current) return;
      AccessibilityInfo.announceForAccessibility(text);
    }, ANNOUNCE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [pillState]);

  return { markLatchExit, suppressBrowseAnnouncement };
}
