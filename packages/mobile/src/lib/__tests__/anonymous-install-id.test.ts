import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failReads: false,
}));
vi.mock('../preference-store', () => ({
  getPreference: async (key: string) => {
    if (storage.failReads) throw new Error('storage locked before first unlock');
    const raw = storage.values.get(key);
    return raw === undefined ? null : JSON.parse(raw);
  },
  setPreference: async (key: string, value: unknown) => {
    storage.values.set(key, JSON.stringify(value));
  },
}));

const expoCrypto = vi.hoisted(() => ({ available: true, calls: 0 }));
vi.mock('expo-crypto', () => ({
  getRandomBytes: (byteCount: number) => {
    expoCrypto.calls += 1;
    if (!expoCrypto.available) throw new Error("Cannot find native module 'ExpoCrypto'");
    return Uint8Array.from({ length: byteCount }, (_, index) => (index * 37 + 11) % 256);
  },
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function loadModule() {
  vi.resetModules();
  return import('../anonymous-install-id');
}

beforeEach(() => {
  storage.values.clear();
  storage.failReads = false;
  expoCrypto.available = true;
  expoCrypto.calls = 0;
  vi.unstubAllGlobals();
});

describe('getAnonymousInstallId', () => {
  it('creates a random UUID once and keeps it across launches', async () => {
    const firstLaunch = await loadModule();
    const id = await firstLaunch.getAnonymousInstallId();
    expect(id).toMatch(UUID);
    expect(await firstLaunch.getAnonymousInstallId()).toBe(id);

    const secondLaunch = await loadModule();
    expect(await secondLaunch.getAnonymousInstallId()).toBe(id);
  });

  it('gives concurrent first callers the same id', async () => {
    const launch = await loadModule();
    const [first, second] = await Promise.all([launch.getAnonymousInstallId(), launch.getAnonymousInstallId()]);
    expect(first).toBe(second);
    expect(storage.values.size).toBe(1);
  });

  it('replaces a stored value that is not a UUID', async () => {
    storage.values.set('anonymousInstallId', JSON.stringify('device-serial-123'));
    const launch = await loadModule();
    const id = await launch.getAnonymousInstallId();
    expect(id).toMatch(UUID);
    expect(JSON.parse(storage.values.get('anonymousInstallId') ?? 'null')).toBe(id);
  });

  it('falls back to a launch-only id when storage cannot be read, then retries storage', async () => {
    storage.failReads = true;
    const launch = await loadModule();
    const fallback = await launch.getAnonymousInstallId();
    expect(fallback).toMatch(UUID);
    expect(storage.values.size).toBe(0);

    storage.failReads = false;
    const stored = await launch.getAnonymousInstallId();
    expect(stored).toMatch(UUID);
    expect(JSON.parse(storage.values.get('anonymousInstallId') ?? 'null')).toBe(stored);
  });

  it('prefixes the flags distinct id', async () => {
    const launch = await loadModule();
    expect(await launch.getFlagsInstallDistinctId()).toBe(`flags-install:${await launch.getAnonymousInstallId()}`);
  });

  it('uses getRandomValues when randomUUID is missing', async () => {
    const getRandomValues = vi.fn(<T extends ArrayBufferView>(array: T) => {
      new Uint8Array(array.buffer).fill(0xab);
      return array;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const launch = await loadModule();
    expect(await launch.getAnonymousInstallId()).toMatch(UUID);
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(expoCrypto.calls).toBe(0);
  });

  it('falls back to expo-crypto when the runtime has no Web Crypto', async () => {
    vi.stubGlobal('crypto', undefined);
    const launch = await loadModule();
    expect(await launch.getAnonymousInstallId()).toMatch(UUID);
    expect(expoCrypto.calls).toBe(1);
  });

  it('fails closed with no secure random source: no id, nothing stored, never Math.random', async () => {
    vi.stubGlobal('crypto', undefined);
    expoCrypto.available = false;
    const mathRandom = vi.spyOn(Math, 'random');
    const launch = await loadModule();

    expect(await launch.getAnonymousInstallId()).toBeNull();
    expect(await launch.getFlagsInstallDistinctId()).toBeNull();
    expect(storage.values.size).toBe(0);
    expect(mathRandom).not.toHaveBeenCalled();
    mathRandom.mockRestore();
  });
});
