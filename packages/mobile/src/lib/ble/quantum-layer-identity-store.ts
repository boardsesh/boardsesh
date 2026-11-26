import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import { buildInstallationBoardLayers } from '@boardsesh/board-layers';

const LEGACY_LAYER_IDS_KEY = 'boardsesh_quantum_layer_ids_v1';
const SOLO_PLAYER_KEY = 'boardsesh_quantum_solo_player_v1';
const SESSION_PLAYER_KEY = 'boardsesh_quantum_session_player_v1';
// Unlike the ordinary provenance marker, the radio credential must stay
// on the original iPhone even across an encrypted backup restore.
const DEVICE_ONLY_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible:
    'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY' in SecureStore ? SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY : undefined,
};
const PLAYER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type QuantumLocalPlayer = {
  controllerUserUuid: string;
  legacyCleanupUserUuids: readonly string[];
};

export type QuantumSessionPlayerScope = { sessionId: string; accountId: string };

type StoredSessionPlayer = QuantumSessionPlayerScope & { controllerUserUuid: string };

let soloLoad: Promise<QuantumLocalPlayer> | null = null;
let sessionWriteTail: Promise<void> = Promise.resolve();

function parseLegacyUserUuids(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; controllerUserUuids?: string[] };
    if (parsed.version !== 1 || !Array.isArray(parsed.controllerUserUuids)) return [];
    return buildInstallationBoardLayers(parsed.controllerUserUuids).map((layer) => layer.controllerUserUuid);
  } catch {
    return [];
  }
}

/** Keep one solo credential. Older credentials stay available for scoped cleanup. */
export function getOrCreateQuantumSoloPlayer(generateUuid: () => string = randomUUID): Promise<QuantumLocalPlayer> {
  if (soloLoad) return soloLoad;
  soloLoad = (async () => {
    const [stored, legacyRaw] = await Promise.all([
      SecureStore.getItemAsync(SOLO_PLAYER_KEY),
      SecureStore.getItemAsync(LEGACY_LAYER_IDS_KEY),
    ]);
    const legacyUserUuids = parseLegacyUserUuids(legacyRaw);
    const controllerUserUuid = stored && PLAYER_UUID.test(stored) ? stored : generateUuid();
    if (stored !== controllerUserUuid) {
      await SecureStore.setItemAsync(SOLO_PLAYER_KEY, controllerUserUuid, DEVICE_ONLY_OPTIONS);
    }
    return {
      controllerUserUuid,
      legacyCleanupUserUuids: legacyUserUuids.filter((legacyUuid) => legacyUuid !== controllerUserUuid),
    };
  })().finally(() => {
    soloLoad = null;
  });
  return soloLoad;
}

export async function getQuantumSessionPlayer(scope: QuantumSessionPlayerScope): Promise<QuantumLocalPlayer | null> {
  const raw = await SecureStore.getItemAsync(SESSION_PLAYER_KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Partial<StoredSessionPlayer>;
    const uuid = stored.controllerUserUuid;
    if (
      stored.sessionId !== scope.sessionId ||
      stored.accountId !== scope.accountId ||
      !uuid ||
      !PLAYER_UUID.test(uuid)
    ) {
      return null;
    }
    return { controllerUserUuid: uuid, legacyCleanupUserUuids: [] };
  } catch {
    return null;
  }
}

/** Only the Start command calls this, after writing the device creator marker. */
export function rememberStartedQuantumSessionPlayer(
  scope: QuantumSessionPlayerScope,
  isCurrent: () => boolean,
  generateUuid: () => string = randomUUID,
): Promise<void> {
  const write = sessionWriteTail.then(async () => {
    if (!isCurrent() || (await getQuantumSessionPlayer(scope)) || !isCurrent()) return;
    const stored: StoredSessionPlayer = { ...scope, controllerUserUuid: generateUuid() };
    await SecureStore.setItemAsync(SESSION_PLAYER_KEY, JSON.stringify(stored), DEVICE_ONLY_OPTIONS);
  });
  sessionWriteTail = write.catch(() => undefined);
  return write;
}
