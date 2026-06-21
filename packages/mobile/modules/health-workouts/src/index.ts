import { requireOptionalNativeModule } from 'expo-modules-core';

export type SaveWorkoutOptions = {
  sessionId: string;
  startDate: string;
  endDate: string;
  totalSends: number;
  totalAttempts: number;
  hardestGrade?: string;
  boardType: string;
  laps: WorkoutLap[];
};

export type WorkoutLap = {
  tickUuid: string;
  climbedAt: string;
  climbUuid: string;
  climbName?: string | null;
  grade?: string | null;
  status: string;
  attemptCount: number;
  boardType: string;
  angle?: number | null;
};

export type SaveWorkoutResult = {
  workoutId: string;
  created: boolean;
  energyKilocalories: number | null;
  energySaved: boolean;
  lapCount: number;
};

export type HealthWorkoutsNativeModule = {
  isAvailable(): Promise<{ available: boolean }>;
  /** Workout-share authorization state; never presents the consent sheet. */
  getAuthorizationStatus(): Promise<{
    status: 'notDetermined' | 'denied' | 'authorized';
    workoutStatus: 'notDetermined' | 'denied' | 'authorized';
    activeEnergyStatus: 'notDetermined' | 'denied' | 'authorized';
  }>;
  requestAuthorization(): Promise<{ granted: boolean; activeEnergyGranted: boolean }>;
  saveWorkout(options: SaveWorkoutOptions): Promise<SaveWorkoutResult>;
};

// requireOptionalNativeModule returns null in Expo Go, on Android (this module
// is iOS-only), and in any binary built before the module was linked. Callers
// must check for null before invoking — see src/lib/integrations/apple-health.ts.
export const healthWorkoutsNative: HealthWorkoutsNativeModule | null =
  requireOptionalNativeModule<HealthWorkoutsNativeModule>('HealthWorkouts');
