import { ACCOUNT_ACCESS_MODE, type AccessMode } from '@boardsesh/party-profile';

/** Expo web deliberately retains its anonymous read-only/account-required model. */
export function readPersistedAccessMode(): AccessMode {
  return ACCOUNT_ACCESS_MODE;
}

/** Local-profile selection is not exposed on Expo web. */
export function writePersistedAccessMode(_accessMode: AccessMode): void {}

export function readPersistedLocalCatalogReady(): boolean {
  return false;
}

export function writePersistedLocalCatalogReady(_isReady: boolean): void {}

/** Expo web never enters a local profile, so there is nothing to import. */
export function readPendingLocalProfileImportPrompt(): boolean {
  return false;
}

export function writePendingLocalProfileImportPrompt(_isPending: boolean): void {}
