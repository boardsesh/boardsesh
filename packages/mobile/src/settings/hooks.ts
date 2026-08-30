import { useCallback, useSyncExternalStore } from 'react';
import { createMMKV } from 'react-native-mmkv';
import type { AppSettings, SettingsKey } from './types';
import { DEFAULT_SETTINGS } from './defaults';
import { getSettingsAccessMode, registerSettingsAccessModeListener } from './access-mode-scope';

const storage = createMMKV({ id: 'boardsesh-settings' });
const LOCAL_SYNC_ENABLED_BOARDS_KEY = 'localSyncEnabledBoardsV1';

const listeners = new Set<() => void>();
let cachedSettings: { accessMode: ReturnType<typeof getSettingsAccessMode>; settings: AppSettings } | null = null;
// Per-key snapshot cache for useSyncExternalStore. getSnapshot must return a
// REFERENCE-STABLE value between writes: re-parsing JSON per call hands React a
// fresh array/object every time, which reads as "store changed on every
// commit" and loops render → forceStoreRerender until the update-depth crash.
// All writes go through writeSetting/resetAllSettings, so clearing on
// emitChange keeps this coherent.
const snapshotCache = new Map<string, unknown>();

function emitChange() {
  cachedSettings = null;
  snapshotCache.clear();
  for (const listener of listeners) {
    listener();
  }
}

registerSettingsAccessModeListener(emitChange);

function storageKey(key: SettingsKey): string {
  if (key === 'syncEnabledBoards' && getSettingsAccessMode() === 'local') {
    return LOCAL_SYNC_ENABLED_BOARDS_KEY;
  }
  return key;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function readSetting<K extends SettingsKey>(key: K): AppSettings[K] {
  const raw = storage.getString(storageKey(key));
  if (raw === undefined) return DEFAULT_SETTINGS[key];

  try {
    return JSON.parse(raw) as AppSettings[K];
  } catch {
    return DEFAULT_SETTINGS[key];
  }
}

function readSettingSnapshot<K extends SettingsKey>(key: K): AppSettings[K] {
  const physicalKey = storageKey(key);
  if (snapshotCache.has(physicalKey)) return snapshotCache.get(physicalKey) as AppSettings[K];
  const value = readSetting(key);
  snapshotCache.set(physicalKey, value);
  return value;
}

function writeSetting<K extends SettingsKey>(key: K, value: AppSettings[K]): void {
  storage.set(storageKey(key), JSON.stringify(value));
  emitChange();
}

export function getSetting<K extends SettingsKey>(key: K): AppSettings[K] {
  return readSetting(key);
}

export function setSetting<K extends SettingsKey>(key: K, value: AppSettings[K]): void {
  writeSetting(key, value);
}

export function getAllSettings(): AppSettings {
  const accessMode = getSettingsAccessMode();
  if (cachedSettings?.accessMode === accessMode) return cachedSettings.settings;

  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingsKey[]) {
    settings[key] = readSetting(key) as never;
  }
  cachedSettings = { accessMode, settings };
  return settings;
}

export function resetAllSettings(): void {
  storage.clearAll();
  emitChange();
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
