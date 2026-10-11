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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function loadModule() {
  vi.resetModules();
  return import('../anonymous-install-id');
}

beforeEach(() => {
  storage.values.clear();
  storage.failReads = false;
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
});
