import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStore = vi.hoisted(() => ({
  stored: new Map<string, string>(),
  getItemAsync: vi.fn(async (key: string) => secureStore.stored.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, stored: string) => {
    secureStore.stored.set(key, stored);
  }),
}));

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
  ...secureStore,
}));
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }));

const SOLO_ID = '10000000-0000-4000-8000-000000000001';
const SESSION_ID = '20000000-0000-4000-8000-000000000001';
const scope = { sessionId: 'room-a', accountId: 'climber' };

describe('Quantum controller players in native SecureStore', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    secureStore.stored.clear();
  });

  it('creates one stable solo credential when two callers load it at once', async () => {
    const { getOrCreateQuantumSoloPlayer } = await import('../quantum-layer-identity-store');
    const generate = vi.fn(() => SOLO_ID);
    const [first, second] = await Promise.all([
      getOrCreateQuantumSoloPlayer(generate),
      getOrCreateQuantumSoloPlayer(generate),
    ]);
    expect(first).toEqual({ controllerUserUuid: SOLO_ID });
    expect(second).toEqual(first);
    expect(generate).toHaveBeenCalledOnce();
    expect(secureStore.setItemAsync).toHaveBeenCalledOnce();
    expect(secureStore.setItemAsync).toHaveBeenCalledWith('boardsesh_quantum_solo_player_v1', SOLO_ID, {
      keychainAccessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    });
  });

  it('leaves a restored v1 blob untouched and treats all its IDs as foreign', async () => {
    const legacyKey = 'boardsesh_quantum_layer_ids_v1';
    const ids = Array.from({ length: 4 }, (_, index) => SOLO_ID.slice(0, -1) + (index + 1));
    const legacy = JSON.stringify({ version: 1, controllerUserUuids: ids });
    secureStore.stored.set(legacyKey, legacy);
    const { getOrCreateQuantumSoloPlayer } = await import('../quantum-layer-identity-store');
    const generator = vi.fn(() => SESSION_ID);
    expect(await getOrCreateQuantumSoloPlayer(generator)).toEqual({
      controllerUserUuid: SESSION_ID,
    });
    expect(generator).toHaveBeenCalledOnce();
    expect(secureStore.stored.get(legacyKey)).toBe(legacy);
  });

  it('reads the random session credential after restart only for its original account and session', async () => {
    const store = await import('../quantum-layer-identity-store');
    const generator = vi.fn(() => SESSION_ID);
    await expect(store.getQuantumSessionPlayer(scope)).resolves.toBeNull();
    await store.rememberStartedQuantumSessionPlayer(scope, () => true, generator);
    await store.rememberStartedQuantumSessionPlayer(scope, () => true, generator);
    expect(generator).toHaveBeenCalledOnce();

    vi.resetModules();
    const restarted = await import('../quantum-layer-identity-store');
    await expect(restarted.getQuantumSessionPlayer(scope)).resolves.toMatchObject({ controllerUserUuid: SESSION_ID });
    await expect(restarted.getQuantumSessionPlayer({ ...scope, accountId: 'other' })).resolves.toBeNull();
    await expect(restarted.getQuantumSessionPlayer({ ...scope, sessionId: 'room-b' })).resolves.toBeNull();

    // A second phone has the same signed-in account but none of the originating phone's keys.
    secureStore.stored.clear();
    await expect(restarted.getQuantumSessionPlayer(scope)).resolves.toBeNull();
    expect(secureStore.setItemAsync).toHaveBeenCalledOnce();
  });

  it('does not mint a credential for a stale Start command', async () => {
    const { rememberStartedQuantumSessionPlayer } = await import('../quantum-layer-identity-store');
    const generator = vi.fn(() => SESSION_ID);
    await rememberStartedQuantumSessionPlayer(scope, () => false, generator);
    expect(generator).not.toHaveBeenCalled();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });
});
