import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';

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
};

export type QuantumSessionPlayerScope = { sessionId: string; accountId: string };

type StoredSessionPlayer = QuantumSessionPlayerScope & { controllerUserUuid: string };

let soloLoad: Promise<QuantumLocalPlayer> | null = null;
let sessionWriteTail: Promise<void> = Promise.resolve();

// The v1 array could migrate through iOS backups. Leave that storage intact
// and only arm credentials created with the device-only accessibility class.
export function getOrCreateQuantumSoloPlayer(generateUuid: () => string = randomUUID): Promise<QuantumLocalPlayer> {
  if (soloLoad) return soloLoad;
  soloLoad = (async () => {
    const stored = await SecureStore.getItemAsync(SOLO_PLAYER_KEY);
    const controllerUserUuid = stored && PLAYER_UUID.test(stored) ? stored : generateUuid();
    if (stored !== controllerUserUuid) {
      await SecureStore.setItemAsync(SOLO_PLAYER_KEY, controllerUserUuid, DEVICE_ONLY_OPTIONS);
    }
    return { controllerUserUuid };
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
    return { controllerUserUuid: uuid };
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
