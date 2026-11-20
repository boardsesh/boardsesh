// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

vi.mock('expo-secure-store', () => secureStore);
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }));

const originalIndexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let indexedDbReads = 0;
let localStorageReads = 0;

function restoreProperty(name: 'indexedDB' | 'localStorage', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

describe('getOrCreateQuantumLayerIdentities on web', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    indexedDbReads = 0;
    localStorageReads = 0;
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      get: () => {
        indexedDbReads += 1;
        throw new Error('Quantum identities must not read IndexedDB');
      },
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        localStorageReads += 1;
        throw new Error('Quantum identities must not read localStorage');
      },
    });
  });

  afterEach(() => {
    restoreProperty('indexedDB', originalIndexedDbDescriptor);
    restoreProperty('localStorage', originalLocalStorageDescriptor);
  });

  it('reuses UUIDs only in memory and never touches browser or SecureStore persistence', async () => {
    const firstPageIds = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000004',
    ];
    const generateFirstPageUuid = vi.fn(() => firstPageIds[generateFirstPageUuid.mock.calls.length - 1]);
    const firstPageStore = await import('../quantum-layer-identity-store.web');

    const created = await firstPageStore.getOrCreateQuantumLayerIdentities(generateFirstPageUuid);
    const reused = await firstPageStore.getOrCreateQuantumLayerIdentities(() => {
      throw new Error('same-page identities should be reused');
    });

    expect(created.map((layer) => layer.controllerUserUuid)).toEqual(firstPageIds);
    expect(reused).toBe(created);

    // Reloading the module models a fresh page: there is no persisted identity
    // to recover, so the four controller UUIDs rotate.
    vi.resetModules();
    const nextPageIds = firstPageIds.map((uuid) => uuid.replace('10000000', '20000000'));
    const generateNextPageUuid = vi.fn(() => nextPageIds[generateNextPageUuid.mock.calls.length - 1]);
    const nextPageStore = await import('../quantum-layer-identity-store.web');
    const nextPage = await nextPageStore.getOrCreateQuantumLayerIdentities(generateNextPageUuid);

    expect(nextPage.map((layer) => layer.controllerUserUuid)).toEqual(nextPageIds);
    expect(secureStore.getItemAsync).not.toHaveBeenCalled();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
    expect(indexedDbReads).toBe(0);
    expect(localStorageReads).toBe(0);
  });
});
