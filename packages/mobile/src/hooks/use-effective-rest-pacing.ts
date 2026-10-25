// The ONE place the rest timer's pacing is read (#5396, #5380, #5382). The
// scheduler, the pill and hero clock, the session sync and the arm row all read
// through here, so a workout stage or the crew clock changes what they run on
// without any of them changing. The sheet's controls keep WRITING the settings:
// they edit the climber's own preferences, not the effective value. While a
// crew clock runs they show its values (useCrewRestControlsConfig), send an
// edit to the crew clock and copy it into the settings too
// (useRestPacingControls in RestTimerSheet.tsx).
//
// It resolves the three settings, the workout stage pacing of the climb on the
// wall (which `RestTimerPacingSync` keeps in the rest-timer store) and the
// crew's shared clock this phone follows (#5382, `crew` in the same store).
// With neither that is exactly the settings (source 'settings', advance rule
// 'deadline'), which is what the readers did before.

import { useMemo, useSyncExternalStore } from 'react';
import { getSetting, useSetting } from '../settings';
import {
  resolveEffectiveRestPacing,
  type CrewRestConfig,
  type EffectiveRestPacing,
  type RestPacingSettings,
  type RestTimerStagePacing,
} from '../lib/rest-timer-pacing';
import type { OwnRestPacing } from '../lib/crew-rest-cadence';
import { getRestTimerState, subscribeRestTimer } from '../lib/rest-timer-store';

const getStagePacing = (): RestTimerStagePacing | null => getRestTimerState().stagePacing;

/**
 * The crew clock's config while this phone follows one it can run. Its
 * identity only changes with the config (adoptCrewCadence keeps the object), so
 * a tick or a beat never re-renders a reader.
 */
const getCrewConfig = (): CrewRestConfig | null => getRestTimerState().crew?.config ?? null;

/** The crew clock's config this phone follows, or null. Re-renders only when it changes. */
export function useCrewRestConfig(): CrewRestConfig | null {
  return useSyncExternalStore(subscribeRestTimer, getCrewConfig, getCrewConfig);
}

/** What the timer's controls show on a crew clock: this phone's unanswered edit, else the crew's config. */
const getCrewControlsConfig = (): CrewRestConfig | null => {
  const { crew, crewPacingDraft } = getRestTimerState();
  if (crew?.config == null) return null;
  return crewPacingDraft ?? crew.config;
};

/**
 * The crew config the sheet's and the Record tab's length, cadence and
 * auto-advance controls show and edit (#5382): the crew's, or an edit of this
 * phone's the server has not answered yet, so a second tap steps on from the
 * first. Null with no crew clock this phone can run.
 */
export function useCrewRestControlsConfig(): CrewRestConfig | null {
  return useSyncExternalStore(subscribeRestTimer, getCrewControlsConfig, getCrewControlsConfig);
}

/**
 *   none         no crew clock on this phone
 *   shared       following the crew's clock
 *   unsupported  the crew's clock uses something this app cannot run
 */
export type CrewRestStatus = 'none' | 'shared' | 'unsupported';

const getCrewStatus = (): CrewRestStatus => {
  const { crew } = getRestTimerState();
  if (crew === null) return 'none';
  return crew.config === null ? 'unsupported' : 'shared';
};

/** Whether this phone follows a crew clock. A string, so it re-renders only when the answer changes. */
export function useCrewRestStatus(): CrewRestStatus {
  return useSyncExternalStore(subscribeRestTimer, getCrewStatus, getCrewStatus);
}

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
  const crew = useCrewRestConfig();

  return useMemo(
    () => resolveEffectiveRestPacing({ settings: { targetSeconds, mode, autoAdvance }, stage, crew }),
    [targetSeconds, mode, autoAdvance, stage, crew],
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
  return resolveEffectiveRestPacing({
    settings: getRestPacingSettings(),
    stage: getStagePacing(),
    crew: getCrewConfig(),
  });
}

/**
 * What this phone would run on with no crew clock: its workout stage, else its
 * settings. The crew publisher sends this when the climber edits a setting or
 * the stage on the wall changes, so the crew takes this phone's pacing then.
 */
export function getOwnRestPacing(): OwnRestPacing {
  const { mode, targetSeconds, autoAdvance, advanceOn, source } = resolveEffectiveRestPacing({
    settings: getRestPacingSettings(),
    stage: getStagePacing(),
    crew: null,
  });
  return { mode, targetSeconds, autoAdvance, advanceOn, source: source === 'stage' ? 'stage' : 'settings' };
}
