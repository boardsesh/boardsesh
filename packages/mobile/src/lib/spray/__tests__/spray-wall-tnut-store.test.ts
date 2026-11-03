import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TNUT_CORNERS, type TnutLayout } from '@boardsesh/spray-wall-geometry';

const preferences = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), records: new Map<string, unknown>() }));
vi.mock('../../preference-store', () => ({ getPreference: preferences.get, setPreference: preferences.set }));

import { loadSprayWallTnutLayout, saveSprayWallTnutLayout } from '../spray-wall-tnut-store';

const layoutKey = 'sprayWallTnutLayout:wall-one';
function configured(): TnutLayout {
  return {
    version: 1,
    pattern: 'grid',
    rows: 8,
    columns: 8,
    firstRowOffset: false,
    corners: structuredClone(DEFAULT_TNUT_CORNERS),
    holes: [
      { x: 0.1, y: 0.2 },
      { x: 0.7, y: 0.8 },
    ],
    photoKey: '42:version-9',
  };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  preferences.records.clear();
  preferences.get.mockReset().mockImplementation(async (key: string) => preferences.records.get(key) ?? null);
  preferences.set.mockReset().mockImplementation(async (key: string, layout: unknown) => {
    preferences.records.set(key, layout);
  });
});

describe('device-local T-nut layouts', () => {
  it('reads a missing layout without writing defaults', async () => {
    await expect(loadSprayWallTnutLayout('wall-one')).resolves.toBeNull();
    expect(preferences.get).toHaveBeenCalledWith(layoutKey, { strictParsing: true });
    expect(preferences.set).not.toHaveBeenCalled();
  });

  it.each([
    { version: 2 },
    { ...configured(), version: 2 },
    { ...configured(), holes: [{ x: 1.1, y: 0.5 }] },
    { ...configured(), rows: 1 },
    { ...configured(), photoKey: '' },
    'invalid JSON value',
  ])('fails closed on malformed or future layouts: %j', async (stored) => {
    preferences.records.set(layoutKey, stored);
    await expect(loadSprayWallTnutLayout('wall-one')).rejects.toThrow('Invalid saved T-nut layout');
    expect(preferences.records.get(layoutKey)).toBe(stored);
    expect(preferences.set).not.toHaveBeenCalled();
  });

  it('returns a detached normalized layout and ignores unknown stored fields', async () => {
    const stored = { ...configured(), legacyField: 'ignored' };
    preferences.records.set(layoutKey, stored);
    const loaded = await loadSprayWallTnutLayout('wall-one');
    expect(loaded).toEqual(configured());
    expect(loaded).not.toBe(stored);
    expect(loaded?.holes).not.toBe(stored.holes);
    expect(loaded?.corners.topLeft).not.toBe(stored.corners.topLeft);
    if (!loaded) throw new Error('Expected a saved layout');
    loaded.holes[0].x = 0.4;
    loaded.corners.topLeft.x = 0.2;
    expect(stored.holes[0].x).toBe(0.1);
    expect(stored.corners.topLeft.x).toBe(0.1);
  });

  it('saves the edited holes separately from WLED settings and other walls', async () => {
    const controllerKey = 'sprayWallLedSettings:wall-one';
    const controller = { version: 1, enabled: true, controller: { type: 'wled', url: 'http://wled.local' } };
    preferences.records.set(controllerKey, controller);
    await saveSprayWallTnutLayout('wall-one', configured());
    expect(preferences.set).toHaveBeenCalledWith(layoutKey, configured());
    expect(preferences.records.get(controllerKey)).toBe(controller);
    await expect(loadSprayWallTnutLayout('wall-one')).resolves.toEqual(configured());
    await expect(loadSprayWallTnutLayout('another-wall')).resolves.toBeNull();
  });

  it('refuses invalid saves without touching the stored layout', async () => {
    const stored = configured();
    preferences.records.set(layoutKey, stored);
    const invalid = { ...configured(), version: 2 } as unknown as TnutLayout;
    await expect(saveSprayWallTnutLayout('wall-one', invalid)).rejects.toThrow('Invalid T-nut layout');
    expect(preferences.set).not.toHaveBeenCalled();
    expect(preferences.records.get(layoutKey)).toBe(stored);
  });

  it('waits for a pending write before reopening the same wall', async () => {
    const write = deferred();
    preferences.set.mockImplementationOnce(async (key: string, layout: unknown) => {
      await write.promise;
      preferences.records.set(key, layout);
    });
    const saving = saveSprayWallTnutLayout('wall-one', configured());
    await vi.waitFor(() => expect(preferences.set).toHaveBeenCalledTimes(1));
    const reopening = loadSprayWallTnutLayout('wall-one');
    try {
      await Promise.resolve();
      expect(preferences.get).not.toHaveBeenCalled();
    } finally {
      write.resolve();
      await saving;
    }
    await expect(reopening).resolves.toEqual(configured());
  });

  it('registers a save before a same-turn reopen can read stale settings', async () => {
    const write = deferred();
    preferences.set.mockImplementationOnce(async (key: string, layout: unknown) => {
      await write.promise;
      preferences.records.set(key, layout);
    });
    const saving = saveSprayWallTnutLayout('wall-one', configured());
    const reopening = loadSprayWallTnutLayout('wall-one');
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(preferences.get).not.toHaveBeenCalled();
    } finally {
      write.resolve();
      await saving;
      await reopening;
    }
    await expect(reopening).resolves.toEqual(configured());
  });

  it('serializes overlapping saves so an older write cannot replace the latest holes', async () => {
    const write = deferred();
    preferences.set.mockImplementationOnce(async (key: string, layout: unknown) => {
      await write.promise;
      preferences.records.set(key, layout);
    });
    const first = saveSprayWallTnutLayout('wall-one', configured());
    const latest = { ...configured(), holes: [{ x: 0.5, y: 0.5 }] };
    const second = saveSprayWallTnutLayout('wall-one', latest);
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(preferences.set).toHaveBeenCalledTimes(1);
    } finally {
      write.resolve();
      await Promise.all([first, second]);
    }
    await expect(loadSprayWallTnutLayout('wall-one')).resolves.toEqual(latest);
  });

  it('continues an already queued save after the preceding write fails', async () => {
    const write = deferred();
    preferences.set.mockReturnValueOnce(write.promise);
    const first = saveSprayWallTnutLayout('wall-one', configured());
    const rejected = expect(first).rejects.toThrow('disk full');
    const latest = { ...configured(), holes: [{ x: 0.6, y: 0.4 }] };
    const second = saveSprayWallTnutLayout('wall-one', latest);
    const reopening = loadSprayWallTnutLayout('wall-one');
    await vi.waitFor(() => expect(preferences.set).toHaveBeenCalledTimes(1));
    write.reject(new Error('disk full'));
    await rejected;
    await second;
    await expect(reopening).resolves.toEqual(latest);
  });

  it('allows reopening and retry after a failed write without erasing saved holes', async () => {
    preferences.records.set(layoutKey, configured());
    const write = deferred();
    preferences.set.mockReturnValueOnce(write.promise);
    const saving = saveSprayWallTnutLayout('wall-one', { ...configured(), holes: [{ x: 0.5, y: 0.5 }] });
    const rejected = expect(saving).rejects.toThrow('disk full');
    await vi.waitFor(() => expect(preferences.set).toHaveBeenCalledTimes(1));
    const reopening = loadSprayWallTnutLayout('wall-one');
    write.reject(new Error('disk full'));
    await rejected;
    await expect(reopening).resolves.toEqual(configured());
    const next = { ...configured(), holes: [{ x: 0.5, y: 0.5 }] };
    await saveSprayWallTnutLayout('wall-one', next);
    await expect(loadSprayWallTnutLayout('wall-one')).resolves.toEqual(next);
  });
});
