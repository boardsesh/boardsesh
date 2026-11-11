import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ records: new Map<string, unknown>(), read: vi.fn(), write: vi.fn() }));
const backend = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../auth-store', () => ({ getAuthToken: async () => 'token' }));
vi.mock('../../graphql/client', () => ({ getHttpClient: () => backend }));
vi.mock('../../preference-store', () => ({
  getPreference: async (key: string) => {
    const stored = storage.records.get(key) ?? null;
    await storage.read(key);
    return stored;
  },
  setPreference: async (key: string, stored: unknown) => {
    await storage.write(key);
    storage.records.set(key, stored);
  },
  removePreference: async (key: string) => {
    storage.records.delete(key);
  },
  removePreferencesMatching: async (matches: (key: string) => boolean) => {
    for (const key of storage.records.keys()) if (matches(key)) storage.records.delete(key);
  },
}));

import { setPreference } from '../../preference-store';
import { eraseAllSprayWallLedCaches, eraseSprayWallLedCache } from '../spray-wall-led-cache';
import {
  markSprayWallLedSaveStarted,
  prepareSprayWallLedRead,
  queueSprayWallLedUpload,
  resetSprayWallLedSyncForTests,
} from '../spray-wall-led-sync';

const WALL = 'wall-one';
const SETTINGS_KEY = `sprayWallLedSettings:${WALL}`;
const local = { version: 1, enabled: true, controller: { type: 'wled', url: 'http://wled.local' } };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
const settle = async () => {
  await vi.dynamicImportSettled();
  for (let turn = 0; turn < 80; turn += 1) await Promise.resolve();
};

beforeEach(async () => {
  storage.read.mockReset();
  storage.write.mockReset();
  await eraseAllSprayWallLedCaches();
  resetSprayWallLedSyncForTests();
  backend.request.mockReset();
});

describe('LED cache erasure while disk operations are suspended', () => {
  it.each(['account', 'wall'])('finishes %s erasure after a suspended server merge', async (scope) => {
    backend.request.mockResolvedValue({
      sprayWallLedSetup: {
        viewerCanEdit: false,
        setup: {
          controllerType: 'wled',
          controllerUrl: 'http://wled.local',
          enabled: true,
          layout: null,
        },
      },
    });
    const blocked = deferred();
    const entered = deferred();
    storage.write.mockImplementationOnce(async () => {
      entered.resolve();
      await blocked.promise;
    });
    const reading = prepareSprayWallLedRead(WALL, 'settings');
    await entered.promise;
    const erasing = scope === 'account' ? eraseAllSprayWallLedCaches() : eraseSprayWallLedCache(WALL);
    blocked.resolve();
    await Promise.all([reading, erasing]);
    await settle();
    expect(storage.records.size).toBe(0);
    expect(backend.request).toHaveBeenCalledTimes(1);
  });

  it('rejects a local save paused inside its native write at sign-out', async () => {
    const blocked = deferred();
    const entered = deferred();
    storage.write.mockImplementation(async (key: string) => {
      if (key === SETTINGS_KEY) {
        entered.resolve();
        await blocked.promise;
      }
    });
    const writing = markSprayWallLedSaveStarted(WALL, 'settings', () => setPreference(SETTINGS_KEY, local));
    const rejected = expect(writing).rejects.toThrow('withdrawn');
    await entered.promise;
    const erasing = eraseAllSprayWallLedCaches();
    blocked.resolve();
    await Promise.all([rejected, erasing]);
    expect(storage.records.size).toBe(0);
    expect(backend.request).not.toHaveBeenCalled();
  });

  it('does not start an old upload after its disk read crosses sign-out', async () => {
    await markSprayWallLedSaveStarted(WALL, 'settings', () => setPreference(SETTINGS_KEY, local));
    const blocked = deferred();
    const entered = deferred();
    storage.read.mockImplementationOnce(async () => {
      entered.resolve();
      await blocked.promise;
    });
    queueSprayWallLedUpload(WALL, 'settings');
    await entered.promise;
    const erasing = eraseAllSprayWallLedCaches();
    blocked.resolve();
    await erasing;
    await settle();
    expect(storage.records.size).toBe(0);
    expect(backend.request).not.toHaveBeenCalled();
  });
});
