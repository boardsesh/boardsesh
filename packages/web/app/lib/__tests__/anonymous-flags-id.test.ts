import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getPreference } from '../user-preferences-db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadModule() {
  vi.resetModules();
  return import('../anonymous-flags-id');
}

describe('getAnonymousFlagsId', () => {
  beforeEach(async () => {
    const { removePreference } = await import('../user-preferences-db');
    await removePreference('anonymousFlagsId');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates one random id and keeps it in IndexedDB across page loads', async () => {
    const firstLoad = await loadModule();
    const id = await firstLoad.getAnonymousFlagsId();
    expect(id).toMatch(UUID);
    expect(await getPreference('anonymousFlagsId')).toMatchObject({ id });

    const secondLoad = await loadModule();
    expect(await secondLoad.getAnonymousFlagsId()).toBe(id);
    expect(await secondLoad.getFlagsBrowserDistinctId()).toBe(`flags-browser:${id}`);
  });

  it('replaces a bare stored string with a dated record', async () => {
    const { setPreference } = await import('../user-preferences-db');
    await setPreference('anonymousFlagsId', '6f7f2f39-6c4c-4d4e-9a49-3b3f6a1c2d10');
    const load = await loadModule();
    const id = await load.getAnonymousFlagsId();
    expect(id).toMatch(UUID);
    expect(id).not.toBe('6f7f2f39-6c4c-4d4e-9a49-3b3f6a1c2d10');
    expect(await getPreference('anonymousFlagsId')).toMatchObject({ id });
  });

  it('rotates the id 13 months after it was minted', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 11, 12), toFake: ['Date'] });
    const original = await (await loadModule()).getAnonymousFlagsId();
    expect(await getPreference('anonymousFlagsId')).toEqual({ id: original, createdAt: Date.UTC(2026, 9, 11, 12) });

    vi.setSystemTime(Date.UTC(2027, 10, 11, 11, 59));
    expect(await (await loadModule()).getAnonymousFlagsId()).toBe(original);

    vi.setSystemTime(Date.UTC(2027, 10, 11, 12));
    const rotated = await (await loadModule()).getAnonymousFlagsId();
    expect(rotated).toMatch(UUID);
    expect(rotated).not.toBe(original);
    expect(await getPreference('anonymousFlagsId')).toEqual({ id: rotated, createdAt: Date.UTC(2027, 10, 11, 12) });
  });
});

describe('getAnonymousFlagsId without Web Crypto', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses getRandomValues outside a secure context', async () => {
    const { removePreference } = await import('../user-preferences-db');
    await removePreference('anonymousFlagsId');
    const getRandomValues = vi.fn(<T extends ArrayBufferView>(array: T) => {
      new Uint8Array(array.buffer).fill(0x5c);
      return array;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const load = await loadModule();
    expect(await load.getAnonymousFlagsId()).toMatch(UUID);
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it('fails closed, without throwing, when the browser has no crypto at all', async () => {
    const { removePreference } = await import('../user-preferences-db');
    await removePreference('anonymousFlagsId');
    vi.stubGlobal('crypto', undefined);
    const mathRandom = vi.spyOn(Math, 'random');
    const load = await loadModule();

    await expect(load.getAnonymousFlagsId()).resolves.toBeNull();
    await expect(load.getFlagsBrowserDistinctId()).resolves.toBeNull();
    expect(await getPreference('anonymousFlagsId')).toBeNull();
    expect(mathRandom).not.toHaveBeenCalled();
    mathRandom.mockRestore();
  });

  it('fails closed when crypto itself throws', async () => {
    const { removePreference } = await import('../user-preferences-db');
    await removePreference('anonymousFlagsId');
    vi.stubGlobal('crypto', {
      getRandomValues: () => {
        throw new Error('QuotaExceededError');
      },
    });
    const load = await loadModule();
    await expect(load.getAnonymousFlagsId()).resolves.toBeNull();
  });
});

describe('withAnonymousFlagsIdentity', () => {
  const body = JSON.stringify({
    token: 'phc',
    distinct_id: 'sdk-anonymous',
    $anon_distinct_id: 'sdk-anonymous',
    $device_id: 'sdk-device',
    person_properties: { $browser: 'Firefox' },
  });

  it('buckets on the browser id and drops the SDK anonymous and device ids', async () => {
    const { withAnonymousFlagsIdentity } = await loadModule();
    expect(JSON.parse(withAnonymousFlagsIdentity(body, 'flags-browser:abc'))).toEqual({
      token: 'phc',
      distinct_id: 'flags-browser:abc',
      person_properties: { $browser: 'Firefox' },
    });
  });

  it('leaves a body that is not a JSON object alone', async () => {
    const { withAnonymousFlagsIdentity } = await loadModule();
    expect(withAnonymousFlagsIdentity('not json', 'flags-browser:abc')).toBe('not json');
    expect(withAnonymousFlagsIdentity('[1]', 'flags-browser:abc')).toBe('[1]');
  });
});
