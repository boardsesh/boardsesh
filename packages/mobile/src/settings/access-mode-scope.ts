import { ACCOUNT_ACCESS_MODE, type AccessMode } from '@boardsesh/party-profile';

let settingsAccessMode: AccessMode = ACCOUNT_ACCESS_MODE;
const modeChangedListeners = new Set<() => void>();

export function getSettingsAccessMode(): AccessMode {
  return settingsAccessMode;
}

export function setSettingsAccessMode(accessMode: AccessMode): void {
  if (settingsAccessMode === accessMode) return;
  settingsAccessMode = accessMode;
  for (const listener of modeChangedListeners) listener();
}

export function registerSettingsAccessModeListener(listener: () => void): () => void {
  modeChangedListeners.add(listener);
  return () => modeChangedListeners.delete(listener);
}
