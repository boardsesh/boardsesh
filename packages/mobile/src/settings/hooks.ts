import { useCallback, useSyncExternalStore } from 'react';
import { createMMKV } from 'react-native-mmkv';
import type { AppSettings, SettingsKey } from './types';
import { DEFAULT_SETTINGS } from './defaults';

const storage = createMMKV({ id: 'boardsesh-settings' });

const listeners = new Set<() => void>();

function emitChange() {
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
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingsKey[]) {
    settings[key] = readSetting(key) as never;
  }
  return settings;
}

export function resetAllSettings(): void {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    storage.remove(key);
  }
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
