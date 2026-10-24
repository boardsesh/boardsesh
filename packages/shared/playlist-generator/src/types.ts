// Playlist Generator Types and Constants
// Pure TS, no React. Web and mobile both consume from here.

export type WorkoutType =
  | 'volume'
  | 'pyramid'
  | 'ladder'
  | 'gradeFocus'
  | 'onTheMinute'
  | 'fourByFour'
  | 'limitBouldering';

export type WarmUpType = 'standard' | 'extended' | 'none';

export type EffortLevel = 'moderate' | 'challenging' | 'veryDifficult' | 'maxEffort';

/**
 * Which climbs of a grade a block draws from. `unfamiliar` prefers climbs the
 * climber has not tried, and `any` takes the whole catalogue. `attempted`,
 * `sent` and `liked` draw from the climber's own climbs: the ones they have
 * tried or sent at this angle, or hearted at any angle (#6739). Tried but not
 * sent is `attempted` with `skipSent`, not a value of its own.
 */
export type ClimbBias = 'unfamiliar' | 'attempted' | 'sent' | 'liked' | 'any';

export type BaseGeneratorOptions = {
  warmUp: WarmUpType;
  targetGrade: number;
  climbBias: ClimbBias;
  minAscents: number;
  minRating: number;
  onlyTallClimbs: boolean;
  onlyWideClimbs: boolean;
  /**
   * Leave out every climb the climber has sent at this angle. Off or absent,
   * climbs they have not sent come first and sent ones only fill what is left.
   * Optional, so filters stored before it existed still read.
   */
  skipSent?: boolean;
  /**
   * Leave out every climb the climber has tried or sent at this angle, so a
   * flash block never tops up with one. Wins over `skipSent`; does nothing under
   * the `attempted` bias. Optional like `skipSent`; absent means off.
   */
  skipTried?: boolean;
  /** Only benchmark climbs. Optional like `skipSent`; absent means off. */
  onlyBenchmarks?: boolean;
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
  /** Run the steps hardest first and ease down. Absent means up (the default). */
  descending?: boolean;
} & BaseGeneratorOptions;

export type GradeFocusOptions = {
  type: 'gradeFocus';
  numberOfClimbs: number;
} & BaseGeneratorOptions;

// The three timed types. Field names follow the partner API's block fields
// (docs/partner-api.md, "Blocks"); its `climbCount` is `numberOfClimbs`, or
// `climbsPerRound` on a 4x4. Their rests and intervals are whole seconds, read by
// `pacingForOptions` (pacing.ts).

/** One climb per interval at the target grade; the wall moves on every `intervalSeconds`. */
export type OnTheMinuteOptions = {
  type: 'onTheMinute';
  numberOfClimbs: number;
  intervalSeconds: number;
} & BaseGeneratorOptions;

/**
 * `climbsPerRound` climbs at the target grade, climbed `rounds` times. The plan
 * holds one slot per climb of a round; the rounds are queue copies made at Start.
 */
export type FourByFourOptions = {
  type: 'fourByFour';
  climbsPerRound: number;
  rounds: number;
  restBetweenClimbsSeconds: number;
  restBetweenRoundsSeconds: number;
} & BaseGeneratorOptions;

/** A few climbs at the target grade, a long rest after every attempt, and on to the next climb after a send. */
export type LimitBoulderingOptions = {
  type: 'limitBouldering';
  numberOfClimbs: number;
  restSeconds: number;
} & BaseGeneratorOptions;

export type GeneratorOptions =
  | VolumeOptions
  | PyramidOptions
  | LadderOptions
  | GradeFocusOptions
  | OnTheMinuteOptions
  | FourByFourOptions
  | LimitBoulderingOptions;

/** The workout types that pace the rest timer themselves (see `pacingForOptions`). */
export const TIMED_WORKOUT_TYPES: readonly WorkoutType[] = ['onTheMinute', 'fourByFour', 'limitBouldering'];

/** Workout-type metadata for UI rendering. Display labels live in the
 *  consuming app's i18n catalog (web: `playlists:generator.workoutTypes.<type>.name`,
 *  mobile: `session:mobile.session.preGenerator<Type>`). Don't add `name` /
 *  `description` here — keeping the shared package pure-data avoids untranslated
 *  English leaking through `t(variable)` patterns. */
export type WorkoutTypeInfo = {
  type: WorkoutType;
  icon: 'volume' | 'pyramid' | 'ladder' | 'focus' | 'minute' | 'rounds' | 'limit';
};

export const WORKOUT_TYPES: WorkoutTypeInfo[] = [
  { type: 'volume', icon: 'volume' },
  { type: 'pyramid', icon: 'pyramid' },
  { type: 'ladder', icon: 'ladder' },
  { type: 'gradeFocus', icon: 'focus' },
  { type: 'onTheMinute', icon: 'minute' },
  { type: 'fourByFour', icon: 'rounds' },
  { type: 'limitBouldering', icon: 'limit' },
];

export const WARM_UP_OPTIONS: WarmUpType[] = ['none', 'standard', 'extended'];

export const EFFORT_LEVELS: EffortLevel[] = ['moderate', 'challenging', 'veryDifficult', 'maxEffort'];

export const CLIMB_BIAS_OPTIONS: ClimbBias[] = ['unfamiliar', 'attempted', 'sent', 'liked', 'any'];

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

// The timed types copy their climb filters from volume's field by field, so a
// change to the generator's default filters reaches them too.

export const DEFAULT_ON_THE_MINUTE_OPTIONS: Omit<OnTheMinuteOptions, 'targetGrade'> = {
  type: 'onTheMinute',
  warmUp: 'none',
  numberOfClimbs: 10,
  intervalSeconds: 60,
  climbBias: DEFAULT_VOLUME_OPTIONS.climbBias,
  minAscents: DEFAULT_VOLUME_OPTIONS.minAscents,
  minRating: DEFAULT_VOLUME_OPTIONS.minRating,
  onlyTallClimbs: DEFAULT_VOLUME_OPTIONS.onlyTallClimbs,
  onlyWideClimbs: DEFAULT_VOLUME_OPTIONS.onlyWideClimbs,
};

export const DEFAULT_FOUR_BY_FOUR_OPTIONS: Omit<FourByFourOptions, 'targetGrade'> = {
  type: 'fourByFour',
  warmUp: 'none',
  climbsPerRound: 4,
  rounds: 4,
  restBetweenClimbsSeconds: 0,
  restBetweenRoundsSeconds: 180,
  climbBias: DEFAULT_VOLUME_OPTIONS.climbBias,
  minAscents: DEFAULT_VOLUME_OPTIONS.minAscents,
  minRating: DEFAULT_VOLUME_OPTIONS.minRating,
  onlyTallClimbs: DEFAULT_VOLUME_OPTIONS.onlyTallClimbs,
  onlyWideClimbs: DEFAULT_VOLUME_OPTIONS.onlyWideClimbs,
};

export const DEFAULT_LIMIT_BOULDERING_OPTIONS: Omit<LimitBoulderingOptions, 'targetGrade'> = {
  type: 'limitBouldering',
  warmUp: 'none',
  numberOfClimbs: 3,
  restSeconds: 180,
  climbBias: DEFAULT_VOLUME_OPTIONS.climbBias,
  minAscents: DEFAULT_VOLUME_OPTIONS.minAscents,
  minRating: DEFAULT_VOLUME_OPTIONS.minRating,
  onlyTallClimbs: DEFAULT_VOLUME_OPTIONS.onlyTallClimbs,
  onlyWideClimbs: DEFAULT_VOLUME_OPTIONS.onlyWideClimbs,
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
