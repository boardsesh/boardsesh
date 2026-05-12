// Playlist Generator Types and Constants

export type WorkoutType = 'volume' | 'pyramid' | 'ladder' | 'gradeFocus';

export type WarmUpType = 'standard' | 'extended' | 'none';

export type EffortLevel = 'moderate' | 'challenging' | 'veryDifficult' | 'maxEffort';

export type ClimbBias = 'unfamiliar' | 'attempted' | 'any';

// Base options shared by all workout types
export type BaseGeneratorOptions = {
  warmUp: WarmUpType;
  targetGrade: number; // difficulty_id
  climbBias: ClimbBias;
  minAscents: number;
  minRating: number;
  onlyTallClimbs: boolean;
};

// Volume workout - high volume at consistent grade
export type VolumeOptions = {
  type: 'volume';
  mainSetClimbs: number;
  mainSetVariability: number; // grades above/below target
} & BaseGeneratorOptions;

// Pyramid workout - ramp up to peak then back down
export type PyramidOptions = {
  type: 'pyramid';
  numberOfSteps: number;
  climbsPerStep: number;
} & BaseGeneratorOptions;

// Ladder workout - ramp up through grades
export type LadderOptions = {
  type: 'ladder';
  numberOfSteps: number;
  climbsPerStep: number;
} & BaseGeneratorOptions;

// Grade Focus - single grade workout
export type GradeFocusOptions = {
  type: 'gradeFocus';
  numberOfClimbs: number;
} & BaseGeneratorOptions;

export type GeneratorOptions = VolumeOptions | PyramidOptions | LadderOptions | GradeFocusOptions;

// Workout type metadata for UI
export type WorkoutTypeInfo = {
  type: WorkoutType;
  name: string;
  description: string;
  icon: 'volume' | 'pyramid' | 'ladder' | 'focus';
};

export const WORKOUT_TYPES: WorkoutTypeInfo[] = [
  {
    type: 'volume',
    name: 'Volume',
    description: 'Generate a high-volume workout.',
    icon: 'volume',
  },
  {
    type: 'pyramid',
    name: 'Pyramid',
    description: 'Work up to a max grade and back down again.',
    icon: 'pyramid',
  },
  {
    type: 'ladder',
    name: 'Ladder',
    description: 'Work up through the grades in steps.',
    icon: 'ladder',
  },
  {
    type: 'gradeFocus',
    name: 'Grade Focus',
    description: 'Pick a grade and go!',
    icon: 'focus',
  },
];

export const WARM_UP_OPTIONS: { value: WarmUpType; label: string }[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'extended', label: 'Extended' },
  { value: 'none', label: 'None' },
];

export const EFFORT_LEVELS: { value: EffortLevel; label: string }[] = [
  { value: 'moderate', label: 'Moderate' },
  { value: 'challenging', label: 'Challenging' },
  { value: 'veryDifficult', label: 'Very Difficult' },
  { value: 'maxEffort', label: 'Max Effort' },
];

export const CLIMB_BIAS_OPTIONS: { value: ClimbBias; label: string }[] = [
  { value: 'unfamiliar', label: 'Unfamiliar' },
  { value: 'attempted', label: 'Attempted' },
  { value: 'any', label: 'Any' },
];

// Default options for each workout type
export const DEFAULT_VOLUME_OPTIONS: Omit<VolumeOptions, 'targetGrade'> = {
  type: 'volume',
  warmUp: 'standard',
  mainSetClimbs: 20,
  mainSetVariability: 0,
  climbBias: 'unfamiliar',
  minAscents: 5,
  minRating: 2,
  onlyTallClimbs: false,
};

export const DEFAULT_PYRAMID_OPTIONS: Omit<PyramidOptions, 'targetGrade'> = {
  type: 'pyramid',
  warmUp: 'standard',
  numberOfSteps: 5,
  climbsPerStep: 1,
  climbBias: 'unfamiliar',
  minAscents: 5,
  minRating: 2,
  onlyTallClimbs: false,
};

export const DEFAULT_LADDER_OPTIONS: Omit<LadderOptions, 'targetGrade'> = {
  type: 'ladder',
  warmUp: 'standard',
  numberOfSteps: 5,
  climbsPerStep: 2,
  climbBias: 'unfamiliar',
  minAscents: 5,
  minRating: 2,
  onlyTallClimbs: false,
};

export const DEFAULT_GRADE_FOCUS_OPTIONS: Omit<GradeFocusOptions, 'targetGrade'> = {
  type: 'gradeFocus',
  warmUp: 'standard',
  numberOfClimbs: 15,
  climbBias: 'unfamiliar',
  minAscents: 5,
  minRating: 2,
  onlyTallClimbs: false,
};

// Warm-up configuration
export const WARM_UP_CONFIG = {
  standard: {
    grades: 4, // Number of grades below target to include
    climbsPerGrade: 1,
  },
  extended: {
    grades: 6,
    climbsPerGrade: 2,
  },
  none: {
    grades: 0,
    climbsPerGrade: 0,
  },
};

// Represents a planned climb slot in the generated playlist
export type PlannedClimbSlot = {
  grade: number; // difficulty_id
  section: 'warmUp' | 'increasing' | 'peak' | 'decreasing' | 'main';
  index: number;
};
