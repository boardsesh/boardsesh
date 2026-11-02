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
//
// It also speaks the preview-first line (2.7, brief B1) once per install, when
// the preview-first card makes its first show: "Preview, not on the wall. Put on
// board lights it." It replaces the browse sentence for that moment and never
// adds a second one. Queued on iOS, so it waits for VoiceOver to finish the climb
// it is reading, and a polite live region on Android, where
// announceForAccessibility is deprecated from API 36.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { announceQueued } from '../../lib/announce-queued';
import { consumePreviewFirstAnnouncement } from '../../lib/onboarding/preview-first-tip';
import { resolveWallStateAnnouncement, type WallLatchExit, type WallPillState } from './wall-state';

// Debounced so a fast session (rapid latch/commit flips) can't spam the speech
// queue — the WallStatusCapsule budget.
const ANNOUNCE_DEBOUNCE_MS = 600;
/**
 * How long the Android live region keeps the preview-first line. Long enough for
 * TalkBack to pick up the change; then it empties, so swiping through the player
 * later never lands on a sentence that is no longer news.
 */
export const LIVE_REGION_CLEAR_MS = 5_000;

export type WallStateAnnouncer = {
  markLatchExit: (exit: WallLatchExit) => void;
  suppressBrowseAnnouncement: () => void;
  /**
   * The one-shot browse notice spoke (PlayCore's crew / solo notice). A
   * preview-first line due in the same moment then stands down.
   */
  noteBrowseNoticeSpoken: () => void;
  /** Android: the text for the hidden polite live region, or null. Always null on iOS. */
  liveRegionText: string | null;
};

/**
 * Narrates wall-state transitions to assistive tech, and hands back the marker
 * the latch's own exits use to say which exit they were.
 */
export function useWallStateAnnouncer({
  pillState,
  climbName,
  previewFirstDue = false,
}: {
  pillState: WallPillState;
  /** The displayed climb's name — rides the commit / back-to-live sentences. */
  climbName: string | null;
  /** The preview-first card's line belongs to this moment (`usePreviewFirstTip().announcementDue`). */
  previewFirstDue?: boolean;
}): WallStateAnnouncer {
  const { t } = useTranslation('session');
  const previousStateRef = useRef<WallPillState | undefined>(undefined);
  const exitRef = useRef<WallLatchExit | null>(null);
  const suppressBrowseRef = useRef(false);
  // Each pill-state change is one moment. A browse sentence and the
  // preview-first line in the same moment are the same news: only one speaks.
  const transitionRef = useRef(0);
  const browseSpokenTransitionRef = useRef<number | null>(null);
  const previewFirstTransitionRef = useRef<number | null>(null);
  const [liveRegionText, setLiveRegionText] = useState<string | null>(null);

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
  const noteBrowseNoticeSpoken = useCallback(() => {
    browseSpokenTransitionRef.current = transitionRef.current;
  }, []);

  const sentences = useMemo(
    () => ({
      browse: t('playView.wallState.a11y.browseAnnounce'),
      committed: t('playView.wallState.a11y.committed', { name: climbName ?? '' }),
      backToLive: t('playView.wallState.a11y.backToLive', { name: climbName ?? '' }),
      previewFirst: t('playView.wallState.a11y.previewFirstAnnounce'),
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
    transitionRef.current += 1;
    const transition = transitionRef.current;

    const announcement = resolveWallStateAnnouncement({ previous, next: pillState, exit });
    if (announcement === null) return;

    const text = sentencesRef.current[announcement];
    const handle = setTimeout(() => {
      if (announcement === 'browse') {
        if (suppressBrowseRef.current || previewFirstTransitionRef.current === transition) return;
        browseSpokenTransitionRef.current = transition;
      }
      AccessibilityInfo.announceForAccessibility(text);
    }, ANNOUNCE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [pillState]);

  // The preview-first line, once. Keyed on `previewFirstDue` alone: it turns
  // true when the card makes its first show and false once the line is spent.
  useEffect(() => {
    if (!previewFirstDue) return;
    const transition = transitionRef.current;
    // The browse sentence or the browse notice already told this moment that the
    // wall stays put. A second sentence on top would be the same news twice.
    if (browseSpokenTransitionRef.current === transition) {
      consumePreviewFirstAnnouncement();
      return;
    }
    previewFirstTransitionRef.current = transition;
    let spoken = false;
    const handle = setTimeout(() => {
      spoken = true;
      consumePreviewFirstAnnouncement();
      const text = sentencesRef.current.previewFirst;
      if (Platform.OS === 'android') setLiveRegionText(text);
      else announceQueued(text);
    }, ANNOUNCE_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
      // Cancelled before it spoke (the card stood down): the browse sentence of
      // this moment is free to speak again.
      if (!spoken && previewFirstTransitionRef.current === transition) previewFirstTransitionRef.current = null;
    };
  }, [previewFirstDue]);

  useEffect(() => {
    if (liveRegionText === null) return;
    const handle = setTimeout(() => setLiveRegionText(null), LIVE_REGION_CLEAR_MS);
    return () => clearTimeout(handle);
  }, [liveRegionText]);

  return useMemo(
    () => ({ markLatchExit, suppressBrowseAnnouncement, noteBrowseNoticeSpoken, liveRegionText }),
    [markLatchExit, suppressBrowseAnnouncement, noteBrowseNoticeSpoken, liveRegionText],
  );
}
