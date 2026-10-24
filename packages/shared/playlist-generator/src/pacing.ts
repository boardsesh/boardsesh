// How a workout stage paces the rest timer (#5380, #6231). The timed workout
// types carry their own rest or interval in their options; this turns those
// options into the one shape the run carries and the rest timer reads.
// Pure TS and JSON-serialisable, like the rest of the run.
//
// Pacing is always derived from a block's options (`pacingForOptions`) and is
// stored only on the run's stage (`WorkoutRunStage.pacing`), because a run keeps
// no options. Every other kind returns undefined: the climber's own rest-timer
// settings apply to it, exactly as before.

import type { GeneratorOptions } from './types';

/**
 * The rest timer's two cadences. Mobile's `RestTimerMode` names the same two
 * literals; the shared package cannot import it, so mobile asserts they match
 * with a `Same<>` type in `packages/mobile/src/lib/__tests__/stage-pacing-mode.test.ts`,
 * which mobile's typecheck covers.
 */
export type StagePacingMode = 'afterTick' | 'onTheMinute';

/**
 * When an `afterTick` stage lets the wall move on once the rest is over: after
 * any tick on the current climb (`tick`), or only after a flash or a send on it
 * (`send`, so a fall rests and stays on the same climb).
 */
export type StageAdvanceOn = 'tick' | 'send';

export type WorkoutStagePacing =
  /** One climb per interval: `restSeconds` is the interval, the wall moves on every beat. */
  | { mode: 'onTheMinute'; restSeconds: number }
  | {
      mode: 'afterTick';
      /** The rest after each logged climb. 0 means no rest (the changeover still applies). */
      restSeconds: number;
      /** With rounds only: the rest after a round's last climb, in place of `restSeconds`. */
      restBetweenRoundsSeconds?: number;
      advanceOn: StageAdvanceOn;
    };

/**
 * The shortest rest an `afterTick` stage ever runs, a stage rest of 0 included.
 * The wall still needs a deadline to fire on, and it must sit clear of the rest
 * timer's 5 s overdue grace: a tick saved a few seconds late would otherwise give
 * a deadline that is already past, and the wall would never move.
 */
export const STAGE_CHANGEOVER_SECONDS = 10;

/** The shortest on-the-minute interval (the partner API's `intervalSeconds` floor). */
export const MIN_STAGE_INTERVAL_SECONDS = 15;

/** The longest rest or interval a stage can carry (the partner API's ceiling). */
export const MAX_STAGE_REST_SECONDS = 3600;

/** The most rounds a 4x4 runs (the partner API's `rounds` ceiling). */
export const MAX_STAGE_ROUNDS = 10;

const isWholeSecondsIn = (candidate: unknown, min: number, max: number): candidate is number =>
  typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= min && candidate <= max;

// Options come from steppers, a partner payload or persisted state. Rounding and
// clamping here means the pacing a run stores always passes `isWorkoutStagePacing`.
const wholeSecondsIn = (seconds: number, min: number, max: number): number =>
  Number.isFinite(seconds) ? Math.min(max, Math.max(min, Math.round(seconds))) : min;

const stageRest = (seconds: number): number => wholeSecondsIn(seconds, 0, MAX_STAGE_REST_SECONDS);

/** The pacing a block's stage runs with. Undefined for every untimed type: the global rest settings apply. */
export function pacingForOptions(options: GeneratorOptions): WorkoutStagePacing | undefined {
  switch (options.type) {
    case 'onTheMinute':
      return {
        mode: 'onTheMinute',
        restSeconds: wholeSecondsIn(options.intervalSeconds, MIN_STAGE_INTERVAL_SECONDS, MAX_STAGE_REST_SECONDS),
      };
    case 'fourByFour':
      return {
        mode: 'afterTick',
        restSeconds: stageRest(options.restBetweenClimbsSeconds),
        restBetweenRoundsSeconds: stageRest(options.restBetweenRoundsSeconds),
        advanceOn: 'tick',
      };
    case 'limitBouldering':
      return { mode: 'afterTick', restSeconds: stageRest(options.restSeconds), advanceOn: 'send' };
    case 'volume':
    case 'pyramid':
    case 'ladder':
    case 'gradeFocus':
      return undefined;
    default: {
      const exhaustiveOptions: never = options;
      void exhaustiveOptions;
      return undefined;
    }
  }
}

/** How many rounds a block's stage runs. Only a 4x4 has rounds. */
export function roundsForOptions(options: GeneratorOptions): number | undefined {
  switch (options.type) {
    case 'fourByFour':
      return Number.isFinite(options.rounds) ? Math.min(MAX_STAGE_ROUNDS, Math.max(1, Math.floor(options.rounds))) : 1;
    case 'volume':
    case 'pyramid':
    case 'ladder':
    case 'gradeFocus':
    case 'onTheMinute':
    case 'limitBouldering':
      return undefined;
    default: {
      const exhaustiveOptions: never = options;
      void exhaustiveOptions;
      return undefined;
    }
  }
}

/**
 * The rest after one climb of the stage, in seconds. `closesRound`: the climb
 * is its round's last, so a 4x4 takes its between-rounds rest. An `afterTick`
 * rest never drops below the changeover, and an interval never below 15 s.
 */
export function stageRestSeconds(pacing: WorkoutStagePacing, closesRound: boolean): number {
  if (pacing.mode === 'onTheMinute') return Math.max(MIN_STAGE_INTERVAL_SECONDS, pacing.restSeconds);
  const restSeconds =
    closesRound && pacing.restBetweenRoundsSeconds !== undefined ? pacing.restBetweenRoundsSeconds : pacing.restSeconds;
  return Math.max(STAGE_CHANGEOVER_SECONDS, restSeconds);
}

/**
 * True when stored data is pacing this bundle can run. Rejects an unknown mode
 * or advance rule, and seconds that are not whole or out of range, so a run
 * written by a newer bundle loses just its pacing rather than misreading it.
 */
export function isWorkoutStagePacing(candidate: unknown): candidate is WorkoutStagePacing {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const pacing = candidate as Record<string, unknown>;
  if (pacing.mode === 'onTheMinute') {
    return isWholeSecondsIn(pacing.restSeconds, MIN_STAGE_INTERVAL_SECONDS, MAX_STAGE_REST_SECONDS);
  }
  if (pacing.mode !== 'afterTick') return false;
  return (
    isWholeSecondsIn(pacing.restSeconds, 0, MAX_STAGE_REST_SECONDS) &&
    (pacing.restBetweenRoundsSeconds === undefined ||
      isWholeSecondsIn(pacing.restBetweenRoundsSeconds, 0, MAX_STAGE_REST_SECONDS)) &&
    (pacing.advanceOn === 'tick' || pacing.advanceOn === 'send')
  );
}
