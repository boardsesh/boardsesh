import { randomUUID } from 'expo-crypto';
import { buildInstallationBoardLayers, type InstallationBoardLayer } from '@boardsesh/board-layers';

let memoryLayers: InstallationBoardLayer[] | null = null;

/**
 * Browser controller identities are credential-like wall capabilities. Keep
 * them stable only for this loaded page: Expo web's SecureStore compatibility
 * layer is plaintext IndexedDB, so it must never receive these UUIDs.
 *
 * A reload deliberately rotates the four identities. The controller roster's
 * existing foreign layers still consume slots and can be cleared explicitly;
 * no identifier is recovered from browser storage or sent to a server.
 */
export async function getOrCreateQuantumLayerIdentities(
  generateUuid: () => string = randomUUID,
): Promise<InstallationBoardLayer[]> {
  if (memoryLayers) return memoryLayers;
  memoryLayers = buildInstallationBoardLayers(Array.from({ length: 4 }, () => generateUuid()));
  return memoryLayers;
}
