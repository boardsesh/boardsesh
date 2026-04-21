import type { SessionSummary } from '@boardsesh/shared-schema';
import { isNativeApp, getPlatform } from '../ble/capacitor-utils';
import { getPreference, setPreference } from '../user-preferences-db';

type HealthKitPlugin = {
  isAvailable(): Promise<{ available: boolean }>;
  requestAuthorization(): Promise<{ granted: boolean }>;
  saveWorkout(options: {
    sessionId: string;
    startDate: string;
    endDate: string;
    totalSends: number;
    totalAttempts: number;
    hardestGrade?: string;
    boardType: string;
  }): Promise<{ workoutId: string }>;
};

const HEALTHKIT_AUTO_SYNC_KEY = 'healthKitAutoSync';

function getPlugin(): HealthKitPlugin | null {
  if (!isNativeApp() || getPlatform() !== 'ios') return null;
  const plugins = window.Capacitor?.Plugins;
  if (!plugins) return null;
  return (plugins.HealthKit as HealthKitPlugin | undefined) ?? null;
}

export async function isHealthKitAvailable(): Promise<boolean> {
  const plugin = getPlugin();
  if (!plugin) return false;
  try {
    const { available } = await plugin.isAvailable();
    return available;
  } catch {
    return false;
  }
}

export async function requestHealthKitAuthorization(): Promise<boolean> {
  const plugin = getPlugin();
  if (!plugin) return false;
  try {
    const { granted } = await plugin.requestAuthorization();
    return granted;
  } catch (e) {
    console.warn('[HealthKit] Authorization request failed:', e);
    return false;
  }
}

export type SaveSessionResult = {
  workoutId: string;
};

export async function saveSessionToHealthKit(
  summary: SessionSummary,
  boardType: string,
): Promise<SaveSessionResult | null> {
  const plugin = getPlugin();
  if (!plugin) return null;
  if (!summary.startedAt || !summary.endedAt) {
    console.warn('[HealthKit] Skipping save: missing startedAt/endedAt');
    return null;
  }
  const startMs = new Date(summary.startedAt).getTime();
  const endMs = new Date(summary.endedAt).getTime();
  const durationSec = Math.round((endMs - startMs) / 1000);

  if (durationSec < 60) {
    console.warn(`[HealthKit] Duration is only ${durationSec}s — workout will appear as <1 min in Apple Health`);
  }
  try {
    const result = await plugin.saveWorkout({
      sessionId: summary.sessionId,
      startDate: summary.startedAt,
      endDate: summary.endedAt,
      totalSends: summary.totalSends,
      totalAttempts: summary.totalAttempts,
      hardestGrade: summary.hardestClimb?.grade,
      boardType,
    });
    return result;
  } catch (e) {
    console.warn('[HealthKit] Failed to save workout:', e);
    return null;
  }
}

// Auto-sync preference (defaults to true for iOS users).

export async function getHealthKitAutoSync(): Promise<boolean> {
  const value = await getPreference<boolean>(HEALTHKIT_AUTO_SYNC_KEY);
  // Default on: only treat an explicit `false` as disabled.
  return value !== false;
}

export async function setHealthKitAutoSync(enabled: boolean): Promise<void> {
  await setPreference(HEALTHKIT_AUTO_SYNC_KEY, enabled);
}
