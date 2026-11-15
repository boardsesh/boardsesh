import { useCallback, useEffect, useState } from 'react';

import { useRestTimerState } from '../../hooks/use-rest-timer';
import { useEffectiveRestPacing } from '../../hooks/use-effective-rest-pacing';
import { nowMs } from '../../lib/clock';
import { hapticMedium } from '../../lib/haptics';
import { pauseRestTimer, resetRestTimer, resumeRestTimer } from '../../lib/rest-timer-store';
import {
  formatRestTimerElapsed,
  formatRestTimerSigned,
  formatRestTimerTarget,
  isRestTimerTargetExceeded,
} from '../../lib/rest-timer';
import {
  getMsUntilNextRestTimerSecond,
  getRestTimerCountdownLeadSeconds,
  getRestTimerCycleElapsedSeconds,
  isRestTimerFinalCountdown,
} from '../../lib/rest-timer-auto-advance';

import { RestTimerPacerCaption } from './RestTimerPacerCaption';

import {
  RestTimerClockView,
  RestTimerHeroClockView,
  RestTimerPillView,
  type RestTimerClockProps,
  type RestTimerDisplay,
  type RestTimerPhase,
  type RestTimerPillProps,
} from './RestTimerViews';
export { WorkoutStartPill, restTimerClockAccessibilityLabel } from './RestTimerViews';
export type { RestTimerDisplay, RestTimerPhase, RestTimerPillProps } from './RestTimerViews';
export function useRestTimerNow(active: boolean, anchorMs: number | null): number {
  const [now, setNow] = useState<number>(() => nowMs());

  useEffect(() => {
    if (!active) return undefined;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    // Sampled straight away: the pill may have been mounted (or resumed) part
    // way through a second.
    const sample = () => {
      const sampledAtMs = nowMs();
      setNow(sampledAtMs);
      timeoutId = setTimeout(sample, getMsUntilNextRestTimerSecond(anchorMs, sampledAtMs));
    };
    sample();
    return () => {
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [active, anchorMs]);

  return now;
}

/**
 * Everything a rest-timer readout shows, derived once. Calls
 * {@link useRestTimerNow}, so ONLY a leaf component may call it — a screen that
 * wants a live clock renders {@link RestTimerClock} instead of calling this.
 */
export function useRestTimerDisplay(): RestTimerDisplay {
  const { armed, anchorMs, isRunning, pausedElapsedSeconds, queueEnded, listEnded } = useRestTimerState();
  const { targetSeconds, mode } = useEffectiveRestPacing();

  // Only a running timer with something to count from needs a heartbeat.
  const ticking = armed && isRunning && anchorMs !== null;
  const now = useRestTimerNow(ticking, anchorMs);

  const elapsedSeconds = getRestTimerCycleElapsedSeconds({
    mode,
    anchorMs,
    targetSeconds,
    nowMs: now,
    isRunning,
    pausedElapsedSeconds,
  });
  const hasTarget = targetSeconds !== null && targetSeconds > 0;
  const exceeded = hasTarget && isRestTimerTargetExceeded(elapsedSeconds, targetSeconds);
  const remainingSeconds = hasTarget ? targetSeconds - elapsedSeconds : null;
  const leadSeconds = getRestTimerCountdownLeadSeconds(targetSeconds);

  const phase: RestTimerPhase = !isRunning
    ? 'paused'
    : anchorMs === null
      ? 'waiting'
      : queueEnded
        ? 'queueEnded'
        : exceeded
          ? 'exceeded'
          : isRestTimerFinalCountdown(remainingSeconds, leadSeconds)
            ? 'final'
            : 'running';

  return {
    armed,
    isRunning,
    phase,
    elapsedSeconds,
    targetSeconds,
    remainingSeconds,
    // Waiting has nothing to count yet, so the number IS the target — a false
    // 0:00 would read as "your rest already started".
    displayLabel:
      phase === 'waiting' && hasTarget
        ? formatRestTimerTarget(targetSeconds)
        : remainingSeconds !== null
          ? formatRestTimerSigned(remainingSeconds)
          : formatRestTimerElapsed(elapsedSeconds),
    targetLabel: hasTarget ? formatRestTimerTarget(targetSeconds) : null,
    listEnded: queueEnded && listEnded,
    leadSeconds,
  };
}

export function RestTimerClock(props: RestTimerClockProps) {
  return <RestTimerClockView {...props} display={useRestTimerDisplay()} />;
}
export function RestTimerHeroClock() {
  return (
    <RestTimerHeroClockView
      display={useRestTimerDisplay()}
      pacer={<RestTimerPacerCaption variant="subheadline" centered scalesWithText />}
    />
  );
}
export function RestTimerPill(props: RestTimerPillProps) {
  const display = useRestTimerDisplay();
  const togglePause = useCallback(() => {
    hapticMedium();
    if (display.isRunning) pauseRestTimer(nowMs());
    else resumeRestTimer(nowMs());
  }, [display.isRunning]);
  const reset = useCallback(() => resetRestTimer(nowMs()), []);
  return (
    <RestTimerPillView
      {...props}
      display={display}
      onTogglePause={togglePause}
      onReset={reset}
      pacer={<RestTimerPacerCaption />}
    />
  );
}
