// Apple Health auto-save orchestration. Mobile-local port of the web file at
// `packages/web/app/lib/healthkit/healthkit-auto-save.ts`. The web copy is
// Capacitor-legacy (it drives the old `@perfood/capacitor-healthkit`-style
// bridge); this one drives the Expo `health-workouts` native module instead.
// The dedup-guard semantics (claim synchronously, release on skip/failure so a
// retry can proceed) are kept identical so both platforms behave the same.
//
// A duplicate mobile copy is intentional: web and mobile use different native
// bridges and different storage/analytics seams, and the save-state store here
// additionally powers per-session UI (saving / saved / failed) that web doesn't
// surface.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { SessionHealthExport, SessionSummary } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { SET_SESSION_HEALTHKIT_WORKOUT_ID } from '@boardsesh/graphql/operations/activity-feed';
// Imported by relative path (not the package name) to match the live-activity
// module convention in this repo: Expo autolinking discovers the *native* side
// via modules/health-workouts/expo-module.config.json, while the JS wrapper is
// pulled in directly from its source so Metro + vitest resolve it without the
// package needing a dependency entry.
import { healthWorkoutsNative, type SaveWorkoutResult } from '../../../modules/health-workouts/src/index';
import { track } from '../analytics';
import { reportHandledError } from '../error-reporting';
import { getHttpClient } from '../graphql/client';
import {
  GET_SESSION_HEALTH_EXPORT,
  type GetSessionHealthExportQueryResponse,
  type GetSessionHealthExportQueryVariables,
} from '../graphql/operations';
import { getPreference, setPreference } from '../preference-store';
import type { SessionExportContext } from './types';

const AUTO_SAVE_KEY = 'appleHealthAutoSave';

// ============================================
// Availability + authorization
// ============================================

export type AppleHealthAuthorizationStatus = 'notDetermined' | 'denied' | 'authorized' | 'unavailable';

export async function isAppleHealthAvailable(): Promise<boolean> {
  if (!healthWorkoutsNative) return false;
  const { available } = await healthWorkoutsNative.isAvailable();
  return available;
}

/**
 * Read the workout-share authorization state WITHOUT presenting the system
 * sheet. UI probes (settings card mount, footnote hints) must use this —
 * requestAppleHealthAuthorization pops the consent sheet for undecided users.
 */
export async function getAppleHealthAuthorizationStatus(): Promise<AppleHealthAuthorizationStatus> {
  if (!healthWorkoutsNative) return 'unavailable';
  try {
    const { status } = await healthWorkoutsNative.getAuthorizationStatus();
    return status;
  } catch {
    return 'unavailable';
  }
}

export async function requestAppleHealthAuthorization(): Promise<boolean> {
  if (!healthWorkoutsNative) return false;
  const { granted } = await healthWorkoutsNative.requestAuthorization();
  return granted;
}

// ============================================
// Auto-save preference (default ON)
// ============================================

type AutoSaveSnapshot = { enabled: boolean; loaded: boolean };

// Default ON: only an explicit `false` in storage disables it. Mirrors
// session-recording-preference.ts (useSyncExternalStore over a module-level
// store + a promise-singleton one-time load) — but the default polarity is
// flipped (recording defaults OFF, Apple Health auto-save defaults ON).
let autoSaveEnabled = true;
let autoSaveLoaded = false;
let autoSaveSnapshot: AutoSaveSnapshot = { enabled: autoSaveEnabled, loaded: autoSaveLoaded };
const autoSaveListeners = new Set<() => void>();

const AUTO_SAVE_SERVER_SNAPSHOT: AutoSaveSnapshot = { enabled: true, loaded: false };

function notifyAutoSave(): void {
  autoSaveSnapshot = { enabled: autoSaveEnabled, loaded: autoSaveLoaded };
  for (const listener of autoSaveListeners) listener();
}

async function loadAutoSaveEnabled(): Promise<boolean> {
  if (autoSaveLoaded) return autoSaveEnabled;
  const stored = await getPreference<boolean>(AUTO_SAVE_KEY);
  // A setter may have raced in while we awaited storage; honour the user's live
  // choice over the (now stale) persisted value.
  if (autoSaveLoaded) return autoSaveEnabled;
  // Default ON: anything other than an explicit `false` keeps it enabled.
  autoSaveEnabled = stored !== false;
  autoSaveLoaded = true;
  notifyAutoSave();
  return autoSaveEnabled;
}

async function setAutoSaveEnabledPreference(enabled: boolean): Promise<void> {
  autoSaveEnabled = enabled;
  autoSaveLoaded = true;
  notifyAutoSave();
  await setPreference(AUTO_SAVE_KEY, enabled);
}

/** Read the persisted auto-save preference. Used by the non-React auto-save
 *  path, which can't subscribe to the store. Returns true by default. */
async function getAutoSaveEnabled(): Promise<boolean> {
  return loadAutoSaveEnabled();
}

let autoSaveLoadPromise: Promise<boolean> | null = null;
function ensureAutoSaveLoaded(): Promise<boolean> {
  if (!autoSaveLoadPromise) {
    autoSaveLoadPromise = loadAutoSaveEnabled().catch((error: unknown) => {
      // A failed read must not leave a rejected promise cached — clear the
      // singleton so the next mount retries instead of staying stuck.
      autoSaveLoadPromise = null;
      throw error;
    });
  }
  return autoSaveLoadPromise;
}

function subscribeAutoSave(onStoreChange: () => void): () => void {
  autoSaveListeners.add(onStoreChange);
  return () => {
    autoSaveListeners.delete(onStoreChange);
  };
}

function getAutoSaveSnapshot(): AutoSaveSnapshot {
  return autoSaveSnapshot;
}

function getAutoSaveServerSnapshot(): AutoSaveSnapshot {
  return AUTO_SAVE_SERVER_SNAPSHOT;
}

export function useHealthKitAutoSavePreference(): {
  enabled: boolean;
  loaded: boolean;
  setEnabled: (value: boolean) => void;
} {
  const { enabled, loaded } = useSyncExternalStore(subscribeAutoSave, getAutoSaveSnapshot, getAutoSaveServerSnapshot);

  useEffect(() => {
    // Swallow read failures here — the load clears its cached promise so a later
    // mount retries; nothing to do at this call site.
    ensureAutoSaveLoaded().catch(() => {});
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    void setAutoSaveEnabledPreference(next);
  }, []);

  return { enabled, loaded, setEnabled };
}

// ============================================
// Per-session save state (saving / saved / savedWithoutEnergy / failed)
// ============================================

export type HealthKitSaveState = 'saving' | 'saved' | 'savedWithoutEnergy' | 'failed';

// Module-level Map doubles as the dedup guard (the web file's
// `savedOrInFlight` Set) AND the source for the per-session save-state UI. A
// sessionId present with 'saving' or a saved state means a save is claimed;
// 'failed' is releasable so a manual retry can overwrite it.
const saveStateBySession = new Map<string, HealthKitSaveState>();
const saveStateListeners = new Set<() => void>();

function notifySaveState(): void {
  for (const listener of saveStateListeners) listener();
}

function setSaveState(sessionId: string, state: HealthKitSaveState): void {
  saveStateBySession.set(sessionId, state);
  notifySaveState();
}

function clearSaveState(sessionId: string): void {
  if (saveStateBySession.delete(sessionId)) notifySaveState();
}

function subscribeSaveState(onStoreChange: () => void): () => void {
  saveStateListeners.add(onStoreChange);
  return () => {
    saveStateListeners.delete(onStoreChange);
  };
}

export function useHealthKitSaveState(sessionId: string): HealthKitSaveState | null {
  const getSnapshot = useCallback((): HealthKitSaveState | null => {
    return saveStateBySession.get(sessionId) ?? null;
  }, [sessionId]);
  return useSyncExternalStore(subscribeSaveState, getSnapshot, getSnapshot);
}

/** Reset the per-session save-state store. For tests only. */
export function _resetHealthKitSaveStateForTests(): void {
  saveStateBySession.clear();
  notifySaveState();
  // Also reset the auto-save preference load cache so a test that set the
  // preference off doesn't leak its (cached) value into the next test.
  autoSaveEnabled = true;
  autoSaveLoaded = false;
  autoSaveLoadPromise = null;
  notifyAutoSave();
}

// ============================================
// Save orchestration
// ============================================

/** Best-effort: persist the HealthKit workout id to the backend for
 *  deduplication. Works for party sessions too. A failure here is non-fatal —
 *  the HealthKit workout already exists. */
async function persistWorkoutId(sessionId: string, workoutId: string): Promise<void> {
  try {
    await getHttpClient().request(SET_SESSION_HEALTHKIT_WORKOUT_ID, { sessionId, workoutId });
  } catch (error) {
    console.warn('[AppleHealth] Failed to persist workout id:', error);
  }
}

async function loadSessionHealthExport(
  sessionId: string,
  ctx: SessionExportContext,
): Promise<SessionHealthExport | null> {
  if (ctx.healthExport !== undefined) return ctx.healthExport;
  const response = await getHttpClient().request<
    GetSessionHealthExportQueryResponse,
    GetSessionHealthExportQueryVariables
  >(GET_SESSION_HEALTH_EXPORT, { sessionId });
  return response.sessionHealthExport;
}

/** Map a viewer-specific export payload to the native saveWorkout options, or null
 *  when the session lacks the start/end timestamps the workout requires. */
function buildSaveOptions(healthExport: SessionHealthExport) {
  if (!healthExport.startedAt || !healthExport.endedAt) return null;
  return {
    sessionId: healthExport.sessionId,
    startDate: healthExport.startedAt,
    endDate: healthExport.endedAt,
    totalSends: healthExport.totalSends,
    totalAttempts: healthExport.totalAttempts,
    hardestGrade: healthExport.hardestClimb?.grade,
    boardType: healthExport.boardType,
    laps: healthExport.laps,
  };
}

function setSavedStateFromResult(sessionId: string, result: SaveWorkoutResult): void {
  setSaveState(sessionId, result.created && !result.energySaved ? 'savedWithoutEnergy' : 'saved');
}

/**
 * Auto-save a finished session to Apple Health. Semantics ported from the web
 * `autoSaveToHealthKit`:
 *
 * - Claims the dedup guard synchronously at entry (sets 'saving'); a session
 *   already 'saving' or saved returns null without a second native call.
 * - Auto-save preference off / unavailable / authorization denied / missing
 *   timestamps all RELEASE the guard (delete the entry) and return null, so the
 *   manual save button still works.
 * - On success: marks a saved state, best-effort persists the workout id,
 *   tracks the export, returns the workout id.
 * - On a thrown native error: marks 'failed' and returns null (a manual retry
 *   can overwrite the 'failed' entry).
 *
 * Returns the workoutId when HealthKit accepted the write, else null.
 */
export async function autoSaveToAppleHealth(
  summary: SessionSummary,
  ctx: SessionExportContext,
): Promise<string | null> {
  const { sessionId } = summary;

  // Claim synchronously — prevents a concurrent auto + manual save from both
  // reaching the native bridge.
  const existing = saveStateBySession.get(sessionId);
  if (existing === 'saving' || existing === 'saved' || existing === 'savedWithoutEnergy') return null;
  setSaveState(sessionId, 'saving');

  try {
    const enabled = await getAutoSaveEnabled();
    if (!enabled) {
      clearSaveState(sessionId);
      return null;
    }

    const healthExport = await loadSessionHealthExport(sessionId, ctx);
    if (!healthExport) {
      clearSaveState(sessionId);
      return null;
    }
    if (healthExport.healthKitWorkoutId) {
      setSaveState(sessionId, 'saved');
      return healthExport.healthKitWorkoutId;
    }

    const available = await isAppleHealthAvailable();
    if (!available) {
      clearSaveState(sessionId);
      return null;
    }

    // Status first: only a never-decided user gets the consent sheet (their
    // first session end is the natural moment to ask). A decided user must
    // never see a re-request call — and a denied one silently skips.
    const authorizationStatus = await getAppleHealthAuthorizationStatus();
    const granted =
      authorizationStatus === 'authorized' ||
      (authorizationStatus === 'notDetermined' && (await requestAppleHealthAuthorization()));
    if (!granted) {
      clearSaveState(sessionId);
      return null;
    }

    const options = buildSaveOptions(healthExport);
    // `!healthWorkoutsNative` is unreachable at runtime (isAppleHealthAvailable
    // above already bailed when the module is null) — it's here purely to
    // narrow the type for the call below.
    if (!options || !healthWorkoutsNative) {
      clearSaveState(sessionId);
      return null;
    }

    const result = await healthWorkoutsNative.saveWorkout(options);
    setSavedStateFromResult(sessionId, result);
    await persistWorkoutId(sessionId, result.workoutId);
    track(SHARED_EVENTS.SessionExportedToIntegration, { integration: 'apple_health', trigger: 'auto' });
    return result.workoutId;
  } catch (error) {
    setSaveState(sessionId, 'failed');
    console.warn('[AppleHealth] Auto-save failed:', error);
    return null;
  }
}

/**
 * Manually save a finished session to Apple Health (tapped from the summary
 * screen). Like the auto path but skips the preference check and reports a
 * coarse outcome the UI can render.
 *
 * - Already saved → returns that saved state. A save still in flight
 *   ('saving') returns 'inFlight' — NOT 'saved', the running task may yet fail;
 *   the button keeps rendering the store's live state. Either way no second
 *   native write starts: whoever claims 'saving' first wins.
 * - A previous 'failed' (retryable) or no prior entry → claims 'saving' and
 *   proceeds, so a manual retry after a failed save works.
 * - unavailable / denied delete the entry and return that outcome.
 * - success marks a saved state, persists the workout id, tracks (trigger
 *   'manual').
 * - a thrown native error marks 'failed' and returns 'failed'.
 */
export async function manualSaveToAppleHealth(
  summary: SessionSummary,
  ctx: SessionExportContext,
): Promise<'saved' | 'savedWithoutEnergy' | 'inFlight' | 'denied' | 'unavailable' | 'failed'> {
  const { sessionId } = summary;

  const existing = saveStateBySession.get(sessionId);
  if (existing === 'saved' || existing === 'savedWithoutEnergy') return existing;
  if (existing === 'saving') return 'inFlight';
  // 'failed' (retryable) or no entry proceed by claiming.
  setSaveState(sessionId, 'saving');

  try {
    const healthExport = await loadSessionHealthExport(sessionId, ctx);
    if (!healthExport) {
      setSaveState(sessionId, 'failed');
      return 'failed';
    }
    if (healthExport.healthKitWorkoutId) {
      setSaveState(sessionId, 'saved');
      return 'saved';
    }

    const available = await isAppleHealthAvailable();
    if (!available) {
      clearSaveState(sessionId);
      return 'unavailable';
    }

    // Manual taps are explicit user intent, so prompting an undecided user is
    // correct — but a decided user still skips the request call.
    const authorizationStatus = await getAppleHealthAuthorizationStatus();
    const granted =
      authorizationStatus === 'authorized' ||
      (authorizationStatus === 'notDetermined' && (await requestAppleHealthAuthorization()));
    if (!granted) {
      clearSaveState(sessionId);
      return 'denied';
    }

    const options = buildSaveOptions(healthExport);
    // `!healthWorkoutsNative` is unreachable at runtime (isAppleHealthAvailable
    // above already bailed when the module is null) — it's here purely to
    // narrow the type for the call below.
    if (!options || !healthWorkoutsNative) {
      setSaveState(sessionId, 'failed');
      return 'failed';
    }

    const result = await healthWorkoutsNative.saveWorkout(options);
    setSavedStateFromResult(sessionId, result);
    await persistWorkoutId(sessionId, result.workoutId);
    track(SHARED_EVENTS.SessionExportedToIntegration, { integration: 'apple_health', trigger: 'manual' });
    return result.created && !result.energySaved ? 'savedWithoutEnergy' : 'saved';
  } catch (error) {
    setSaveState(sessionId, 'failed');
    console.warn('[AppleHealth] Manual save failed:', error);
    reportHandledError(error, { tags: { source: 'integration', op: 'apple-health-save' } });
    return 'failed';
  }
}
