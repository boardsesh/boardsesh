// The ONE place the rest timer's pacing is read (#5396, #5380, #5382). The
// scheduler, the pill and hero clock, the session sync and the arm row all read
// through here, so a workout stage or the crew clock changes what they run on
// without any of them changing. The sheet's controls keep WRITING the settings
// directly: they edit the climber's own preferences, not the effective value.
//
// It resolves the three settings and the workout stage pacing of the climb on
// the wall, which `RestTimerPacingSync` keeps in the rest-timer store. With no
// stage that is exactly the settings (source 'settings', advance rule
// 'deadline'), which is what the readers did before.

import { useMemo, useSyncExternalStore } from 'react';
import { getSetting, useSetting } from '../settings';
import {
  resolveEffectiveRestPacing,
  type EffectiveRestPacing,
  type RestPacingSettings,
  type RestTimerStagePacing,
} from '../lib/rest-timer-pacing';
import { getRestTimerState, subscribeRestTimer } from '../lib/rest-timer-store';

const getStagePacing = (): RestTimerStagePacing | null => getRestTimerState().stagePacing;

/**
 * The workout stage pacing of the climb on the wall, or null. Re-renders only
 * when it changes (a new climb or stage), never on a tick or a pause.
 */
export function useRestTimerStagePacing(): RestTimerStagePacing | null {
  return useSyncExternalStore(subscribeRestTimer, getStagePacing, getStagePacing);
}

/**
 * Reference-stable between changes, so a reader can list it (or its fields) in
 * effect deps without rescheduling on every render.
 */
export function useEffectiveRestPacing(): EffectiveRestPacing {
  const [targetSeconds] = useSetting('restTimerTargetSeconds');
  const [mode] = useSetting('restTimerMode');
  const [autoAdvance] = useSetting('restTimerAutoAdvance');
  const stage = useRestTimerStagePacing();

  return useMemo(
    () => resolveEffectiveRestPacing({ settings: { targetSeconds, mode, autoAdvance }, stage, crew: null }),
    [targetSeconds, mode, autoAdvance, stage],
  );
}

/** The climber's own three rest settings, outside React. */
export function getRestPacingSettings(): RestPacingSettings {
  return {
    targetSeconds: getSetting('restTimerTargetSeconds'),
    mode: getSetting('restTimerMode'),
    autoAdvance: getSetting('restTimerAutoAdvance'),
  };
}

/** The same answer for code outside React: the tick path, the arm switch, a sync effect. */
export function getEffectiveRestPacing(): EffectiveRestPacing {
  return resolveEffectiveRestPacing({ settings: getRestPacingSettings(), stage: getStagePacing(), crew: null });
}
