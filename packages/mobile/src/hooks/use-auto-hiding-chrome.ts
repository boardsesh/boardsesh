import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Controls that step aside for full-screen content and come back on a touch
 * (HIG, Going full screen: "Prioritize content by temporarily hiding toolbars
 * and navigation controls … let people restore the hidden elements with a
 * familiar gesture or action like tapping").
 *
 * The controls start visible, so whoever opened the screen sees the way out,
 * then hide `visibleMs` after the last `reveal()`. `pinned` keeps them up for
 * as long as it is true: a VoiceOver or TalkBack user has no "tap anywhere" to
 * bring them back.
 */
export function useAutoHidingChrome({ visibleMs, pinned }: { visibleMs: number; pinned: boolean }): {
  visible: boolean;
  reveal: () => void;
} {
  const [shown, setShown] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    scheduleHide();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    };
  }, [scheduleHide]);

  return { visible: pinned || shown, reveal };
}
