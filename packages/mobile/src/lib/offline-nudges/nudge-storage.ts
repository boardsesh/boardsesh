// Persistence for the offline-nudge policy state (issue #4318).
//
// One AsyncStorage key holding the whole per-surface record, loaded once per
// app run through a promise singleton. `preference-store.getPreference`
// deliberately lets a storage REJECTION propagate (iOS can deny the backing-file
// read before first unlock), so the singleton clears a rejected promise and the
// next caller retries instead of caching a wrong answer.
//
// A read that fails resolves to `suppressedNudgeState()`: never nag on a flaky
// store. Same direction `hasSeenTip` errs in.

import { getPreference, setPreference } from '../preference-store';
import { emptyNudgeState, suppressedNudgeState, NUDGE_SURFACES, type OfflineNudgeState } from './nudge-policy';

export const OFFLINE_NUDGE_STATE_KEY = 'offlineNudgeStateV1';

let loadPromise: Promise<OfflineNudgeState> | null = null;
let cachedState: OfflineNudgeState | null = null;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Rebuild a full state from whatever is on disk, so a value written by an older
 * build (or a corrupt one) degrades to defaults rather than throwing at a read
 * site. Unknown surfaces are dropped; missing ones get defaults.
 */
export function parseNudgeState(stored: unknown): OfflineNudgeState {
  const state = emptyNudgeState();
  if (typeof stored !== 'object' || stored === null) return state;
  const record = stored as Record<string, unknown>;

  if (isFiniteNumber(record.lastPromptAtMs)) state.lastPromptAtMs = record.lastPromptAtMs;
  if (isFiniteNumber(record.lastAcceptedAtMs)) state.lastAcceptedAtMs = record.lastAcceptedAtMs;

  const surfaces = record.surfaces;
  if (typeof surfaces !== 'object' || surfaces === null) return state;
  const surfaceRecord = surfaces as Record<string, unknown>;
  for (const surface of NUDGE_SURFACES) {
    const raw = surfaceRecord[surface];
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    state.surfaces[surface] = {
      lastShownAtMs: isFiniteNumber(entry.lastShownAtMs) ? entry.lastShownAtMs : null,
      shownCount: isFiniteNumber(entry.shownCount) ? entry.shownCount : 0,
      dismissedForever: entry.dismissedForever === true,
    };
  }
  return state;
}

export async function loadNudgeState(): Promise<OfflineNudgeState> {
  if (cachedState) return cachedState;
  if (!loadPromise) {
    loadPromise = getPreference<unknown>(OFFLINE_NUDGE_STATE_KEY)
      .then((stored) => {
        const state = parseNudgeState(stored);
        cachedState = state;
        return state;
      })
      .catch(() => {
        // Clear the rejected promise so a later read (post-unlock) can retry,
        // and do NOT cache: this run stays silent, the next one may not.
        loadPromise = null;
        return suppressedNudgeState();
      });
  }
  return loadPromise;
}

export async function saveNudgeState(state: OfflineNudgeState): Promise<void> {
  cachedState = state;
  loadPromise = Promise.resolve(state);
  await setPreference(OFFLINE_NUDGE_STATE_KEY, state);
}

/** Test seam. Also the hook for #3621's sign-out wipe once it lands. */
export function __resetNudgeStateCacheForTests(): void {
  loadPromise = null;
  cachedState = null;
}
