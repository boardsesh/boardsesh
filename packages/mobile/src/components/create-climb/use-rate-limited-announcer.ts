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

import { useCallback, useEffect, useRef } from 'react';
import { AccessibilityInfo } from 'react-native';

export const ANNOUNCE_MIN_INTERVAL_MS = 10_000;

/**
 * Returns an `announce(text)` that speaks at most once per `minIntervalMs`.
 * During the cooldown it keeps only the latest distinct sentence and speaks it
 * at the trailing edge, so a meaningful final state is delayed rather than lost.
 */
export function useRateLimitedAnnouncer(minIntervalMs: number = ANNOUNCE_MIN_INTERVAL_MS): (text: string) => void {
  const lastAnnouncedAtRef = useRef(0);
  const lastTextRef = useRef<string | null>(null);
  const pendingTextRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPending = useCallback(() => {
    pendingTextRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => clearPending, [clearPending]);

  return useCallback(
    (text: string) => {
      if (!text) {
        clearPending();
        return;
      }
      if (text === lastTextRef.current) {
        // The status returned to what was already announced. Any different
        // queued status is now stale and must not be spoken later.
        clearPending();
        return;
      }
      if (text === pendingTextRef.current) return;
      const now = Date.now();
      const elapsedMs = now - lastAnnouncedAtRef.current;
      if (elapsedMs >= minIntervalMs) {
        clearPending();
        lastAnnouncedAtRef.current = now;
        lastTextRef.current = text;
        AccessibilityInfo.announceForAccessibility(text);
        return;
      }

      pendingTextRef.current = text;
      if (timerRef.current) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const pendingText = pendingTextRef.current;
        pendingTextRef.current = null;
        if (!pendingText || pendingText === lastTextRef.current) return;
        lastAnnouncedAtRef.current = Date.now();
        lastTextRef.current = pendingText;
        AccessibilityInfo.announceForAccessibility(pendingText);
      }, minIntervalMs - elapsedMs);
    },
    [clearPending, minIntervalMs],
  );
}
