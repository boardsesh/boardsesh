// Playlist Generator Types and Constants
// Pure TS, no React. Web and mobile both consume from here.

export type WorkoutType = 'volume' | 'pyramid' | 'ladder' | 'gradeFocus';

export type WarmUpType = 'standard' | 'extended' | 'none';

export type EffortLevel = 'moderate' | 'challenging' | 'veryDifficult' | 'maxEffort';

export type ClimbBias = 'unfamiliar' | 'attempted' | 'any';

export type BaseGeneratorOptions = {
  warmUp: WarmUpType;
  targetGrade: number;
  climbBias: ClimbBias;
  minAscents: number;
  minRating: number;
  onlyTallClimbs: boolean;
  onlyWideClimbs: boolean;
};

export type VolumeOptions = {
  type: 'volume';
  mainSetClimbs: number;
  mainSetVariability: number;
} & BaseGeneratorOptions;

export type PyramidOptions = {
  type: 'pyramid';
  numberOfSteps: number;
  climbsPerStep: number;
} & BaseGeneratorOptions;

export type LadderOptions = {
  type: 'ladder';
  numberOfSteps: number;
  climbsPerStep: number;
} & BaseGeneratorOptions;

export type GradeFocusOptions = {
  type: 'gradeFocus';
  numberOfClimbs: number;
} & BaseGeneratorOptions;

export type GeneratorOptions = VolumeOptions | PyramidOptions | LadderOptions | GradeFocusOptions;

/** Workout-type metadata for UI rendering. Display labels live in the
 *  consuming app's i18n catalog (web: `playlists:generator.workoutTypes.<type>.name`,
 *  mobile: `session:mobile.session.preGenerator<Type>`). Don't add `name` /
 *  `description` here — keeping the shared package pure-data avoids untranslated
 *  English leaking through `t(variable)` patterns. */
export type WorkoutTypeInfo = {
  type: WorkoutType;
  icon: 'volume' | 'pyramid' | 'ladder' | 'focus';
};

export const WORKOUT_TYPES: WorkoutTypeInfo[] = [
  { type: 'volume', icon: 'volume' },
  { type: 'pyramid', icon: 'pyramid' },
  { type: 'ladder', icon: 'ladder' },
  { type: 'gradeFocus', icon: 'focus' },
];

export const WARM_UP_OPTIONS: WarmUpType[] = ['none', 'standard', 'extended'];

export const EFFORT_LEVELS: EffortLevel[] = ['moderate', 'challenging', 'veryDifficult', 'maxEffort'];

export const CLIMB_BIAS_OPTIONS: ClimbBias[] = ['unfamiliar', 'attempted', 'any'];

export const DEFAULT_VOLUME_OPTIONS: Omit<VolumeOptions, 'targetGrade'> = {
  type: 'volume',
  warmUp: 'none',
  mainSetClimbs: 20,
  mainSetVariability: 0,
  climbBias: 'unfamiliar',
  minAscents: 5,
  minRating: 2,
  onlyTallClimbs: false,
  onlyWideClimbs: false,
};

export const DEFAULT_PYRAMID_OPTIONS: Omit<PyramidOptions, 'targetGrade'> = {
  type: 'pyramid',
  warmUp: 'none',
  numberOfSteps: 5,
  climbsPerStep: 1,
  climbBias: 'unfamiliar',
  minAscents: 5,
  minRating: 2,
  onlyTallClimbs: false,
  onlyWideClimbs: false,
};

export const DEFAULT_LADDER_OPTIONS: Omit<LadderOptions, 'targetGrade'> = {
  type: 'ladder',
  warmUp: 'none',
  numberOfSteps: 5,
  climbsPerStep: 2,
  climbBias: 'unfamiliar',
  minAscents: 5,
  minRating: 2,
  onlyTallClimbs: false,
  onlyWideClimbs: false,
};

export const DEFAULT_GRADE_FOCUS_OPTIONS: Omit<GradeFocusOptions, 'targetGrade'> = {
  type: 'gradeFocus',
  warmUp: 'none',
  numberOfClimbs: 15,
  climbBias: 'unfamiliar',
  minAscents: 5,
  minRating: 2,
  onlyTallClimbs: false,
  onlyWideClimbs: false,
};

export const WARM_UP_CONFIG = {
  standard: { grades: 4, climbsPerGrade: 1 },
  extended: { grades: 6, climbsPerGrade: 2 },
  none: { grades: 0, climbsPerGrade: 0 },
};

export type PlannedClimbSlot = {
  grade: number;
  section: 'warmUp' | 'increasing' | 'peak' | 'decreasing' | 'main';
  index: number;
};

// Minimal grade scale shape the generator needs. Matches the rows returned by
// `getGradesForBoard` from @boardsesh/board-config (a wider type with the extra
// fields is also assignable).
export type GeneratorGrade = { difficulty_id: number };
export type GeneratorGradeScale = readonly GeneratorGrade[];
