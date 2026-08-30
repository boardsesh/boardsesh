import { ACCOUNT_ACCESS_MODE, type AccessMode } from '@boardsesh/party-profile';

let settingsAccessMode: AccessMode = ACCOUNT_ACCESS_MODE;
let notifyModeChanged: () => void = () => {};

export function getSettingsAccessMode(): AccessMode {
  return settingsAccessMode;
}

export function setSettingsAccessMode(accessMode: AccessMode): void {
  if (settingsAccessMode === accessMode) return;
  settingsAccessMode = accessMode;
  notifyModeChanged();
}

export function registerSettingsAccessModeListener(listener: () => void): void {
  notifyModeChanged = listener;
}
