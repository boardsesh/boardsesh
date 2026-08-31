import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import { buildInstallationBoardLayers, type InstallationBoardLayer } from '@boardsesh/board-layers';
import { SECURE_STORE_WRITE_OPTIONS } from '../secure-store-options';

const QUANTUM_LAYER_IDENTITIES_KEY = 'boardsesh_quantum_layer_ids_v1';

type StoredQuantumLayerIdentities = {
  version: 1;
  controllerUserUuids: string[];
};

let inFlightLoad: Promise<InstallationBoardLayer[]> | null = null;

function parseStoredLayers(raw: string | null): InstallationBoardLayer[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredQuantumLayerIdentities>;
    if (parsed.version !== 1 || !Array.isArray(parsed.controllerUserUuids)) return null;
    return buildInstallationBoardLayers(parsed.controllerUserUuids);
  } catch {
    return null;
  }
}

/**
 * Resolve the four install-local controller identities. They are physical-wall
 * credentials, not account or party identities: this module is their only
 * persistence path, and no analytics/network module imports it.
 *
 * This native implementation uses Keychain/Keystore. The `.web.ts` sibling is
 * deliberately memory-only because Expo web's SecureStore shim is plaintext.
 */
export function getOrCreateQuantumLayerIdentities(
  generateUuid: () => string = randomUUID,
): Promise<InstallationBoardLayer[]> {
  if (inFlightLoad) return inFlightLoad;

  inFlightLoad = (async () => {
    const stored = parseStoredLayers(await SecureStore.getItemAsync(QUANTUM_LAYER_IDENTITIES_KEY));
    if (stored) return stored;

    const controllerUserUuids = Array.from({ length: 4 }, () => generateUuid());
    const layers = buildInstallationBoardLayers(controllerUserUuids);
    const payload: StoredQuantumLayerIdentities = { version: 1, controllerUserUuids };
    await SecureStore.setItemAsync(QUANTUM_LAYER_IDENTITIES_KEY, JSON.stringify(payload), SECURE_STORE_WRITE_OPTIONS);
    return layers;
  })().finally(() => {
    inFlightLoad = null;
  });
  return inFlightLoad;
}
