import { useCallback, useEffect, useRef, useState } from 'react';

/** A press this soon after a touch that revealed the controls belongs to that touch. */
export const REVEAL_TOUCH_WINDOW_MS = 600;

/**
 * Controls that step aside for full-screen content and come back on a touch
 * (HIG, Going full screen: "Prioritize content by temporarily hiding toolbars
 * and navigation controls … let people restore the hidden elements with a
 * familiar gesture or action like tapping").
 *
 * The controls start visible, so whoever opened the screen sees the way out,
 * then hide `visibleMs` after the last touch. `pinned` keeps them up for as long
 * as it is true (an assistive technology is running).
 *
 * Hidden controls stay in the accessibility tree and stay tappable, so Switch
 * Control, Voice Control and Full Keyboard Access (which iOS does not report)
 * can still reach them. `guardPress` makes that safe: a press on a hidden
 * control, or the press that ends the very touch that revealed it, only
 * reveals; the next one acts. A stray tap on an invisible Exit never exits.
 */
export function useAutoHidingChrome({ visibleMs, pinned }: { visibleMs: number; pinned: boolean }): {
  visible: boolean;
  /** Bring the controls back and restart the countdown. */
  reveal: () => void;
  /** For the root view's `onTouchStart`: every touch reveals. */
  handleTouchStart: () => void;
  /** Wraps a control's action so it only runs while the controls were already up. */
  guardPress: (action: () => void) => () => void;
} {
  const [shown, setShown] = useState(true);
  const visible = pinned || shown;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealTouchAtRef = useRef<number | null>(null);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setShown(false);
    }, visibleMs);
  }, [visibleMs]);

  const reveal = useCallback(() => {
    setShown(true);
    scheduleHide();
  }, [scheduleHide]);

  const handleTouchStart = useCallback(() => {
    revealTouchAtRef.current = visibleRef.current ? null : Date.now();
    reveal();
  }, [reveal]);

  const guardPress = useCallback(
    (action: () => void) => () => {
      const revealTouchAt = revealTouchAtRef.current;
      revealTouchAtRef.current = null;
      const pressEndsRevealTouch = revealTouchAt !== null && Date.now() - revealTouchAt < REVEAL_TOUCH_WINDOW_MS;
      if (!visibleRef.current || pressEndsRevealTouch) {
        reveal();
        return;
      }
      action();
    },
    [reveal],
  );

  useEffect(() => {
    scheduleHide();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    };
  }, [scheduleHide]);

  return { visible, reveal, handleTouchStart, guardPress };
}
