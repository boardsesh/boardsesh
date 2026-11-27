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

describe('Quantum controller players on web', () => {
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

  it('reuses one solo and one started-session credential only while the page is loaded', async () => {
    const soloId = '10000000-0000-4000-8000-000000000001';
    const sessionId = '20000000-0000-4000-8000-000000000001';
    const scope = { sessionId: 'public-session-id', accountId: 'account-id' };
    const firstPageStore = await import('../quantum-layer-identity-store.web');

    const created = await firstPageStore.getOrCreateQuantumSoloPlayer(() => soloId);
    const reused = await firstPageStore.getOrCreateQuantumSoloPlayer(() => {
      throw new Error('same-page solo credential should be reused');
    });
    expect(created.controllerUserUuid).toBe(soloId);
    expect(reused).toBe(created);
    await firstPageStore.rememberStartedQuantumSessionPlayer(
      scope,
      () => true,
      () => sessionId,
    );
    await expect(firstPageStore.getQuantumSessionPlayer(scope)).resolves.toMatchObject({
      controllerUserUuid: sessionId,
    });
    await expect(firstPageStore.getQuantumSessionPlayer({ ...scope, accountId: 'other' })).resolves.toBeNull();

    vi.resetModules();
    const nextPage = await import('../quantum-layer-identity-store.web');
    await expect(nextPage.getQuantumSessionPlayer(scope)).resolves.toBeNull();
    expect(await nextPage.getOrCreateQuantumSoloPlayer(() => sessionId)).not.toBe(created);
    expect(secureStore.getItemAsync).not.toHaveBeenCalled();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
    expect(indexedDbReads).toBe(0);
    expect(localStorageReads).toBe(0);
  });
});
