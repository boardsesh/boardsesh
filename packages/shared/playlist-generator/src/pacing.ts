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
 * any tick on the current climb (`tick`), only after a flash or a send on it
 * (`send`, so a fall rests and stays on the same climb), or once it was logged
 * for every rep of its set (`set`, a 4x4: a fall and a send each count as one).
 *
 * `set` is a value of its own, never `tick` with `sets` beside it, because of
 * what an older bundle does with a stored run. Every bundle from before sets
 * knows only `tick` and `send` and never looks at `sets`: read as `tick`, a 4x4
 * would move the wall 10 s after its first rep. `set` fails those bundles'
 * `isWorkoutStagePacing`, so after a rollback the stage loses its pacing (their
 * documented degrade) and runs on the climber's own rest settings instead.
 */
export type StageAdvanceOn = 'tick' | 'send' | 'set';

/**
 * A 4x4's sets: the climb on the wall stays up until it was logged
 * `repsPerSet` times (a fall or a send, each one rep), then rests
 * `restBetweenSetsSeconds` and moves on.
 */
export type StageSetPacing = { repsPerSet: number; restBetweenSetsSeconds: number };

export type WorkoutStagePacing =
  /** One climb per interval: `restSeconds` is the interval, the wall moves on every beat. */
  | { mode: 'onTheMinute'; restSeconds: number }
  | {
      mode: 'afterTick';
      /**
       * The rest after each logged climb (limit bouldering: after each try). 0
       * means no rest; the changeover still applies wherever the rest moves the
       * wall.
       */
      restSeconds: number;
      advanceOn: Exclude<StageAdvanceOn, 'set'>;
      sets?: undefined;
    }
  | {
      mode: 'afterTick';
      /**
       * The rest between two reps of a set. That rest never moves the wall, so
       * 0 runs no rest at all.
       */
      restSeconds: number;
      advanceOn: 'set';
      /** A 4x4: reps per climb, and the rest after a set's last rep. */
      sets: StageSetPacing;
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

/** The fewest reps a 4x4 set takes: one climb once is just a climb. */
export const MIN_STAGE_REPS_PER_SET = 2;

/** The most reps a 4x4 set takes. */
export const MAX_STAGE_REPS_PER_SET = 10;

/** The most sets (climbs) a 4x4 runs. */
export const MAX_STAGE_SETS = 10;

const isWholeNumberIn = (candidate: unknown, min: number, max: number): candidate is number =>
  typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= min && candidate <= max;

// Options come from steppers, a partner payload or persisted state. Rounding and
// clamping here means the pacing a run stores always passes `isWorkoutStagePacing`.
const wholeNumberIn = (candidate: number, min: number, max: number): number =>
  Number.isFinite(candidate) ? Math.min(max, Math.max(min, Math.round(candidate))) : min;

const stageRest = (seconds: number): number => wholeNumberIn(seconds, 0, MAX_STAGE_REST_SECONDS);

/** The pacing a block's stage runs with. Undefined for every untimed type: the global rest settings apply. */
export function pacingForOptions(options: GeneratorOptions): WorkoutStagePacing | undefined {
  switch (options.type) {
    case 'onTheMinute':
      return {
        mode: 'onTheMinute',
        restSeconds: wholeNumberIn(options.intervalSeconds, MIN_STAGE_INTERVAL_SECONDS, MAX_STAGE_REST_SECONDS),
      };
    case 'fourByFour':
      // Every rep is a tick, a fall included, so the set counts ticks.
      return {
        mode: 'afterTick',
        restSeconds: stageRest(options.restBetweenRepsSeconds),
        advanceOn: 'set',
        sets: {
          repsPerSet: wholeNumberIn(options.repsPerSet, MIN_STAGE_REPS_PER_SET, MAX_STAGE_REPS_PER_SET),
          restBetweenSetsSeconds: stageRest(options.restBetweenSetsSeconds),
        },
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

/**
 * The rest after one logged climb of the stage, in seconds. `closesSet`: on a
 * 4x4, the tick was the set's last rep, so the set rest follows and then the
 * wall moves on. A rest that moves the wall never drops below the changeover,
 * and an interval never below 15 s. A 4x4's rest between reps never moves the
 * wall, so it runs as set, and 0 is no rest at all.
 */
export function stageRestSeconds(pacing: WorkoutStagePacing, closesSet: boolean): number {
  if (pacing.mode === 'onTheMinute') return Math.max(MIN_STAGE_INTERVAL_SECONDS, pacing.restSeconds);
  if (pacing.sets === undefined) return Math.max(STAGE_CHANGEOVER_SECONDS, pacing.restSeconds);
  return closesSet ? Math.max(STAGE_CHANGEOVER_SECONDS, pacing.sets.restBetweenSetsSeconds) : pacing.restSeconds;
}

function isStageSetPacing(candidate: unknown): candidate is StageSetPacing {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const sets = candidate as Record<string, unknown>;
  return (
    isWholeNumberIn(sets.repsPerSet, MIN_STAGE_REPS_PER_SET, MAX_STAGE_REPS_PER_SET) &&
    isWholeNumberIn(sets.restBetweenSetsSeconds, 0, MAX_STAGE_REST_SECONDS)
  );
}

/**
 * True when stored data is pacing this bundle can run. Rejects an unknown mode
 * or advance rule, and seconds that are not whole or out of range, so a run
 * written by a newer bundle loses just its pacing rather than misreading it.
 * `sets` goes with `set` and nothing else: one without the other is no shape
 * any bundle writes.
 *
 * Also rejects the round 4x4 a tester's run may still hold from before sets
 * (`restBetweenRoundsSeconds`): its queue holds every climb once per round, so
 * read as sets it would ask for four reps on each of sixteen climbs. Unpaced,
 * its climbs read as an ordinary block on the climber's own rest settings.
 */
export function isWorkoutStagePacing(candidate: unknown): candidate is WorkoutStagePacing {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const pacing = candidate as Record<string, unknown>;
  if (pacing.mode === 'onTheMinute') {
    return isWholeNumberIn(pacing.restSeconds, MIN_STAGE_INTERVAL_SECONDS, MAX_STAGE_REST_SECONDS);
  }
  if (pacing.mode !== 'afterTick') return false;
  if (!isWholeNumberIn(pacing.restSeconds, 0, MAX_STAGE_REST_SECONDS)) return false;
  if (pacing.restBetweenRoundsSeconds !== undefined) return false;
  if (pacing.advanceOn === 'set') return isStageSetPacing(pacing.sets);
  return (pacing.advanceOn === 'tick' || pacing.advanceOn === 'send') && pacing.sets === undefined;
}
