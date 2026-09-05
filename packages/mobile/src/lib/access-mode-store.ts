import * as SecureStore from 'expo-secure-store';
import { ACCOUNT_ACCESS_MODE, isAccessMode, type AccessMode } from '@boardsesh/party-profile';
import { SECURE_STORE_WRITE_OPTIONS } from './secure-store-options';

const ACCESS_MODE_KEY = 'boardsesh_access_mode_v1';
const LOCAL_CATALOG_READY_KEY = 'boardsesh_local_catalog_ready_v1';
const LOCAL_PROFILE_IMPORT_PROMPT_KEY = 'boardsesh_local_profile_import_prompt_v1';

/**
 * Resolve the mode before the first auth redirect. A missing, invalid, or
 * temporarily unavailable value stays on the existing account-required path.
 */
export function readPersistedAccessMode(): AccessMode {
  try {
    const storedMode = SecureStore.getItem(ACCESS_MODE_KEY);
    return isAccessMode(storedMode) ? storedMode : ACCOUNT_ACCESS_MODE;
  } catch {
    return ACCOUNT_ACCESS_MODE;
  }
}

export function writePersistedAccessMode(accessMode: AccessMode): void {
  SecureStore.setItem(ACCESS_MODE_KEY, accessMode, SECURE_STORE_WRITE_OPTIONS);
}

export function readPersistedLocalCatalogReady(): boolean {
  try {
    return SecureStore.getItem(LOCAL_CATALOG_READY_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writePersistedLocalCatalogReady(isReady: boolean): void {
  SecureStore.setItem(LOCAL_CATALOG_READY_KEY, String(isReady), SECURE_STORE_WRITE_OPTIONS);
}

export function readPendingLocalProfileImportPrompt(): boolean {
  try {
    return SecureStore.getItem(LOCAL_PROFILE_IMPORT_PROMPT_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writePendingLocalProfileImportPrompt(isPending: boolean): void {
  SecureStore.setItem(LOCAL_PROFILE_IMPORT_PROMPT_KEY, String(isPending), SECURE_STORE_WRITE_OPTIONS);
}
