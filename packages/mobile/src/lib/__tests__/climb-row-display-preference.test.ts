// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLIMB_ROW_DISPLAY, matchClimbRowPreset, type ClimbRowOverrides } from '../climb-row-display';

const SETTINGS_KEY = 'climbRowDisplayV1';
const LEGACY_TAGS_KEY = 'showPlaylistTagsOnClimbList';
const LEGACY_QUICK_ACTIONS_KEY = 'showClimbQuickActionsButton';

const { mmkv, mmkvSet, legacyStorage, readLegacy, writeLegacy, removeLegacy, captured } = vi.hoisted(() => {
  const mmkv = new Map<string, string>();
  const legacyStorage = new Map<string, string>();
  return {
    mmkv,
    mmkvSet: vi.fn((key: string, serialised: string) => {
      mmkv.set(key, serialised);
    }),
    legacyStorage,
    readLegacy: vi.fn(async (key: string): Promise<string | null> => legacyStorage.get(key) ?? null),
    writeLegacy: vi.fn(),
    removeLegacy: vi.fn(),
    // The `subscribe` function the store last handed React. Renders are batched,
    // so counting them cannot tell one publish from several; a raw listener can.
    captured: { subscribe: null as null | ((listener: () => void) => () => void) },
  };
});

vi.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (key: string) => mmkv.get(key),
    set: mmkvSet,
    remove: (key: string) => {
      mmkv.delete(key);
    },
    clearAll: () => {
      mmkv.clear();
    },
  }),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: readLegacy, setItem: writeLegacy, removeItem: removeLegacy },
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const useSyncExternalStore: typeof actual.useSyncExternalStore = (subscribe, getSnapshot, getServerSnapshot) => {
    captured.subscribe = subscribe;
    return actual.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  };
  return { ...actual, useSyncExternalStore };
});

/** A cold start: fresh module state over whatever is in the two storages. */
async function launch() {
  vi.resetModules();
  const preference = await import('../climb-row-display-preference');
  const settings = await import('../../settings/hooks');
  return { ...preference, setSetting: settings.setSetting, resetAllSettings: settings.resetAllSettings };
}

/** A record already on the phone. Past the legacy copy unless a test says otherwise. */
function seedStored(overrides: ClimbRowOverrides, extra: Record<string, unknown> = { legacyMigrated: true }): void {
  mmkv.set(SETTINGS_KEY, JSON.stringify({ version: 1, overrides, ...extra }));
}

function persisted(): unknown {
  return JSON.parse(mmkv.get(SETTINGS_KEY) ?? 'null');
}

function deferred<Resolved>() {
  let resolve!: (resolved: Resolved) => void;
  const promise = new Promise<Resolved>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mmkv.clear();
  legacyStorage.clear();
  mmkvSet.mockClear();
  readLegacy.mockReset().mockImplementation(async (key: string) => legacyStorage.get(key) ?? null);
  writeLegacy.mockClear();
  removeLegacy.mockClear();
  captured.subscribe = null;
});
afterEach(cleanup);

describe('the first read', () => {
  it('knows the stored row before the first render, with nothing to wait for', async () => {
    seedStored({ thumbnail: false, playlistTags: true });
    const store = await launch();
    expect(store.getClimbRowDisplay()).toEqual({ ...DEFAULT_CLIMB_ROW_DISPLAY, thumbnail: false, playlistTags: true });

    const rendered: boolean[] = [];
    renderHook(() => {
      rendered.push(store.useClimbRowField('thumbnail'));
    });
    // One render, already right: no default-then-stored flash.
    expect(rendered).toEqual([false]);
    expect(readLegacy).not.toHaveBeenCalled();
  });

  it('is the default row on a fresh install', async () => {
    const store = await launch();
    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(mmkvSet).not.toHaveBeenCalled();
  });

  it.each([
    ['unparseable', '{broken'],
    ['from a newer version', JSON.stringify({ version: 2, overrides: { thumbnail: false } })],
    ['not a record', JSON.stringify('everything')],
  ])('is the default row when what is stored is %s', async (_label, serialised) => {
    mmkv.set(SETTINGS_KEY, serialised);
    const store = await launch();
    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
  });
});

describe('writes', () => {
  it('persists a switch and reads it back on the next launch', async () => {
    seedStored({});
    const store = await launch();
    store.setClimbRowField('thumbnail', false);
    expect(store.getClimbRowDisplay().thumbnail).toBe(false);
    expect(persisted()).toEqual({ version: 1, overrides: { thumbnail: false }, legacyMigrated: true });

    const relaunched = await launch();
    expect(relaunched.getClimbRowDisplay().thumbnail).toBe(false);
  });

  it('publishes a preset once and writes it once', async () => {
    seedStored({});
    const store = await launch();
    const { result } = renderHook(store.useClimbRowDisplay);
    const publishes = vi.fn();
    const unsubscribe = captured.subscribe?.(publishes);
    expect(unsubscribe).toBeTypeOf('function');
    mmkvSet.mockClear();

    act(() => store.applyClimbRowPreset('namesOnly'));

    // Seven fields changed; readers heard about it once, with the finished row.
    expect(publishes).toHaveBeenCalledTimes(1);
    expect(mmkvSet).toHaveBeenCalledTimes(1);
    expect(mmkvSet).toHaveBeenCalledWith(SETTINGS_KEY, expect.any(String));
    expect(matchClimbRowPreset(result.current)).toBe('namesOnly');
    unsubscribe?.();
  });

  it('neither publishes nor writes when nothing changes', async () => {
    seedStored({ thumbnail: false });
    const store = await launch();
    renderHook(store.useClimbRowDisplay);
    const publishes = vi.fn();
    const unsubscribe = captured.subscribe?.(publishes);
    mmkvSet.mockClear();

    act(() => store.setClimbRowField('thumbnail', false));

    expect(publishes).not.toHaveBeenCalled();
    expect(mmkvSet).not.toHaveBeenCalled();
    unsubscribe?.();
  });

  it('leaves the quick-actions choice alone when a preset is applied', async () => {
    seedStored({ quickActions: false });
    const store = await launch();
    store.applyClimbRowPreset('everything');
    expect(store.getClimbRowDisplay()).toMatchObject({ quickActions: false, playlistTags: true });
    store.applyClimbRowPreset('default');
    expect(store.getClimbRowDisplay()).toEqual({ ...DEFAULT_CLIMB_ROW_DISPLAY, quickActions: false });
    expect(persisted()).toEqual({ version: 1, overrides: { quickActions: false }, legacyMigrated: true });
  });

  it('remembers a hand-made mix behind a preset and brings it back', async () => {
    seedStored({});
    const store = await launch();
    const hasLastCustom = renderHook(store.useClimbRowHasLastCustom);
    act(() => store.setClimbRowField('setter', false));
    expect(hasLastCustom.result.current).toBe(false);

    act(() => store.applyClimbRowPreset('namesOnly'));
    expect(hasLastCustom.result.current).toBe(true);
    expect(matchClimbRowPreset(store.getClimbRowDisplay())).toBe('namesOnly');

    // Still there after a relaunch, while the preset is showing.
    const relaunched = await launch();
    const relaunchedHasLastCustom = renderHook(relaunched.useClimbRowHasLastCustom);
    expect(relaunchedHasLastCustom.result.current).toBe(true);

    act(() => relaunched.restoreLastCustomClimbRow());
    expect(relaunched.getClimbRowDisplay()).toEqual({ ...DEFAULT_CLIMB_ROW_DISPLAY, setter: false });
    expect(relaunchedHasLastCustom.result.current).toBe(false);
  });

  it('restoring with nothing remembered does nothing', async () => {
    seedStored({ thumbnail: false });
    const store = await launch();
    mmkvSet.mockClear();
    store.restoreLastCustomClimbRow();
    expect(store.getClimbRowDisplay().thumbnail).toBe(false);
    expect(mmkvSet).not.toHaveBeenCalled();
  });
});

describe('what a reader re-renders for', () => {
  it('keeps one row object until a switch changes', async () => {
    seedStored({});
    const store = await launch();
    const { result, rerender } = renderHook(store.useClimbRowDisplay);
    const first = result.current;

    rerender();
    expect(result.current).toBe(first);
    act(() => store.setSetting('theme', 'dark'));
    expect(result.current).toBe(first);
    // An explicit choice that equals the default is stored, but draws the same row.
    act(() => store.setClimbRowField('sends', true));
    expect(result.current).toBe(first);

    act(() => store.setClimbRowField('sends', false));
    expect(result.current).not.toBe(first);
    expect(result.current.sends).toBe(false);
    expect(store.getClimbRowDisplay()).toBe(result.current);
  });

  it('does not re-render a field reader on an unrelated settings write', async () => {
    seedStored({});
    const store = await launch();
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return store.useClimbRowField('thumbnail');
    });
    const publishes = vi.fn();
    const unsubscribe = captured.subscribe?.(publishes);

    act(() => {
      store.setSetting('theme', 'dark');
      // An object-valued key: the write that gives `useSetting` readers a new identity.
      store.setSetting('syncEnabledBoards', ['kilter:8:17']);
    });

    expect(publishes).not.toHaveBeenCalled();
    expect(renders).toBe(1);
    unsubscribe?.();
  });

  it('re-renders a field reader for its own switch only', async () => {
    seedStored({});
    const store = await launch();
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return store.useClimbRowField('thumbnail');
    });

    act(() => store.setClimbRowField('sends', false));
    expect(renders).toBe(1);

    act(() => store.setClimbRowField('thumbnail', false));
    expect(renders).toBe(2);
    expect(result.current).toBe(false);
  });
});

describe('the key changing from outside', () => {
  it('follows a reset of every setting', async () => {
    seedStored({ thumbnail: false, quickActions: false });
    const store = await launch();
    const { result } = renderHook(store.useClimbRowDisplay);
    expect(result.current.thumbnail).toBe(false);

    act(() => store.resetAllSettings());

    expect(result.current).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
  });

  it('writes over the reset record, not the one it remembered', async () => {
    seedStored({ thumbnail: false });
    const store = await launch();
    store.resetAllSettings();
    store.setClimbRowField('sends', false);
    expect(persisted()).toEqual({ version: 1, overrides: { sends: false } });
  });

  it('resetClimbRowDisplayForTests goes back to a fresh install', async () => {
    seedStored({});
    const store = await launch();
    store.setClimbRowField('setter', false);
    store.applyClimbRowPreset('everything');
    const hasLastCustom = renderHook(store.useClimbRowHasLastCustom);
    expect(hasLastCustom.result.current).toBe(true);

    act(() => store.resetClimbRowDisplayForTests());

    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(hasLastCustom.result.current).toBe(false);
    expect(persisted()).toEqual({ version: 1, overrides: {} });
  });
});

describe('the one-time copy of the two older choices', () => {
  it('copies explicit choices in, once, and leaves the old keys where they are', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    legacyStorage.set(LEGACY_QUICK_ACTIONS_KEY, 'false');
    const store = await launch();
    // Synchronous, so the defaults until the copy lands.
    expect(store.getClimbRowDisplay()).toMatchObject({ playlistTags: false, quickActions: true });

    await store.ensureClimbRowLegacyMigrated();

    expect(store.getClimbRowDisplay()).toMatchObject({ playlistTags: true, quickActions: false });
    expect(persisted()).toEqual({
      version: 1,
      overrides: { playlistTags: true, quickActions: false },
      legacyMigrated: true,
    });
    // An OTA rollback still reads these.
    expect([...legacyStorage]).toEqual([
      [LEGACY_TAGS_KEY, 'true'],
      [LEGACY_QUICK_ACTIONS_KEY, 'false'],
    ]);
    expect(writeLegacy).not.toHaveBeenCalled();
    expect(removeLegacy).not.toHaveBeenCalled();

    readLegacy.mockClear();
    await store.ensureClimbRowLegacyMigrated();
    const relaunched = await launch();
    await relaunched.ensureClimbRowLegacyMigrated();
    expect(readLegacy).not.toHaveBeenCalled();
    expect(relaunched.getClimbRowDisplay()).toMatchObject({ playlistTags: true, quickActions: false });
  });

  it('does not consult the old keys again after the copy, so a later change sticks', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    const store = await launch();
    await store.ensureClimbRowLegacyMigrated();
    store.setClimbRowField('playlistTags', false);

    const relaunched = await launch();
    await relaunched.ensureClimbRowLegacyMigrated();
    expect(relaunched.getClimbRowDisplay().playlistTags).toBe(false);
  });

  it('ignores keys that were never written, and still marks the copy done', async () => {
    const store = await launch();
    await store.ensureClimbRowLegacyMigrated();
    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(persisted()).toEqual({ version: 1, overrides: {}, legacyMigrated: true });
  });

  it.each([
    ['a string', '"true"'],
    ['null', 'null'],
    ['unparseable', '{broken'],
  ])('ignores a stored value that is %s', async (_label, serialised) => {
    legacyStorage.set(LEGACY_TAGS_KEY, serialised);
    legacyStorage.set(LEGACY_QUICK_ACTIONS_KEY, serialised);
    const store = await launch();
    await store.ensureClimbRowLegacyMigrated();
    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(persisted()).toEqual({ version: 1, overrides: {}, legacyMigrated: true });
  });

  it('lets a switch flipped while the copy is in flight win, and still copies the other', async () => {
    legacyStorage.set(LEGACY_QUICK_ACTIONS_KEY, 'false');
    const slowTagsRead = deferred<string | null>();
    readLegacy.mockImplementationOnce(() => slowTagsRead.promise);
    const store = await launch();

    const migration = store.ensureClimbRowLegacyMigrated();
    store.setClimbRowField('playlistTags', false);
    slowTagsRead.resolve('true');
    await migration;

    expect(store.getClimbRowDisplay()).toMatchObject({ playlistTags: false, quickActions: false });
  });

  it('lets a Default preset applied while the copy is in flight win', async () => {
    const slowTagsRead = deferred<string | null>();
    readLegacy.mockImplementationOnce(() => slowTagsRead.promise);
    const store = await launch();

    const migration = store.ensureClimbRowLegacyMigrated();
    store.applyClimbRowPreset('default');
    slowTagsRead.resolve('true');
    await migration;

    expect(store.getClimbRowDisplay().playlistTags).toBe(false);
  });

  it('shares one read between callers', async () => {
    const store = await launch();
    const first = store.ensureClimbRowLegacyMigrated();
    expect(store.ensureClimbRowLegacyMigrated()).toBe(first);
    await first;
    // Two keys, read once each.
    expect(readLegacy).toHaveBeenCalledTimes(2);
  });

  it('does not throw on a rejected read, keeps the defaults, and leaves the marker unset', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    readLegacy.mockRejectedValueOnce(new Error('locked storage'));
    const store = await launch();

    await expect(store.ensureClimbRowLegacyMigrated()).resolves.toBeUndefined();

    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(persisted()).toBeNull();
  });

  it('retries a rejected read on the next launch', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    readLegacy.mockRejectedValueOnce(new Error('locked storage'));
    const store = await launch();
    await store.ensureClimbRowLegacyMigrated();

    const relaunched = await launch();
    await relaunched.ensureClimbRowLegacyMigrated();

    expect(relaunched.getClimbRowDisplay().playlistTags).toBe(true);
    expect(persisted()).toMatchObject({ legacyMigrated: true });
  });

  it('retries a rejected read when the next reader mounts, without waiting for a relaunch', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    readLegacy.mockRejectedValueOnce(new Error('locked storage'));
    const store = await launch();
    await store.ensureClimbRowLegacyMigrated();
    expect(store.getClimbRowDisplay().playlistTags).toBe(false);

    const { result } = renderHook(() => store.useClimbRowField('playlistTags'));

    await waitFor(() => expect(result.current).toBe(true));
  });
});
