// The workout runner as a pure state machine. The screen feeds it the
// climber's taps and the clock; it answers with the next state and, when a tap
// means something should go in the logbook, what to log. Times are epoch
// milliseconds, so a workout survives the app going to the background.

export type WorkoutTiming =
  /** Pyramid, ladder, volume, grade focus, warm-up: rest after each climb, retry after a fall. */
  | { kind: 'rest'; restSeconds: number }
  /** On the minute: one climb per interval; the board moves on by itself. */
  | { kind: 'interval'; intervalSeconds: number }
  /** 4x4: the same climbs every round, short rests between climbs, a long rest between rounds. */
  | { kind: 'rounds'; rounds: number; restBetweenClimbsSeconds: number; restBetweenRoundsSeconds: number }
  /** Limit bouldering: a long rest after every attempt, on the same problem until it goes. */
  | { kind: 'limit'; restSeconds: number };

export type WorkoutStep = { climbIndex: number; round: number };

export type StepOutcome = 'sent' | 'attempted' | 'skipped';

export type RunnerPhase =
  | { kind: 'climbing'; stepIndex: number; endsAt: number | null; logged: boolean }
  | { kind: 'resting'; nextStepIndex: number; endsAt: number; getReady: boolean }
  | { kind: 'done' };

export type RunnerState = {
  startedAt: number;
  finishedAt: number | null;
  phase: RunnerPhase;
  outcomes: (StepOutcome | null)[];
  /** Falls on the current step so far. */
  attemptsOnStep: number;
};

export type RunnerEvent =
  | { type: 'sent'; at: number }
  | { type: 'fell'; at: number }
  /** Leave this climb. Attempts already made are logged. */
  | { type: 'moveOn'; at: number }
  | { type: 'skipRest'; at: number }
  | { type: 'tick'; at: number }
  | { type: 'finish'; at: number };

/** Something to write to the logbook for the climb at `stepIndex`. */
export type RunnerLog = { stepIndex: number; outcome: 'sent' | 'attempted'; attempts: number };

export type RunnerResult = { state: RunnerState; log: RunnerLog | null };

const GET_READY_MS = 10_000;

type RunnablePlan = { timing: WorkoutTiming; climbCount: number };

export function workoutSteps({ timing, climbCount }: RunnablePlan): WorkoutStep[] {
  const rounds = timing.kind === 'rounds' ? timing.rounds : 1;
  const steps: WorkoutStep[] = [];
  for (let round = 1; round <= rounds; round++) {
    for (let climbIndex = 0; climbIndex < climbCount; climbIndex++) steps.push({ climbIndex, round });
  }
  return steps;
}

function stepCount(plan: RunnablePlan): number {
  return plan.timing.kind === 'rounds' ? plan.timing.rounds * plan.climbCount : plan.climbCount;
}

/** Seconds of rest before `nextStepIndex`, when arriving from the step before it. */
function restBefore(plan: RunnablePlan, nextStepIndex: number): number {
  const { timing } = plan;
  switch (timing.kind) {
    case 'rest':
    case 'limit':
      return timing.restSeconds;
    case 'rounds':
      return nextStepIndex % plan.climbCount === 0 ? timing.restBetweenRoundsSeconds : timing.restBetweenClimbsSeconds;
    case 'interval':
      return 0;
  }
}

function climbing(stepIndex: number, endsAt: number | null): RunnerPhase {
  return { kind: 'climbing', stepIndex, endsAt, logged: false };
}

export function startRunner(plan: RunnablePlan, now: number): RunnerState {
  const outcomes = Array.from<StepOutcome | null>({ length: stepCount(plan) }).fill(null);
  if (outcomes.length === 0) {
    return { startedAt: now, finishedAt: now, phase: { kind: 'done' }, outcomes, attemptsOnStep: 0 };
  }
  // Timed workouts count the climber in; the others start straight away.
  const timed = plan.timing.kind === 'interval' || plan.timing.kind === 'rounds';
  return {
    startedAt: now,
    finishedAt: null,
    phase: timed
      ? { kind: 'resting', nextStepIndex: 0, endsAt: now + GET_READY_MS, getReady: true }
      : climbing(0, null),
    outcomes,
    attemptsOnStep: 0,
  };
}

function withOutcome(state: RunnerState, stepIndex: number, outcome: StepOutcome): RunnerState {
  const outcomes = [...state.outcomes];
  outcomes[stepIndex] = outcome;
  return { ...state, outcomes };
}

function finished(state: RunnerState, at: number): RunnerState {
  return { ...state, phase: { kind: 'done' }, finishedAt: at, attemptsOnStep: 0 };
}

/** Move past `fromStep`: done, a rest, or straight onto the next climb. */
function advance(plan: RunnablePlan, state: RunnerState, fromStep: number, at: number): RunnerState {
  const next = fromStep + 1;
  if (next >= state.outcomes.length) return finished(state, at);
  const base = { ...state, attemptsOnStep: 0 };
  if (plan.timing.kind === 'interval') {
    return { ...base, phase: climbing(next, at + plan.timing.intervalSeconds * 1000) };
  }
  const rest = restBefore(plan, next);
  return rest > 0
    ? { ...base, phase: { kind: 'resting', nextStepIndex: next, endsAt: at + rest * 1000, getReady: false } }
    : { ...base, phase: climbing(next, null) };
}

/** Enter the climb a rest was leading to. Interval workouts start that climb's clock. */
function endRest(plan: RunnablePlan, state: RunnerState, nextStepIndex: number, at: number): RunnerState {
  const endsAt = plan.timing.kind === 'interval' ? at + plan.timing.intervalSeconds * 1000 : null;
  return { ...state, phase: climbing(nextStepIndex, endsAt) };
}

export function applyEvent(plan: RunnablePlan, state: RunnerState, event: RunnerEvent): RunnerResult {
  const { phase } = state;
  if (phase.kind === 'done') return { state, log: null };

  if (event.type === 'finish') return { state: finished(state, event.at), log: null };

  if (phase.kind === 'resting') {
    if (event.type === 'skipRest' || (event.type === 'tick' && event.at >= phase.endsAt)) {
      // A late tick starts the climb when the rest was due to end, not when the app noticed.
      const startAt = event.type === 'tick' ? phase.endsAt : event.at;
      return { state: endRest(plan, state, phase.nextStepIndex, startAt), log: null };
    }
    return { state, log: null };
  }

  // Climbing.
  const { stepIndex } = phase;
  const tries = state.attemptsOnStep + 1;

  if (event.type === 'tick') {
    if (phase.endsAt === null || event.at < phase.endsAt) return { state, log: null };
    // The interval ran out. Catch up on every interval that passed while the app was away.
    let current: RunnerState = phase.logged ? state : withOutcome(state, stepIndex, 'skipped');
    let intervalEnd = phase.endsAt;
    let index = stepIndex;
    const intervalMs = plan.timing.kind === 'interval' ? plan.timing.intervalSeconds * 1000 : 0;
    while (true) {
      const next = index + 1;
      if (next >= current.outcomes.length) return { state: finished(current, intervalEnd), log: null };
      if (event.at < intervalEnd + intervalMs) {
        return { state: { ...current, attemptsOnStep: 0, phase: climbing(next, intervalEnd + intervalMs) }, log: null };
      }
      current = withOutcome(current, next, 'skipped');
      intervalEnd += intervalMs;
      index = next;
    }
  }

  if (event.type === 'skipRest') return { state, log: null };

  if (phase.logged) {
    // Only interval workouts wait out a logged climb; everything else has moved on already.
    return event.type === 'moveOn'
      ? { state: advance(plan, state, stepIndex, event.at), log: null }
      : { state, log: null };
  }

  if (event.type === 'sent') {
    const logged = withOutcome(state, stepIndex, 'sent');
    const log: RunnerLog = { stepIndex, outcome: 'sent', attempts: tries };
    if (plan.timing.kind === 'interval') {
      return { state: { ...logged, attemptsOnStep: tries, phase: { ...phase, logged: true } }, log };
    }
    return { state: advance(plan, logged, stepIndex, event.at), log };
  }

  if (event.type === 'fell') {
    switch (plan.timing.kind) {
      case 'interval': {
        const logged = withOutcome(state, stepIndex, 'attempted');
        return {
          state: { ...logged, attemptsOnStep: tries, phase: { ...phase, logged: true } },
          log: { stepIndex, outcome: 'attempted', attempts: tries },
        };
      }
      case 'rounds':
        return {
          state: advance(plan, withOutcome(state, stepIndex, 'attempted'), stepIndex, event.at),
          log: { stepIndex, outcome: 'attempted', attempts: tries },
        };
      case 'rest':
      case 'limit': {
        // Rest, then another go at the same climb.
        const rest = plan.timing.restSeconds;
        const retry: RunnerPhase =
          rest > 0
            ? { kind: 'resting', nextStepIndex: stepIndex, endsAt: event.at + rest * 1000, getReady: false }
            : phase;
        return { state: { ...state, attemptsOnStep: tries, phase: retry }, log: null };
      }
    }
  }

  // moveOn: log the falls already taken on this climb, if any.
  if (state.attemptsOnStep > 0) {
    return {
      state: advance(plan, withOutcome(state, stepIndex, 'attempted'), stepIndex, event.at),
      log: { stepIndex, outcome: 'attempted', attempts: state.attemptsOnStep },
    };
  }
  return { state: advance(plan, withOutcome(state, stepIndex, 'skipped'), stepIndex, event.at), log: null };
}

/** Milliseconds left on the phase's clock, or null when nothing is counting down. */
export function msRemaining(state: RunnerState, now: number): number | null {
  const { phase } = state;
  if (phase.kind === 'done') return null;
  if (phase.kind === 'resting') return Math.max(0, phase.endsAt - now);
  return phase.endsAt === null ? null : Math.max(0, phase.endsAt - now);
}

export type RunnerSummary = { sent: number; attempted: number; skipped: number; total: number };

export function summarizeRunner(state: RunnerState): RunnerSummary {
  let sent = 0;
  let attempted = 0;
  let skipped = 0;
  for (const outcome of state.outcomes) {
    if (outcome === 'sent') sent += 1;
    else if (outcome === 'attempted') attempted += 1;
    else if (outcome === 'skipped') skipped += 1;
  }
  return { sent, attempted, skipped, total: state.outcomes.length };
}
