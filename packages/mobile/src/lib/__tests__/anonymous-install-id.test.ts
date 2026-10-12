import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failReads: false,
  failWrites: false,
}));
vi.mock('../preference-store', () => ({
  getPreference: async (key: string) => {
    if (storage.failReads) throw new Error('storage locked before first unlock');
    const raw = storage.values.get(key);
    return raw === undefined ? null : JSON.parse(raw);
  },
  setPreference: async (key: string, value: unknown) => {
    if (storage.failWrites) throw new Error('storage write unavailable');
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

const application = vi.hoisted(() => ({ installedAt: Date.UTC(2026, 9, 1, 8, 30) as number | null, fails: false }));
vi.mock('expo-application', () => ({
  getInstallationTimeAsync: async () => {
    if (application.fails) throw new Error("Cannot find native module 'ExpoApplication'");
    // Like expo-application: the web module returns null, which becomes the epoch.
    return new Date(application.installedAt ?? 0);
  },
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function storedRecord(): { id: string; installedAt: number | null; createdAt: number } | null {
  const raw = storage.values.get('anonymousInstallId');
  return raw === undefined ? null : JSON.parse(raw);
}

async function loadModule() {
  vi.resetModules();
  return import('../anonymous-install-id');
}

beforeEach(() => {
  storage.values.clear();
  storage.failReads = false;
  storage.failWrites = false;
  expoCrypto.available = true;
  expoCrypto.calls = 0;
  application.installedAt = Date.UTC(2026, 9, 1, 8, 30);
  application.fails = false;
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

  it('stores the id with the install time it belongs to and when it was minted', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 11, 12), toFake: ['Date'] });
    const launch = await loadModule();
    const id = await launch.getAnonymousInstallId();
    expect(storedRecord()).toEqual({
      id,
      installedAt: Date.UTC(2026, 9, 1, 8, 30),
      createdAt: Date.UTC(2026, 9, 11, 12),
    });
  });

  it.each([
    ['not a UUID', { id: 'device-serial-123', installedAt: null, createdAt: Date.now() }],
    ['a bare string (no install time)', '6f7f2f39-6c4c-4d4e-9a49-3b3f6a1c2d10'],
  ])('replaces a stored value that is %s', async (_label, stored) => {
    storage.values.set('anonymousInstallId', JSON.stringify(stored));
    const launch = await loadModule();
    const id = await launch.getAnonymousInstallId();
    expect(id).toMatch(UUID);
    expect(id).not.toBe('6f7f2f39-6c4c-4d4e-9a49-3b3f6a1c2d10');
    expect(storedRecord()?.id).toBe(id);
  });

  it('mints a new id when storage was restored from another install (Android Auto Backup)', async () => {
    const original = await (await loadModule()).getAnonymousInstallId();

    // Same storage, restored onto a reinstall: the platform reports a new install time.
    application.installedAt = Date.UTC(2026, 9, 9, 17, 5);
    const restored = await loadModule();
    const id = await restored.getAnonymousInstallId();

    expect(id).toMatch(UUID);
    expect(id).not.toBe(original);
    expect(storedRecord()).toMatchObject({ id, installedAt: Date.UTC(2026, 9, 9, 17, 5) });
  });

  it('keeps the id across an app update (same install time)', async () => {
    const original = await (await loadModule()).getAnonymousInstallId();
    expect(await (await loadModule()).getAnonymousInstallId()).toBe(original);
  });

  it.each([
    ['the platform has no install time (browser app)', () => (application.installedAt = null)],
    ['expo-application is unavailable', () => (application.fails = true)],
  ])('keeps the id when %s', async (_label, arrange) => {
    arrange();
    const original = await (await loadModule()).getAnonymousInstallId();
    expect(storedRecord()?.installedAt).toBeNull();
    application.installedAt = Date.UTC(2026, 9, 9, 17, 5);
    application.fails = false;
    expect(await (await loadModule()).getAnonymousInstallId()).toBe(original);
  });

  it('rotates the id 13 months after it was minted', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 11, 12), toFake: ['Date'] });
    const original = await (await loadModule()).getAnonymousInstallId();

    vi.setSystemTime(Date.UTC(2027, 10, 11, 11, 59));
    expect(await (await loadModule()).getAnonymousInstallId()).toBe(original);

    vi.setSystemTime(Date.UTC(2027, 10, 11, 12));
    const rotated = await (await loadModule()).getAnonymousInstallId();
    expect(rotated).toMatch(UUID);
    expect(rotated).not.toBe(original);
    expect(storedRecord()).toMatchObject({ id: rotated, createdAt: Date.UTC(2027, 10, 11, 12) });
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
    expect(storedRecord()?.id).toBe(stored);
  });

  it.each(['failReads', 'failWrites'] as const)(
    'requires persistence for install-level health while %s keeps flag fallback usable',
    async (failure) => {
      storage[failure] = true;
      const launch = await loadModule();
      const [flags, health] = await Promise.all([
        launch.getFlagsInstallDistinctId(),
        launch.getPersistentAnonymousInstallId(),
      ]);
      expect(flags).toMatch(/^flags-install:[0-9a-f-]{36}$/);
      expect(health).toBeNull();
      expect(storage.values.size).toBe(0);
      storage[failure] = false;
      const persisted = await launch.getPersistentAnonymousInstallId();
      expect(persisted).toMatch(UUID);
      expect(storedRecord()?.id).toBe(persisted);
      expect(await launch.getFlagsInstallDistinctId()).toBe(`flags-install:${persisted}`);
      expect(await (await loadModule()).getPersistentAnonymousInstallId()).toBe(persisted);
    },
  );

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
