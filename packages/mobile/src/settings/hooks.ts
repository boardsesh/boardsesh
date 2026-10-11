import { useCallback, useSyncExternalStore } from 'react';
import { createMMKV } from 'react-native-mmkv';
import type { AppSettings, SettingsKey } from './types';
import { DEFAULT_SETTINGS } from './defaults';

const storage = createMMKV({ id: 'boardsesh-settings' });

export type SettingsChange = { kind: 'setting'; key: SettingsKey } | { kind: 'reset' };
const listeners = new Set<(change: SettingsChange) => void>();
let cachedSettings: AppSettings | null = null;
// Per-key snapshot cache for useSyncExternalStore. getSnapshot must return a
// REFERENCE-STABLE value between writes: re-parsing JSON per call hands React a
// fresh array/object every time, which reads as "store changed on every
// commit" and loops render → forceStoreRerender until the update-depth crash.
// All writes go through writeSetting/resetAllSettings, so clearing on
// emitChange keeps this coherent.
const snapshotCache = new Map<SettingsKey, unknown>();

function emitChange(change: SettingsChange) {
  cachedSettings = null;
  snapshotCache.clear();
  for (const listener of listeners) {
    listener(change);
  }
}

function subscribe(callback: (change: SettingsChange) => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * The same change signal `useSetting` rides, for code that is not a React
 * component — the connectivity store's binding, which has to notice an offline
 * mode written from anywhere and cannot see a hook.
 *
 * Fires after every `setSetting` and after `resetAllSettings`. A reset is explicit
 * even when the storage was already empty, so stores retaining an unsaved choice
 * in memory can distinguish it from an unrelated setting write.
 */
export function subscribeSettings(listener: (change: SettingsChange) => void): () => void {
  return subscribe(listener);
}

function readSetting<K extends SettingsKey>(key: K): AppSettings[K] {
  const raw = storage.getString(key);
  if (raw === undefined) return DEFAULT_SETTINGS[key];

  try {
    return JSON.parse(raw) as AppSettings[K];
  } catch {
    return DEFAULT_SETTINGS[key];
  }
}

function readSettingSnapshot<K extends SettingsKey>(key: K): AppSettings[K] {
  if (snapshotCache.has(key)) return snapshotCache.get(key) as AppSettings[K];
  const value = readSetting(key);
  snapshotCache.set(key, value);
  return value;
}

function writeSetting<K extends SettingsKey>(key: K, value: AppSettings[K]): void {
  storage.set(key, JSON.stringify(value));
  emitChange({ kind: 'setting', key });
}

export function getSetting<K extends SettingsKey>(key: K): AppSettings[K] {
  return readSetting(key);
}

export function setSetting<K extends SettingsKey>(key: K, value: AppSettings[K]): void {
  writeSetting(key, value);
}

export function getAllSettings(): AppSettings {
  if (cachedSettings) return cachedSettings;

  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingsKey[]) {
    settings[key] = readSetting(key) as never;
  }
  cachedSettings = settings;
  return settings;
}

export function resetAllSettings(): void {
  storage.clearAll();
  emitChange({ kind: 'reset' });
}

export function useSetting<K extends SettingsKey>(key: K): [AppSettings[K], (value: AppSettings[K]) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => readSettingSnapshot(key),
    () => DEFAULT_SETTINGS[key],
  );

  const setValue = useCallback(
    (newValue: AppSettings[K]) => {
      writeSetting(key, newValue);
    },
    [key],
  );

  return [value, setValue];
}

export function useSettings(): AppSettings {
  return useSyncExternalStore(subscribe, getAllSettings, () => DEFAULT_SETTINGS);
}
