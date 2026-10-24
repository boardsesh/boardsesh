// The ONE place the rest timer's pacing is read (#5396, #5380, #5382). The
// scheduler, the pill and hero clock, the session sync and the arm row all read
// through here, so a workout stage or the crew clock changes what they run on
// without any of them changing. The sheet's controls keep WRITING the settings
// directly: they edit the climber's own preferences, not the effective value.
//
// Today it resolves the three settings and nothing else (source 'settings',
// advance rule 'deadline'), which is exactly what the readers did before.

import { useMemo } from 'react';
import { getSetting, useSetting } from '../settings';
import { resolveEffectiveRestPacing, type EffectiveRestPacing } from '../lib/rest-timer-pacing';

/**
 * Reference-stable between changes, so a reader can list it (or its fields) in
 * effect deps without rescheduling on every render.
 */
export function useEffectiveRestPacing(): EffectiveRestPacing {
  const [targetSeconds] = useSetting('restTimerTargetSeconds');
  const [mode] = useSetting('restTimerMode');
  const [autoAdvance] = useSetting('restTimerAutoAdvance');

  return useMemo(
    () => resolveEffectiveRestPacing({ settings: { targetSeconds, mode, autoAdvance }, stage: null, crew: null }),
    [targetSeconds, mode, autoAdvance],
  );
}

/** The same answer for code outside React: the tick path, the arm switch, a sync effect. */
export function getEffectiveRestPacing(): EffectiveRestPacing {
  return resolveEffectiveRestPacing({
    settings: {
      targetSeconds: getSetting('restTimerTargetSeconds'),
      mode: getSetting('restTimerMode'),
      autoAdvance: getSetting('restTimerAutoAdvance'),
    },
    stage: null,
    crew: null,
  });
}
