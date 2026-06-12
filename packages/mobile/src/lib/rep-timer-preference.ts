import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';

const STORAGE_KEY = 'repTimerPreference';
const REP_TIMER_OFF_STORAGE_VALUE = 'off';

export const REP_TIMER_TARGET_SECONDS = [60, 120, 180, 300] as const;
export const DEFAULT_REP_TIMER_TARGET_SECONDS = 180;

export type RepTimerTargetSeconds = (typeof REP_TIMER_TARGET_SECONDS)[number];
export type RepTimerTargetPreference = RepTimerTargetSeconds | null;
type StoredRepTimerPreference = RepTimerTargetSeconds | typeof REP_TIMER_OFF_STORAGE_VALUE;

type RepTimerSnapshot = {
  targetSeconds: RepTimerTargetPreference;
  loaded: boolean;
};

let targetSeconds: RepTimerTargetPreference = DEFAULT_REP_TIMER_TARGET_SECONDS;
let hasLoaded = false;
let snapshot: RepTimerSnapshot = { targetSeconds, loaded: hasLoaded };
const listeners = new Set<() => void>();

const SERVER_SNAPSHOT: RepTimerSnapshot = {
  targetSeconds: DEFAULT_REP_TIMER_TARGET_SECONDS,
  loaded: false,
};

function isRepTimerTargetSeconds(value: unknown): value is RepTimerTargetSeconds {
  return typeof value === 'number' && (REP_TIMER_TARGET_SECONDS as readonly number[]).includes(value);
}

function parseStoredRepTimerPreference(value: unknown): RepTimerTargetPreference | undefined {
  if (value === REP_TIMER_OFF_STORAGE_VALUE) return null;
  if (isRepTimerTargetSeconds(value)) return value;
  return undefined;
}

function notify(): void {
  snapshot = { targetSeconds, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

export async function loadRepTimerPreference(): Promise<RepTimerTargetPreference> {
  if (hasLoaded) return targetSeconds;

  const stored = await getPreference<StoredRepTimerPreference>(STORAGE_KEY);
  if (hasLoaded) return targetSeconds;

  const parsed = parseStoredRepTimerPreference(stored);
  targetSeconds = parsed === undefined ? DEFAULT_REP_TIMER_TARGET_SECONDS : parsed;
  hasLoaded = true;
  notify();
  return targetSeconds;
}

export async function setRepTimerTargetPreference(nextTargetSeconds: RepTimerTargetPreference): Promise<void> {
  targetSeconds = nextTargetSeconds;
  hasLoaded = true;
  notify();
  await setPreference<StoredRepTimerPreference>(STORAGE_KEY, nextTargetSeconds ?? REP_TIMER_OFF_STORAGE_VALUE);
}

let loadPromise: Promise<RepTimerTargetPreference> | null = null;
function ensureRepTimerPreferenceLoaded(): Promise<RepTimerTargetPreference> {
  if (!loadPromise) loadPromise = loadRepTimerPreference();
  return loadPromise;
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): RepTimerSnapshot {
  return snapshot;
}

function getServerSnapshot(): RepTimerSnapshot {
  return SERVER_SNAPSHOT;
}

export function useRepTimerPreference(): {
  targetSeconds: RepTimerTargetPreference;
  loaded: boolean;
  setTargetSeconds: (nextTargetSeconds: RepTimerTargetPreference) => void;
} {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    void ensureRepTimerPreferenceLoaded();
  }, []);

  const setTargetSeconds = useCallback((nextTargetSeconds: RepTimerTargetPreference) => {
    void setRepTimerTargetPreference(nextTargetSeconds);
  }, []);

  return { ...current, setTargetSeconds };
}
