// One rate-limited voice for the create drawer.
//
// The alternative — an `accessibilityLiveRegion="polite"` on the status line —
// is a trap here: the autosave is debounced at 500ms and its state flips while
// you paint and while you type, so a polite region re-announces on every
// keystroke and every hold tap. That makes the sheet unusable with TalkBack /
// VoiceOver on, which is a worse bug than the one being fixed.
//
// So the line's live region is explicitly `none` and transitions that change the
// answer are spoken through here instead, at most one every 10 seconds, never
// twice in a row with the same words.

import { useCallback, useRef } from 'react';
import { AccessibilityInfo } from 'react-native';

export const ANNOUNCE_MIN_INTERVAL_MS = 10_000;

/**
 * Returns a stable `announce(text)` that speaks at most once per
 * `minIntervalMs`, dropping repeats of the sentence it last spoke.
 */
export function useRateLimitedAnnouncer(minIntervalMs: number = ANNOUNCE_MIN_INTERVAL_MS): (text: string) => void {
  const lastAnnouncedAtRef = useRef(0);
  const lastTextRef = useRef<string | null>(null);

  return useCallback(
    (text: string) => {
      if (!text) return;
      if (text === lastTextRef.current) return;
      const now = Date.now();
      if (now - lastAnnouncedAtRef.current < minIntervalMs) return;
      lastAnnouncedAtRef.current = now;
      lastTextRef.current = text;
      AccessibilityInfo.announceForAccessibility(text);
    },
    [minIntervalMs],
  );
}
