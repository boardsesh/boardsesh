// The workout runner's view of a session in progress (#6291, #5380, #6231): which
// phase the climber is in (climbing, resting, done), where the current climb sits
// (and which try or rep the climber is on), what Next lands on, the rest the climb
// on the wall gets, and what every staged climb came to (sent, tried, skipped).
//
// Pure, and built on `describeWorkoutRun` and `locateInRun`, so the runner, the
// card and the player subtitle never disagree about positions. The rest comes
// from the rest-timer store's `stagePacing`, the same value the timer and the
// auto-advance scheduler run on, and whether that rest moves the wall is the
// scheduler's own rule: this phone may move it (`canAdvanceQueue`) and the
// stage's rule is met (`restAdvanceAllowed`). No clock: countdown digits only
// ever come from the `RestTimerClock` leaf, never from here.
//
// Outcomes come from the phone-side tick log (`workout-run-store`): the server's
// ticks carry no queue item. So a tick logged on another device, or deleted later
// from the session detail, is not reflected here.

import {
  type WorkoutRun,
  type WorkoutRunPosition,
  type WorkoutRunStage,
  type WorkoutStageKind,
} from '@boardsesh/playlist-generator';
import type { RestTimerMode } from './rest-timer';
import { restAdvanceAllowed, stageHasRepsLeft, type RestAdvanceRule } from './rest-timer-pacing';
import type { RestTimerState } from './rest-timer-store';
import { countWorkoutRunTicks, type WorkoutTickLogEntry } from './workout-run-store';
import { describeWorkoutRun, type WorkoutClimbGo, type WorkoutStageReadout } from './workout-run-readout';

/** The rest-timer fields the runner reads. `RestTimerState` itself satisfies it. */
export type WorkoutRunnerRestSnapshot = Pick<
  RestTimerState,
  'armed' | 'isRunning' | 'anchorMs' | 'lastTick' | 'stagePacing' | 'queueEnded'
> &
  Partial<Pick<RestTimerState, 'advancedFromQueueItemUuid'>>;

export type WorkoutRunnerInput = {
  run: WorkoutRun;
  /** The queue's item uuids, in queue order. */
  queueUuids: readonly string[];
  currentUuid: string | null;
  /**
   * What Next lands on (`selectNextQueueItemWithSuggestions(...).item?.uuid`). It
   * can be a climb from a list the climber is walking, so it is not simply the
   * next queue position.
   */
  nextUuid: string | null;
  log: readonly WorkoutTickLogEntry[];
  rest: WorkoutRunnerRestSnapshot;
  /**
   * This phone may move the wall (`useSessionTimerDriver().canAdvanceQueue`):
   * solo, or holding the wall in a crew. The scheduler never moves it otherwise.
   */
  canAdvanceQueue: boolean;
};

export type WorkoutRunnerPhase = 'climbing' | 'resting' | 'done';

/**
 * What one staged climb came to. `upcoming`: not reached yet, the current climb
 * included until it is logged. `skipped`: passed with nothing logged on it.
 */
export type WorkoutClimbOutcomeKind = 'sent' | 'tried' | 'skipped' | 'upcoming';

export type WorkoutClimbOutcome = {
  queueItemUuid: string;
  /** Ticks logged on this queue item on this phone, a flash or send included. */
  attempts: number;
  /** A flash or a send was logged on it. */
  sent: boolean;
  outcome: WorkoutClimbOutcomeKind;
};

export type WorkoutClimbTally = { sent: number; tried: number; skipped: number; total: number };

export type WorkoutRunnerStageReadout = WorkoutStageReadout & {
  tally: WorkoutClimbTally;
  /** The stage's queued climbs, in queue order. */
  climbs: WorkoutClimbOutcome[];
  /** Nothing in the stage is left to climb, and the climber is past it (or the workout is done). */
  finished: boolean;
  /**
   * Something in the stage was sent or tried on this phone. A stage passed with
   * nothing logged here may well have been climbed on another phone.
   */
  logged: boolean;
};

export type WorkoutRunnerCurrent = {
  queueItemUuid: string;
  attempts: number;
  sent: boolean;
  /** The try or rep the climber is on (`workoutClimbGo`). Null on every other stage, and once a limit climb is sent. */
  go: WorkoutClimbGo | null;
};

export type WorkoutRunnerNext = {
  queueItemUuid: string;
  /** Null when Next lands on a climb in no stage (hand-queued, or from a list). */
  stageId: string | null;
  kind: WorkoutStageKind | null;
  /** Next is the first climb of another stage than the current one. */
  startsStage: boolean;
};

export type WorkoutRunnerRest = {
  mode: RestTimerMode;
  /**
   * The rest after the current climb's latest tick: the changeover, the
   * interval, a 4x4's rest between reps or its set rest. Null between reps
   * with no rest between them.
   */
  targetSeconds: number | null;
  advanceOn: RestAdvanceRule;
  /**
   * When this rest runs out, this phone moves the wall on: `drivesWall` and not
   * `staysOnClimb`, the scheduler's whole rule.
   */
  advances: boolean;
  /**
   * The stage's rule keeps the climb on the wall when the rest runs out
   * (`restAdvanceAllowed` says no): after a fall on a limit climb, the next try
   * is on it, and on a 4x4 the next rep until the set is done. Whichever phone
   * holds the wall.
   */
  staysOnClimb: boolean;
  /** A 4x4 set with reps left: the rep this rest leads to. Null everywhere else. */
  nextRep: { number: number; total: number } | null;
  /** This phone may move the wall (`canAdvanceQueue`). In a crew, only the phone holding it does. */
  drivesWall: boolean;
  /** On the minute, on the last staged climb: its beat ends the workout. */
  endsWorkout: boolean;
  /** Every rep of the current 4x4 set is logged, so this is the set rest. */
  closesSet: boolean;
  armed: boolean;
  /** Armed and frozen. */
  paused: boolean;
  /**
   * The timer is timing this rest, so a clock is worth showing: resting after
   * the tick, or on the minute, whose beat runs whether the climb was logged yet
   * or not, until a beat finds nothing to move on to (`queueEnded`).
   */
  timing: boolean;
};

export type WorkoutRunnerReadout = {
  phase: WorkoutRunnerPhase;
  /** Where the current climb sits. Null when it is in no stage. */
  position: WorkoutRunPosition | null;
  /** The current climb among every queued staged climb, in queue order. */
  overall: { position: number; total: number } | null;
  current: WorkoutRunnerCurrent | null;
  next: WorkoutRunnerNext | null;
  /** Null outside a stage that paces the rest timer (or before the store caught up with the climb). */
  rest: WorkoutRunnerRest | null;
  /**
   * The staged climb to go to while the current climb is in no stage: the first
   * one still `upcoming`. That is the workout climb the climber left for the
   * off-plan one while nothing is logged on it, else the first one not reached
   * yet. Null when the current climb is staged, or the workout is done.
   */
  resumeUuid: string | null;
  stages: WorkoutRunnerStageReadout[];
  /**
   * What the `logged` stages came to, together. A stage with nothing logged on
   * this phone adds nothing, its passed climbs included, as its row keeps its
   * climb count: they may have been logged on another phone.
   */
  totals: WorkoutClimbTally;
};

type ClimbLog = { attempts: number; sent: boolean };

const NOT_LOGGED: ClimbLog = { attempts: 0, sent: false };

/** A stage that keeps the climber on a climb until it is sent: limit bouldering. */
export function stageHoldsUntilSent(stage: Pick<WorkoutRunStage, 'pacing'> | undefined): boolean {
  return stage?.pacing?.mode === 'afterTick' && stage.pacing.advanceOn === 'send';
}

/** The reps each climb of a 4x4 stage takes. Null for every other stage. */
export function stageRepsPerSet(stage: Pick<WorkoutRunStage, 'pacing'> | undefined): number | null {
  return stage?.pacing?.mode === 'afterTick' ? (stage.pacing.sets?.repsPerSet ?? null) : null;
}

function logByQueueItem(log: readonly WorkoutTickLogEntry[]): Map<string, ClimbLog> {
  const byUuid = new Map<string, ClimbLog>();
  for (const { queueItemUuid, status } of log) {
    const logged = byUuid.get(queueItemUuid) ?? NOT_LOGGED;
    byUuid.set(queueItemUuid, {
      attempts: logged.attempts + 1,
      sent: logged.sent || status === 'flash' || status === 'send',
    });
  }
  return byUuid;
}

/**
 * The try or rep a climber is on for one queue item of the run: on a limit
 * climb the try (null once it is sent), on a 4x4 the rep, counting every tick
 * as one, a fall included, and staying on the set's last rep once it is
 * logged. Null on every other stage. The player subtitle's "· Try 3" or
 * "Rep 3 of 4 · Set 2 of 4" and the runner read it the same way.
 */
export function workoutClimbGo(
  run: WorkoutRun,
  stageId: string,
  queueItemUuid: string,
  log: readonly WorkoutTickLogEntry[],
): WorkoutClimbGo | null {
  const stage = run.stages.find((runStage) => runStage.id === stageId);
  const repsPerSet = stageRepsPerSet(stage);
  if (repsPerSet !== null) {
    const repsLogged = countWorkoutRunTicks(log, queueItemUuid);
    return { kind: 'rep', number: Math.min(repsLogged + 1, repsPerSet), total: repsPerSet };
  }
  if (!stageHoldsUntilSent(stage)) return null;
  let attempts = 0;
  for (const entry of log) {
    if (entry.queueItemUuid !== queueItemUuid) continue;
    if (entry.status === 'flash' || entry.status === 'send') return null;
    attempts += 1;
  }
  return { kind: 'try', number: attempts + 1 };
}

function emptyTally(): WorkoutClimbTally {
  return { sent: 0, tried: 0, skipped: 0, total: 0 };
}

function addToTally(tally: WorkoutClimbTally, outcome: WorkoutClimbOutcomeKind): void {
  tally.total += 1;
  if (outcome === 'sent') tally.sent += 1;
  else if (outcome === 'tried') tally.tried += 1;
  else if (outcome === 'skipped') tally.skipped += 1;
}

/**
 * The runner's view of the run. Null when no stage has a climb left in the queue,
 * like `describeWorkoutRun`, so the card falls back to offering a fresh block.
 *
 * - `done`: the climber is past every staged climb, or on the last one and it met
 *   its stage's rule (sent, on a stage that stays until sent; every rep logged,
 *   on a 4x4; on the minute, its beat ran out with nothing after it, or it was
 *   logged; logged, on any other).
 * - `resting`: the current climb's stage paces the timer, the timer is armed with
 *   a rest to count from, and the last tick it took was on the current climb.
 *   Paused counts: the rest is still the rest, frozen. Between two reps of a 4x4
 *   set with no rest between them there is no rest to count: still climbing.
 * - `climbing`: everything else, an off-plan current climb included.
 *
 * A staged climb is `skipped` once the current climb sits after it in the queue
 * (or its last beat ran out) with nothing logged on it. One exception: with an
 * off-plan climb on the wall, the staged climb just before it is the one the
 * climber left for it (a list or search tap inserts after the climb on the wall),
 * so while nothing is logged on it, it stays `upcoming`. Only queued climbs
 * count, as everywhere in the run.
 */
export function describeWorkoutRunner({
  run,
  queueUuids,
  currentUuid,
  nextUuid,
  log,
  rest,
  canAdvanceQueue,
}: WorkoutRunnerInput): WorkoutRunnerReadout | null {
  const runReadout = describeWorkoutRun(run, queueUuids, currentUuid);
  if (!runReadout) return null;
  const position = runReadout.current;

  const queuePositionByUuid = new Map<string, number>();
  queueUuids.forEach((uuid, queuePosition) => {
    if (!queuePositionByUuid.has(uuid)) queuePositionByUuid.set(uuid, queuePosition);
  });
  const runStageById = new Map(run.stages.map((runStage) => [runStage.id, runStage]));
  const stageIdByUuid = new Map<string, string>();
  for (const runStage of run.stages) {
    for (const uuid of runStage.itemUuids) if (!stageIdByUuid.has(uuid)) stageIdByUuid.set(uuid, runStage.id);
  }
  const climbLogs = logByQueueItem(log);
  const climbLog = (uuid: string): ClimbLog => climbLogs.get(uuid) ?? NOT_LOGGED;

  // The store's stage pacing is the current climb's once RestTimerPacingSync has
  // seen it; until then (one effect later) there is no rest to describe.
  const stagePacing =
    position !== null &&
    rest.stagePacing?.queueItemUuid === currentUuid &&
    rest.stagePacing.stageId === position.stageId
      ? rest.stagePacing
      : null;

  // Queue order: the map's keys keep the order uuids were first seen in.
  const stagedInQueueOrder = [...queuePositionByUuid.keys()].filter((uuid) => stageIdByUuid.has(uuid));
  const lastStagedUuid = stagedInQueueOrder.at(-1);
  const onLastStaged = lastStagedUuid !== undefined && lastStagedUuid === currentUuid;
  // On the minute the beat moves the climber on, logged or not. On the last
  // staged climb with nothing after it, the beat that ran out finds no climb and
  // the scheduler latches `queueEnded`: the climber is past that climb too.
  const lastBeatRanOut = onLastStaged && stagePacing?.mode === 'onTheMinute' && rest.queueEnded;
  const currentQueuePosition = currentUuid === null ? undefined : queuePositionByUuid.get(currentUuid);
  const isBeforeCurrent = (uuid: string): boolean =>
    currentQueuePosition !== undefined && (queuePositionByUuid.get(uuid) ?? Infinity) < currentQueuePosition;
  // A climb opened from a list or search goes into the queue right after the
  // climb on the wall. So with an off-plan climb up, the last staged climb before
  // it is the one the climber left for it. While nothing is logged on it, it is
  // still to come, not skipped, and "Back to your workout" returns to it.
  const leftUuid = position === null ? stagedInQueueOrder.filter(isBeforeCurrent).at(-1) : undefined;
  const leftUnclimbedUuid = leftUuid !== undefined && climbLog(leftUuid).attempts === 0 ? leftUuid : undefined;
  const isPassed = (uuid: string): boolean =>
    (isBeforeCurrent(uuid) && uuid !== leftUnclimbedUuid) || (lastBeatRanOut && uuid === currentUuid);

  const lastStagedMetItsRule = (() => {
    if (lastStagedUuid === undefined || !onLastStaged) return false;
    const logged = climbLog(lastStagedUuid);
    const stageId = stageIdByUuid.get(lastStagedUuid);
    const lastStage = stageId === undefined ? undefined : runStageById.get(stageId);
    const repsPerSet = stageRepsPerSet(lastStage);
    if (repsPerSet !== null) return logged.attempts >= repsPerSet;
    return stageHoldsUntilSent(lastStage) ? logged.sent : logged.attempts > 0;
  })();
  const done = lastStagedUuid !== undefined && (isPassed(lastStagedUuid) || lastStagedMetItsRule);

  const resting =
    !done &&
    stagePacing !== null &&
    stagePacing.targetSeconds !== null &&
    rest.armed &&
    rest.anchorMs !== null &&
    rest.lastTick !== null &&
    rest.lastTick.queueItemUuid === currentUuid;
  const phase: WorkoutRunnerPhase = done ? 'done' : resting ? 'resting' : 'climbing';

  const outcomeOf = (uuid: string): WorkoutClimbOutcome => {
    const { attempts, sent } = climbLog(uuid);
    const outcome: WorkoutClimbOutcomeKind = sent
      ? 'sent'
      : attempts > 0
        ? 'tried'
        : isPassed(uuid)
          ? 'skipped'
          : 'upcoming';
    return { queueItemUuid: uuid, attempts, sent, outcome };
  };

  const totals = emptyTally();
  const stages = runReadout.stages.map((stageReadout): WorkoutRunnerStageReadout => {
    const runStage = runStageById.get(stageReadout.id);
    const stageUuids = new Set(runStage?.itemUuids.filter((uuid) => stageIdByUuid.get(uuid) === stageReadout.id));
    const climbs = stagedInQueueOrder.filter((uuid) => stageUuids.has(uuid)).map(outcomeOf);
    const tally = emptyTally();
    for (const { outcome } of climbs) addToTally(tally, outcome);
    const logged = tally.sent + tally.tried > 0;
    if (logged) {
      for (const { outcome } of climbs) addToTally(totals, outcome);
    }
    const nothingLeft = climbs.every(({ outcome }) => outcome !== 'upcoming');
    return { ...stageReadout, tally, climbs, finished: nothingLeft && (done || !stageReadout.isCurrent), logged };
  });

  const current: WorkoutRunnerCurrent | null =
    position !== null && currentUuid !== null
      ? {
          queueItemUuid: currentUuid,
          ...climbLog(currentUuid),
          go: workoutClimbGo(run, position.stageId, currentUuid, log),
        }
      : null;

  const overall =
    position !== null && currentUuid !== null
      ? { position: stagedInQueueOrder.indexOf(currentUuid) + 1, total: stagedInQueueOrder.length }
      : null;

  const nextStageId = nextUuid === null ? undefined : stageIdByUuid.get(nextUuid);
  const next: WorkoutRunnerNext | null =
    nextUuid === null
      ? null
      : {
          queueItemUuid: nextUuid,
          stageId: nextStageId ?? null,
          kind: nextStageId === undefined ? null : (runStageById.get(nextStageId)?.kind ?? null),
          startsStage: nextStageId !== undefined && nextStageId !== position?.stageId,
        };

  // The scheduler's rule, both halves: the stage's rule is met, and this phone
  // may move the wall.
  const staysOnClimb =
    stagePacing !== null &&
    !restAdvanceAllowed({
      advanceOn: stagePacing.advanceOn,
      currentQueueItemUuid: currentUuid,
      lastTick: rest.lastTick,
      stage: stagePacing,
      advancedFromQueueItemUuid: rest.advancedFromQueueItemUuid ?? null,
    });
  const repsLeft = stagePacing?.reps !== undefined && stageHasRepsLeft(stagePacing) ? stagePacing.reps : null;
  const onTheMinute = stagePacing?.mode === 'onTheMinute';
  const restReadout: WorkoutRunnerRest | null = stagePacing
    ? {
        mode: stagePacing.mode,
        targetSeconds: stagePacing.targetSeconds,
        advanceOn: stagePacing.advanceOn,
        advances: canAdvanceQueue && !staysOnClimb,
        staysOnClimb,
        nextRep: repsLeft === null ? null : { number: repsLeft.logged + 1, total: repsLeft.perSet },
        drivesWall: canAdvanceQueue,
        endsWorkout: onTheMinute && onLastStaged,
        closesSet: stagePacing.closesSet,
        armed: rest.armed,
        paused: rest.armed && !rest.isRunning,
        timing: rest.armed && rest.anchorMs !== null && (resting || (!done && onTheMinute && !rest.queueEnded)),
      }
    : null;

  const resumeUuid =
    position === null && !done
      ? (stagedInQueueOrder.find((uuid) => outcomeOf(uuid).outcome === 'upcoming') ?? null)
      : null;

  return { phase, position, overall, current, next, rest: restReadout, resumeUuid, stages, totals };
}
