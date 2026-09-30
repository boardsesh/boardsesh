import {
  generateWorkoutPlan,
  type BaseGeneratorOptions,
  type GeneratorGradeScale,
} from '@boardsesh/playlist-generator';
import type { WorkoutKind } from './catalog';
import type { WorkoutTiming } from './engine';

/**
 * Everything a workout can be tuned by. One flat shape for every kind keeps the
 * setup form simple; each kind reads only the fields it uses (see `usesField`).
 */
export type WorkoutConfig = {
  kind: WorkoutKind;
  /** Difficulty id: the peak for pyramids and ladders, the working grade for the rest. */
  targetGrade: number;
  /** Climbs in the main set: volume, grade focus, on the minute, limit problems. */
  climbs: number;
  /** Pyramid and ladder: grades climbed on the way up. */
  steps: number;
  climbsPerStep: number;
  /** Volume: how far each climb may stray from the target, in grades. */
  spread: number;
  /** Add a short warm-up before the main set. */
  warmUp: boolean;
  /** The warm-up workout itself: 4 climbs or 12. */
  warmUpLength: 'standard' | 'extended';
  /** Rest after each climb, or after each attempt in limit bouldering. 0 turns the timer off. */
  restSeconds: number;
  intervalSeconds: number;
  rounds: number;
  restBetweenClimbsSeconds: number;
  restBetweenRoundsSeconds: number;
  /** Free climbing: how long to aim for; null for open-ended. */
  goalMinutes: number | null;
  /** Prefer climbs the climber hasn't sent yet. Needs sign-in. */
  freshClimbsOnly: boolean;
};

export type ConfigField = Exclude<keyof WorkoutConfig, 'kind' | 'targetGrade'>;

const FIELDS: Record<WorkoutKind, ConfigField[]> = {
  warmUp: ['warmUpLength', 'restSeconds'],
  pyramid: ['steps', 'climbsPerStep', 'restSeconds', 'warmUp', 'freshClimbsOnly'],
  ladder: ['steps', 'climbsPerStep', 'restSeconds', 'warmUp', 'freshClimbsOnly'],
  volume: ['climbs', 'spread', 'restSeconds', 'warmUp', 'freshClimbsOnly'],
  gradeFocus: ['climbs', 'restSeconds', 'warmUp', 'freshClimbsOnly'],
  onTheMinute: ['climbs', 'intervalSeconds', 'freshClimbsOnly'],
  fourByFour: ['rounds', 'restBetweenClimbsSeconds', 'restBetweenRoundsSeconds', 'freshClimbsOnly'],
  limitBouldering: ['climbs', 'restSeconds', 'freshClimbsOnly'],
  freeClimbing: ['goalMinutes'],
};

export function usesField(kind: WorkoutKind, field: ConfigField): boolean {
  return FIELDS[kind].includes(field);
}

const BASE: Omit<WorkoutConfig, 'kind' | 'targetGrade'> = {
  climbs: 10,
  steps: 5,
  climbsPerStep: 1,
  spread: 1,
  warmUp: true,
  warmUpLength: 'standard',
  restSeconds: 120,
  intervalSeconds: 60,
  rounds: 4,
  restBetweenClimbsSeconds: 0,
  restBetweenRoundsSeconds: 240,
  goalMinutes: 60,
  freshClimbsOnly: false,
};

const KIND_DEFAULTS: Record<WorkoutKind, Partial<WorkoutConfig>> = {
  warmUp: { restSeconds: 60 },
  pyramid: { freshClimbsOnly: true },
  ladder: { climbsPerStep: 2, freshClimbsOnly: true },
  volume: { climbs: 20, restSeconds: 60, freshClimbsOnly: true },
  gradeFocus: { freshClimbsOnly: true },
  onTheMinute: {},
  fourByFour: {},
  limitBouldering: { climbs: 3, restSeconds: 180, freshClimbsOnly: true },
  freeClimbing: {},
};

export function defaultConfig(kind: WorkoutKind, targetGrade: number): WorkoutConfig {
  return { ...BASE, ...KIND_DEFAULTS[kind], kind, targetGrade };
}

// The generator also filters climbs, but Boardz picks climbs itself (see
// pick-climbs.ts), so these only need to satisfy the type.
const GENERATOR_FILTERS: Omit<BaseGeneratorOptions, 'warmUp' | 'targetGrade'> = {
  climbBias: 'any',
  minAscents: 0,
  minRating: 0,
  onlyTallClimbs: false,
  onlyWideClimbs: false,
};

/** The grade of every climb in the workout, in order. 4x4 lists its four climbs once. */
export function plannedGrades(config: WorkoutConfig, grades: GeneratorGradeScale): number[] {
  const base = {
    ...GENERATOR_FILTERS,
    targetGrade: config.targetGrade,
    warmUp: config.warmUp ? 'standard' : 'none',
  } as const;
  const toGrades = (slots: { grade: number }[]) => slots.map((slot) => slot.grade);
  switch (config.kind) {
    case 'warmUp':
      // A warm-up is the generator's warm-up section with no main set after it.
      return toGrades(
        generateWorkoutPlan({ ...base, type: 'gradeFocus', warmUp: config.warmUpLength, numberOfClimbs: 0 }, grades),
      );
    case 'pyramid':
      return toGrades(
        generateWorkoutPlan(
          { ...base, type: 'pyramid', numberOfSteps: config.steps, climbsPerStep: config.climbsPerStep },
          grades,
        ),
      );
    case 'ladder':
      return toGrades(
        generateWorkoutPlan(
          { ...base, type: 'ladder', numberOfSteps: config.steps, climbsPerStep: config.climbsPerStep },
          grades,
        ),
      );
    case 'volume':
      return toGrades(
        generateWorkoutPlan(
          { ...base, type: 'volume', mainSetClimbs: config.climbs, mainSetVariability: config.spread },
          grades,
        ),
      );
    case 'gradeFocus':
      return toGrades(generateWorkoutPlan({ ...base, type: 'gradeFocus', numberOfClimbs: config.climbs }, grades));
    case 'onTheMinute':
    case 'limitBouldering':
      return Array.from({ length: config.climbs }, () => config.targetGrade);
    case 'fourByFour':
      return Array.from({ length: 4 }, () => config.targetGrade);
    case 'freeClimbing':
      return [];
  }
}

/** How the runner paces the workout. Null for free climbing, which is just a clock. */
export function workoutTiming(config: WorkoutConfig): WorkoutTiming | null {
  switch (config.kind) {
    case 'warmUp':
    case 'pyramid':
    case 'ladder':
    case 'volume':
    case 'gradeFocus':
      return { kind: 'rest', restSeconds: config.restSeconds };
    case 'onTheMinute':
      return { kind: 'interval', intervalSeconds: config.intervalSeconds };
    case 'fourByFour':
      return {
        kind: 'rounds',
        rounds: config.rounds,
        restBetweenClimbsSeconds: config.restBetweenClimbsSeconds,
        restBetweenRoundsSeconds: config.restBetweenRoundsSeconds,
      };
    case 'limitBouldering':
      return { kind: 'limit', restSeconds: config.restSeconds };
    case 'freeClimbing':
      return null;
  }
}

export function workoutTitle(config: WorkoutConfig, grade: string): string {
  switch (config.kind) {
    case 'warmUp':
      return `Warm-up to ${grade}`;
    case 'pyramid':
      return `Pyramid to ${grade}`;
    case 'ladder':
      return `Ladder to ${grade}`;
    case 'volume':
      return `Volume around ${grade}`;
    case 'gradeFocus':
      return `${grade} grade focus`;
    case 'onTheMinute':
      return `On the minute at ${grade}`;
    case 'fourByFour':
      return `4x4 at ${grade}`;
    case 'limitBouldering':
      return `Limit bouldering at ${grade}`;
    case 'freeClimbing':
      return 'Free climbing';
  }
}

// Rough time on the wall per go, used only for the duration estimate.
const MINUTES_PER_CLIMB = 1.5;
const ATTEMPTS_PER_LIMIT_PROBLEM = 5;

/** About how long the workout takes, for the setup screen. */
export function estimateMinutes(config: WorkoutConfig, climbCount: number): number {
  const minutes = (() => {
    switch (config.kind) {
      case 'onTheMinute':
        return (climbCount * config.intervalSeconds) / 60;
      case 'fourByFour':
        return (
          config.rounds * climbCount * (MINUTES_PER_CLIMB / 2 + config.restBetweenClimbsSeconds / 60) +
          ((config.rounds - 1) * config.restBetweenRoundsSeconds) / 60
        );
      case 'limitBouldering':
        return climbCount * ATTEMPTS_PER_LIMIT_PROBLEM * (MINUTES_PER_CLIMB / 3 + config.restSeconds / 60);
      case 'freeClimbing':
        return config.goalMinutes ?? 0;
      default:
        return climbCount * (MINUTES_PER_CLIMB + config.restSeconds / 60);
    }
  })();
  return Math.max(1, Math.round(minutes / 5) * 5);
}
