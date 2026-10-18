// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsChange } from '../../settings/hooks';
import type { SectionLayoutRecord, SectionLayoutSpec } from '../section-layout';

const settings = vi.hoisted(() => ({ listeners: new Set<(change: SettingsChange) => void>() }));
vi.mock('../../settings/hooks', () => ({
  subscribeSettings: (listener: (change: SettingsChange) => void) => {
    settings.listeners.add(listener);
    return () => settings.listeners.delete(listener);
  },
}));

import { createSectionLayoutStore, useSectionLayout } from '../section-layout-store';

type ButtonId = 'mirror' | 'favorite' | 'share' | 'queue';
const SPEC: SectionLayoutSpec<ButtonId> = {
  ids: ['mirror', 'favorite', 'share', 'queue'],
  defaults: {
    order: ['mirror', 'favorite', 'share', 'queue'],
    visible: { mirror: true, favorite: true, share: true, queue: true },
  },
};

function createStorage(initial: unknown = null) {
  const storage = {
    value: initial,
    failWrites: false,
    read: vi.fn(() => storage.value),
    write: vi.fn((record: SectionLayoutRecord | null) => {
      if (storage.failWrites) throw new Error('settings file could not be written');
      storage.value = JSON.parse(JSON.stringify(record));
      // The settings store signals every write, the store's own included.
      announceSettingWrite();
    }),
  };
  return storage;
}

function announceSettingWrite(): void {
  for (const listener of settings.listeners) listener({ kind: 'setting', key: 'climbRowDisplayV1' });
}

function resetEverySetting(): void {
  for (const listener of settings.listeners) listener({ kind: 'reset' });
}

beforeEach(() => {
  settings.listeners.clear();
});

describe('createSectionLayoutStore', () => {
  it('reads the defaults with nothing stored, and keeps one identity until a change', () => {
    const storage = createStorage();
    const store = createSectionLayoutStore({ spec: SPEC, ...storage });
    expect(store.getLayout()).toEqual(SPEC.defaults);
    expect(store.getLayout()).toBe(store.getLayout());
  });

  it('reads an older record: unknown ids go, a new id slots in where the defaults put it', () => {
    const storage = createStorage({
      version: 1,
      order: ['queue', 'gone', 'mirror', 'share'],
      visible: { share: false, gone: true },
    });
    const store = createSectionLayoutStore({ spec: SPEC, ...storage });
    expect(store.getLayout()).toEqual({
      order: ['queue', 'mirror', 'favorite', 'share'],
      visible: { mirror: true, favorite: true, share: false, queue: true },
    });
  });

  it.each([{ version: 2, order: ['queue'] }, 'broken', 42])('reads %j as the defaults', (stored) => {
    const store = createSectionLayoutStore({ spec: SPEC, ...createStorage(stored) });
    expect(store.getLayout()).toEqual(SPEC.defaults);
  });

  it('writes each change and tells subscribers once', () => {
    const storage = createStorage();
    const store = createSectionLayoutStore({ spec: SPEC, ...storage });
    const listener = vi.fn();
    store.subscribe(listener);
    store.move('queue', -1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(storage.value).toEqual({
      version: 1,
      order: ['mirror', 'favorite', 'queue', 'share'],
      visible: { mirror: true, favorite: true, share: true, queue: true },
    });
    store.setVisible('share', false);
    expect(storage.value).toMatchObject({ visible: { share: false } });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('writes nothing and keeps its identity for a change that changes nothing', () => {
    const storage = createStorage();
    const store = createSectionLayoutStore({ spec: SPEC, ...storage });
    const listener = vi.fn();
    store.subscribe(listener);
    store.move('mirror', -1);
    store.setVisible('share', true);
    store.setAllVisible(true);
    expect(storage.write).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(store.getLayout()).toEqual(SPEC.defaults);
  });

  it('stores null for a layout that matches the defaults, so later defaults still apply', () => {
    const storage = createStorage();
    const store = createSectionLayoutStore({ spec: SPEC, ...storage });
    store.move('favorite', 1);
    store.move('favorite', -1);
    expect(storage.value).toBeNull();
    store.setAllVisible(false);
    store.restoreDefaults();
    expect(storage.write).toHaveBeenLastCalledWith(null);
    expect(store.getLayout()).toEqual(SPEC.defaults);
  });

  it('takes a preset whole, cleaned like a stored record', () => {
    const storage = createStorage();
    const store = createSectionLayoutStore({ spec: SPEC, ...storage });
    store.apply({
      order: ['share', 'queue', 'mirror', 'favorite'],
      visible: { ...SPEC.defaults.visible, mirror: false },
    });
    expect(store.getLayout().order).toEqual(['share', 'queue', 'mirror', 'favorite']);
    expect(store.getLayout().visible.mirror).toBe(false);
  });

  it('never writes over a record the first read missed', () => {
    const storage = createStorage();
    const store = createSectionLayoutStore({ spec: SPEC, ...storage });
    storage.value = { version: 1, order: ['share', 'mirror', 'favorite', 'queue'], visible: { queue: false } };
    store.move('queue', -1);
    expect(store.getLayout()).toEqual({
      order: ['share', 'mirror', 'queue', 'favorite'],
      visible: { mirror: true, favorite: true, share: true, queue: false },
    });
  });

  it('keeps a choice in memory when the write fails, and carries it with the next write', () => {
    const storage = createStorage();
    const store = createSectionLayoutStore({ spec: SPEC, ...storage });
    storage.failWrites = true;
    store.setVisible('share', false);
    expect(store.getLayout().visible.share).toBe(false);
    expect(storage.value).toBeNull();
    storage.failWrites = false;
    store.move('queue', -1);
    expect(storage.value).toMatchObject({ order: ['mirror', 'favorite', 'queue', 'share'], visible: { share: false } });
  });

  it('goes back to the defaults when every setting is reset, even after a lost write', () => {
    const storage = createStorage();
    const store = createSectionLayoutStore({ spec: SPEC, ...storage });
    store.move('queue', -1);
    storage.failWrites = true;
    store.setVisible('share', false);
    storage.failWrites = false;
    storage.value = null;
    resetEverySetting();
    expect(store.getLayout()).toEqual(SPEC.defaults);
  });

  it('survives a storage read that throws', () => {
    const storage = createStorage();
    storage.read.mockImplementation(() => {
      throw new Error('locked');
    });
    const store = createSectionLayoutStore({ spec: SPEC, ...storage });
    expect(store.getLayout()).toEqual(SPEC.defaults);
  });

  it('re-renders a reader only when its layout changes', () => {
    const store = createSectionLayoutStore({ spec: SPEC, ...createStorage() });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useSectionLayout(store);
    });
    const first = result.current;
    act(() => store.setAllVisible(true));
    expect(renders).toBe(1);
    act(() => store.move('share', 1));
    expect(renders).toBe(2);
    expect(result.current).not.toBe(first);
    expect(result.current.order).toEqual(['mirror', 'favorite', 'queue', 'share']);
  });

  it('picks up a record, or a null, written from elsewhere', () => {
    const storage = createStorage();
    const store = createSectionLayoutStore({ spec: SPEC, ...storage });
    const listener = vi.fn();
    store.subscribe(listener);
    storage.value = { version: 1, order: ['queue', 'mirror', 'favorite', 'share'], visible: { share: false } };
    announceSettingWrite();
    expect(store.getLayout().order).toEqual(['queue', 'mirror', 'favorite', 'share']);
    expect(store.getLayout().visible.share).toBe(false);
    storage.value = null;
    announceSettingWrite();
    expect(store.getLayout()).toEqual(SPEC.defaults);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps a later release's sections through this release's writes, as after an OTA rollback", () => {
    const storage = createStorage({
      version: 1,
      order: ['mirror', 'favorite', 'angle', 'share', 'queue'],
      visible: { mirror: true, favorite: true, angle: false, share: true, queue: true },
    });
    const store = createSectionLayoutStore({ spec: SPEC, ...storage });
    expect(store.getLayout()).toEqual(SPEC.defaults);
    store.move('queue', -1);
    expect(storage.value).toEqual({
      version: 1,
      order: ['mirror', 'favorite', 'angle', 'queue', 'share'],
      visible: { mirror: true, favorite: true, angle: false, share: true, queue: true },
    });
    store.move('queue', 1);
    store.restoreDefaults();
    // Back to the defaults here, but the later release's switch still needs a home.
    expect(storage.value).toEqual({
      version: 1,
      order: ['mirror', 'favorite', 'angle', 'share', 'queue'],
      visible: { mirror: true, favorite: true, angle: false, share: true, queue: true },
    });
  });

  it('cleans a spec once, so a stray default id never reaches a layout', () => {
    const spec = {
      ...SPEC,
      defaults: { ...SPEC.defaults, order: ['mirror', 'gone', 'favorite', 'share', 'queue'] as ButtonId[] },
    };
    const store = createSectionLayoutStore({ spec, ...createStorage() });
    expect(store.getLayout().order).toEqual(['mirror', 'favorite', 'share', 'queue']);
    store.move('favorite', 1);
    store.restoreDefaults();
    expect(store.getLayout().order).toEqual(['mirror', 'favorite', 'share', 'queue']);
  });

  it('records its own write from the settings signal, without reading again', () => {
    const storage = createStorage();
    const store = createSectionLayoutStore({ spec: SPEC, ...storage });
    storage.read.mockClear();
    store.move('queue', -1);
    // One look before the change, one from the write's own signal.
    expect(storage.read).toHaveBeenCalledTimes(2);
  });

  it("keeps a later release's sections through two writes that send no settings signal", () => {
    const silent = createStorage({
      version: 1,
      order: ['mirror', 'angle', 'favorite', 'share', 'queue'],
      visible: { angle: true },
    });
    silent.write.mockImplementation((record: SectionLayoutRecord | null) => {
      silent.value = JSON.parse(JSON.stringify(record));
    });
    const store = createSectionLayoutStore({ spec: SPEC, ...silent });
    store.move('queue', -1);
    store.move('mirror', 1);
    expect(silent.value).toEqual({
      version: 1,
      order: ['favorite', 'mirror', 'angle', 'queue', 'share'],
      visible: { mirror: true, favorite: true, share: true, queue: true, angle: true },
    });
  });
});
