import { useCallback, useEffect, useRef } from 'react';
import { announceQueued } from '../../lib/announce-queued';

/**
 * Announces the board's value ("Yoshi's Island, V5, 5 of 40") once a step the
 * climber took has landed on its climb, so a swipe, an adjust or Next says
 * where it went wherever focus is. Queued, so it never cuts off what VoiceOver
 * is reading (a crossing's "Now in Projects" goes first). On iOS this is the
 * only place the value is said: the board carries none there, since VoiceOver
 * would read it before the step had changed it (see `SwipeBoardCarousel`).
 *
 * Returns what to call with each step, before its landing renders. A step that
 * lands anywhere else (the queue refused it, a crewmate moved the climb) drops
 * the announcement, as the crossing cue does.
 */
export function useBoardValueAnnouncement({
  displayedClimbUuid,
  nextClimbUuid,
  previousClimbUuid,
  value,
}: {
  displayedClimbUuid: string | null;
  nextClimbUuid: string | null;
  previousClimbUuid: string | null;
  value: string | undefined;
}): (direction: 'next' | 'previous') => void {
  // A step reads where Next and Previous went in the render before it.
  const latestRef = useRef({ displayedClimbUuid, nextClimbUuid, previousClimbUuid });
  latestRef.current = { displayedClimbUuid, nextClimbUuid, previousClimbUuid };
  const pendingRef = useRef<{ from: string | null; to: string } | null>(null);

  const noteStep = useCallback((direction: 'next' | 'previous') => {
    const latest = latestRef.current;
    const to = direction === 'next' ? latest.nextClimbUuid : latest.previousClimbUuid;
    pendingRef.current = to === null ? null : { from: latest.displayedClimbUuid, to };
  }, []);

  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || displayedClimbUuid === pending.from) return;
    pendingRef.current = null;
    if (displayedClimbUuid === pending.to && value) announceQueued(value);
  }, [displayedClimbUuid, value]);

  return noteStep;
}
