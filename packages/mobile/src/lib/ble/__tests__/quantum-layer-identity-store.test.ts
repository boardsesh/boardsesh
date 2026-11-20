import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStore = vi.hoisted(() => ({
  stored: null as string | null,
  getItemAsync: vi.fn(async () => secureStore.stored),
  setItemAsync: vi.fn(async (_key: string, stored: string) => {
    secureStore.stored = stored;
  }),
}));

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
  getItemAsync: secureStore.getItemAsync,
  setItemAsync: secureStore.setItemAsync,
}));

vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }));

describe('getOrCreateQuantumLayerIdentities', () => {
  beforeEach(() => {
    secureStore.stored = null;
    secureStore.getItemAsync.mockClear();
    secureStore.setItemAsync.mockClear();
  });

  it('persists four stable install-local ids with fixed colors', async () => {
    const ids = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000004',
    ];
    const generateUuid = vi.fn(() => ids[generateUuid.mock.calls.length - 1]);
    const { getOrCreateQuantumLayerIdentities } = await import('../quantum-layer-identity-store');

    const created = await getOrCreateQuantumLayerIdentities(generateUuid);
    const loaded = await getOrCreateQuantumLayerIdentities(() => {
      throw new Error('stored identities should be reused');
    });

    expect(created.map((layer) => layer.controllerUserUuid)).toEqual(ids);
    expect(created.map((layer) => layer.color.key)).toEqual(['green', 'cyan', 'magenta', 'yellow']);
    expect(loaded).toEqual(created);
    expect(secureStore.setItemAsync).toHaveBeenCalledOnce();
    expect(secureStore.setItemAsync.mock.calls[0][0]).toBe('boardsesh_quantum_layer_ids_v1');
  });

  it('replaces malformed storage instead of handing it to the controller', async () => {
    secureStore.stored = JSON.stringify({ version: 1, controllerUserUuids: ['not-a-uuid'] });
    const ids = [
      '30000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000003',
      '30000000-0000-4000-8000-000000000004',
    ];
    const generateUuid = vi.fn(() => ids[generateUuid.mock.calls.length - 1]);
    const { getOrCreateQuantumLayerIdentities } = await import('../quantum-layer-identity-store');

    const layers = await getOrCreateQuantumLayerIdentities(generateUuid);

    expect(layers.map((layer) => layer.controllerUserUuid)).toEqual(ids);
    expect(secureStore.setItemAsync).toHaveBeenCalledOnce();
  });
});
