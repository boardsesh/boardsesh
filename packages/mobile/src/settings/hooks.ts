import { useCallback, useSyncExternalStore } from 'react';
import { createMMKV } from 'react-native-mmkv';
import type { AppSettings, SettingsKey } from './types';
import { DEFAULT_SETTINGS } from './defaults';

const storage = createMMKV({ id: 'boardsesh-settings' });

const listeners = new Set<() => void>();

// useSyncExternalStore bails out of re-rendering only when getSnapshot returns
// the same reference as last time. getAllSettings() builds a fresh object, so we
// memoise it here and rebuild lazily; emitChange() busts the cache on every write.
let cachedSnapshot: AppSettings | null = null;

function emitChange() {
  cachedSnapshot = null;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
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

function writeSetting<K extends SettingsKey>(key: K, value: AppSettings[K]): void {
  storage.set(key, JSON.stringify(value));
  emitChange();
}

export function getSetting<K extends SettingsKey>(key: K): AppSettings[K] {
  return readSetting(key);
}

export function setSetting<K extends SettingsKey>(key: K, value: AppSettings[K]): void {
  writeSetting(key, value);
}

export function getAllSettings(): AppSettings {
  if (cachedSnapshot !== null) return cachedSnapshot;

  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingsKey[]) {
    settings[key] = readSetting(key) as never;
  }
  cachedSnapshot = settings;
  return settings;
}

export function resetAllSettings(): void {
  // The MMKV instance id is dedicated to settings, so wiping it is safe and also
  // clears any keys that are no longer in DEFAULT_SETTINGS.
  storage.clearAll();
  emitChange();
}

export function useSetting<K extends SettingsKey>(key: K): [AppSettings[K], (value: AppSettings[K]) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => readSetting(key),
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
