import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';

const STORAGE_KEY = 'repTimerPreference';

export const REP_TIMER_TARGET_SECONDS = [60, 120, 180, 300] as const;
export const DEFAULT_REP_TIMER_TARGET_SECONDS = 180;

export type RepTimerTargetSeconds = (typeof REP_TIMER_TARGET_SECONDS)[number];

type RepTimerSnapshot = {
  targetSeconds: RepTimerTargetSeconds;
  loaded: boolean;
};

let targetSeconds: RepTimerTargetSeconds = DEFAULT_REP_TIMER_TARGET_SECONDS;
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

function notify(): void {
  snapshot = { targetSeconds, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

export async function loadRepTimerPreference(): Promise<RepTimerTargetSeconds> {
  if (hasLoaded) return targetSeconds;

  const stored = await getPreference<RepTimerTargetSeconds>(STORAGE_KEY);
  if (hasLoaded) return targetSeconds;

  targetSeconds = isRepTimerTargetSeconds(stored) ? stored : DEFAULT_REP_TIMER_TARGET_SECONDS;
  hasLoaded = true;
  notify();
  return targetSeconds;
}

export async function setRepTimerTargetPreference(nextTargetSeconds: RepTimerTargetSeconds): Promise<void> {
  targetSeconds = nextTargetSeconds;
  hasLoaded = true;
  notify();
  await setPreference(STORAGE_KEY, nextTargetSeconds);
}

let loadPromise: Promise<RepTimerTargetSeconds> | null = null;
function ensureRepTimerPreferenceLoaded(): Promise<RepTimerTargetSeconds> {
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
  targetSeconds: RepTimerTargetSeconds;
  loaded: boolean;
  setTargetSeconds: (nextTargetSeconds: RepTimerTargetSeconds) => void;
} {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    void ensureRepTimerPreferenceLoaded();
  }, []);

  const setTargetSeconds = useCallback((nextTargetSeconds: RepTimerTargetSeconds) => {
    void setRepTimerTargetPreference(nextTargetSeconds);
  }, []);

  return { ...current, setTargetSeconds };
}
