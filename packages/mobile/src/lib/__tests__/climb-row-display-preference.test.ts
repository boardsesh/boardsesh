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
    writeLegacy: vi.fn(async (key: string, serialised: string): Promise<void> => {
      legacyStorage.set(key, serialised);
    }),
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

/** Both old keys read on an earlier launch, and found empty. */
const KEYS_READ_EMPTY = { legacy: { playlistTags: null, quickActions: null } };

/** A record already on the phone. Its old keys were read and held nothing, unless a test says otherwise. */
function seedStored(overrides: ClimbRowOverrides, extra: Record<string, unknown> = KEYS_READ_EMPTY): void {
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

/** Lets every read and write of the old keys that is already queued run to the end. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  mmkv.clear();
  legacyStorage.clear();
  mmkvSet.mockClear();
  readLegacy.mockReset().mockImplementation(async (key: string) => legacyStorage.get(key) ?? null);
  writeLegacy.mockReset().mockImplementation(async (key: string, serialised: string) => {
    legacyStorage.set(key, serialised);
  });
  removeLegacy.mockClear();
  captured.subscribe = null;
});
afterEach(async () => {
  cleanup();
  await settle();
});

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
    expect(persisted()).toEqual({ version: 1, overrides: { thumbnail: false }, ...KEYS_READ_EMPTY });

    const relaunched = await launch();
    expect(relaunched.getClimbRowDisplay().thumbnail).toBe(false);
  });

  it('publishes a preset once and writes it once', async () => {
    // The tags' old key already holds what this preset sets, so copying the
    // choice to it leaves the record as it is.
    legacyStorage.set(LEGACY_TAGS_KEY, 'false');
    seedStored({}, { legacy: { playlistTags: false, quickActions: null } });
    const store = await launch();
    const { result } = renderHook(store.useClimbRowDisplay);
    const publishes = vi.fn();
    const unsubscribe = captured.subscribe?.(publishes);
    expect(unsubscribe).toBeTypeOf('function');
    await settle();
    mmkvSet.mockClear();

    act(() => store.applyClimbRowPreset('namesOnly'));

    // Seven fields changed; readers heard about it once, with the finished row.
    expect(publishes).toHaveBeenCalledTimes(1);
    expect(mmkvSet).toHaveBeenCalledTimes(1);
    expect(mmkvSet).toHaveBeenCalledWith(SETTINGS_KEY, expect.any(String));
    expect(matchClimbRowPreset(result.current)).toBe('namesOnly');

    await settle();
    expect(publishes).toHaveBeenCalledTimes(1);
    expect(mmkvSet).toHaveBeenCalledTimes(1);
    unsubscribe?.();
  });

  it('neither publishes nor writes when nothing changes', async () => {
    seedStored({ thumbnail: false });
    const store = await launch();
    renderHook(store.useClimbRowDisplay);
    const publishes = vi.fn();
    const unsubscribe = captured.subscribe?.(publishes);
    await settle();
    mmkvSet.mockClear();

    act(() => store.setClimbRowField('thumbnail', false));
    await settle();

    expect(publishes).not.toHaveBeenCalled();
    expect(mmkvSet).not.toHaveBeenCalled();
    expect(writeLegacy).not.toHaveBeenCalled();
    unsubscribe?.();
  });

  it('leaves the quick-actions choice alone when a preset is applied', async () => {
    seedStored({ quickActions: false });
    const store = await launch();
    store.applyClimbRowPreset('everything');
    expect(store.getClimbRowDisplay()).toMatchObject({ quickActions: false, playlistTags: true });
    store.applyClimbRowPreset('default');
    expect(store.getClimbRowDisplay()).toEqual({ ...DEFAULT_CLIMB_ROW_DISPLAY, quickActions: false });
    expect(persisted()).toMatchObject({ overrides: { quickActions: false } });
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
    await settle();

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
    await settle();
    expect(store.getClimbRowDisplay().thumbnail).toBe(false);
    expect(mmkvSet).not.toHaveBeenCalled();
    expect(writeLegacy).not.toHaveBeenCalled();
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
    await settle();

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

describe('the record changing underneath the store', () => {
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
    expect(persisted()).toEqual({ version: 1, overrides: { sends: false }, ...KEYS_READ_EMPTY });
  });

  // The old keys are never deleted, so after a reset they still hold the choices
  // made before it. Forgetting that they had been read would bring them back.
  it('stays on the defaults after a reset, with choices still sitting in the old keys', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    legacyStorage.set(LEGACY_QUICK_ACTIONS_KEY, 'false');
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    expect(store.getClimbRowDisplay()).toMatchObject({ playlistTags: true, quickActions: false });

    store.resetAllSettings();

    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(persisted()).toEqual({ version: 1, overrides: {}, legacy: { playlistTags: true, quickActions: false } });

    // A reader mounting later this launch does not bring them back...
    const { result } = renderHook(store.useClimbRowDisplay);
    await settle();
    expect(result.current).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);

    // ...and neither does the next launch's read of the old keys.
    const relaunched = await launch();
    await relaunched.ensureClimbRowLegacySynced();
    expect(readLegacy).toHaveBeenCalledWith(LEGACY_TAGS_KEY);
    expect(relaunched.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
  });

  it('keeps what it knows of the old keys through a second reset in a row', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    const store = await launch();
    await store.ensureClimbRowLegacySynced();

    store.resetAllSettings();
    store.resetAllSettings();

    expect(persisted()).toEqual({ version: 1, overrides: {}, legacy: { playlistTags: true, quickActions: null } });
  });

  // The read at import can come back empty while a record exists. Nothing may be
  // built on that empty read and written over the real record.
  it('applies a switch on top of a record the import-time read missed', async () => {
    const store = await launch();
    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    seedStored({ thumbnail: false, quickActions: false }, { legacy: { playlistTags: null, quickActions: false } });

    store.setClimbRowField('sends', false);

    expect(persisted()).toEqual({
      version: 1,
      overrides: { thumbnail: false, quickActions: false, sends: false },
      legacy: { playlistTags: null, quickActions: false },
    });
    expect(store.getClimbRowDisplay()).toEqual({
      ...DEFAULT_CLIMB_ROW_DISPLAY,
      thumbnail: false,
      quickActions: false,
      sends: false,
    });
  });

  it('reconciles the old keys on top of a record the import-time read missed', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    const slowTagsRead = deferred<string | null>();
    readLegacy.mockImplementationOnce(() => slowTagsRead.promise);
    const store = await launch();
    const sync = store.ensureClimbRowLegacySynced();
    seedStored({ thumbnail: false, playlistTags: false }, { legacy: { playlistTags: true, quickActions: null } });

    slowTagsRead.resolve('true');
    await sync;

    // The key still holds what the real record says it held: nothing comes in.
    expect(persisted()).toEqual({
      version: 1,
      overrides: { thumbnail: false, playlistTags: false },
      legacy: { playlistTags: true, quickActions: null },
    });
    expect(store.getClimbRowDisplay()).toMatchObject({ thumbnail: false, playlistTags: false });
  });

  // The other half of looking first: an empty read is not a reset. Only the
  // settings store's own signal is, and never the one our own write causes.
  it('keeps a switch for the session when its write is lost, and builds the next one on it', async () => {
    const store = await launch();
    mmkvSet.mockImplementationOnce(() => {});

    store.setClimbRowField('thumbnail', false);
    expect(persisted()).toBeNull();
    expect(store.getClimbRowDisplay().thumbnail).toBe(false);

    store.setClimbRowField('sends', false);
    expect(store.getClimbRowDisplay()).toMatchObject({ thumbnail: false, sends: false });
    expect(persisted()).toEqual({ version: 1, overrides: { thumbnail: false, sends: false } });
  });

  it('applies a preset on top of a record the import-time read missed, keeping its quick-actions choice', async () => {
    const store = await launch();
    seedStored({ quickActions: false, setter: false });

    store.applyClimbRowPreset('everything');

    expect(store.getClimbRowDisplay()).toMatchObject({ quickActions: false, setter: true, playlistTags: true });
    expect(persisted()).toMatchObject({ lastCustom: { setter: false } });
  });

  it('resetClimbRowDisplayForTests goes back to a fresh install', async () => {
    seedStored({});
    const store = await launch();
    store.setClimbRowField('setter', false);
    store.applyClimbRowPreset('everything');
    const hasLastCustom = renderHook(store.useClimbRowHasLastCustom);
    expect(hasLastCustom.result.current).toBe(true);

    act(() => store.resetClimbRowDisplayForTests());
    // Nothing still in flight from before the reset lands after it.
    mmkvSet.mockClear();
    await settle();

    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(hasLastCustom.result.current).toBe(false);
    expect(persisted()).toEqual({ version: 1, overrides: {} });
    expect(mmkvSet).not.toHaveBeenCalled();
  });
});

describe('reading the two old keys at launch', () => {
  it('brings explicit choices in on the first launch and leaves the old keys as they are', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    legacyStorage.set(LEGACY_QUICK_ACTIONS_KEY, 'false');
    const store = await launch();
    // Synchronous, so the defaults until the read lands.
    expect(store.getClimbRowDisplay()).toMatchObject({ playlistTags: false, quickActions: true });

    await store.ensureClimbRowLegacySynced();

    expect(store.getClimbRowDisplay()).toMatchObject({ playlistTags: true, quickActions: false });
    expect(persisted()).toEqual({
      version: 1,
      overrides: { playlistTags: true, quickActions: false },
      legacy: { playlistTags: true, quickActions: false },
    });
    await settle();
    expect([...legacyStorage]).toEqual([
      [LEGACY_TAGS_KEY, 'true'],
      [LEGACY_QUICK_ACTIONS_KEY, 'false'],
    ]);
    expect(writeLegacy).not.toHaveBeenCalled();
    expect(removeLegacy).not.toHaveBeenCalled();
  });

  it('reads them once per launch, and again on the next, changing nothing while they hold the same', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    await store.ensureClimbRowLegacySynced();
    renderHook(store.useClimbRowDisplay);
    await settle();
    // Two keys, read once each.
    expect(readLegacy).toHaveBeenCalledTimes(2);

    mmkvSet.mockClear();
    const relaunched = await launch();
    await relaunched.ensureClimbRowLegacySynced();

    expect(readLegacy).toHaveBeenCalledTimes(4);
    expect(mmkvSet).not.toHaveBeenCalled();
    expect(relaunched.getClimbRowDisplay().playlistTags).toBe(true);
  });

  it('records keys that were never written as empty, and stays on the defaults', async () => {
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(persisted()).toEqual({ version: 1, overrides: {}, ...KEYS_READ_EMPTY });
  });

  it.each([
    ['a string', '"true"'],
    ['null', 'null'],
    ['unparseable', '{broken'],
  ])('treats a stored value that is %s as no choice', async (_label, serialised) => {
    legacyStorage.set(LEGACY_TAGS_KEY, serialised);
    legacyStorage.set(LEGACY_QUICK_ACTIONS_KEY, serialised);
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(persisted()).toEqual({ version: 1, overrides: {}, ...KEYS_READ_EMPTY });
  });

  it('lets a switch flipped while the read is in flight win, and still brings the other in', async () => {
    legacyStorage.set(LEGACY_QUICK_ACTIONS_KEY, 'false');
    const slowTagsRead = deferred<string | null>();
    readLegacy.mockImplementationOnce(() => slowTagsRead.promise);
    const store = await launch();

    const sync = store.ensureClimbRowLegacySynced();
    store.setClimbRowField('playlistTags', false);
    slowTagsRead.resolve('true');
    await sync;

    expect(store.getClimbRowDisplay()).toMatchObject({ playlistTags: false, quickActions: false });
  });

  it('lets a Default preset applied while the read is in flight win', async () => {
    const slowTagsRead = deferred<string | null>();
    readLegacy.mockImplementationOnce(() => slowTagsRead.promise);
    const store = await launch();

    const sync = store.ensureClimbRowLegacySynced();
    store.applyClimbRowPreset('default');
    slowTagsRead.resolve('true');
    await sync;

    expect(store.getClimbRowDisplay().playlistTags).toBe(false);
  });

  it('shares one read between callers', async () => {
    const store = await launch();
    const first = store.ensureClimbRowLegacySynced();
    expect(store.ensureClimbRowLegacySynced()).toBe(first);
    await first;
    expect(readLegacy).toHaveBeenCalledTimes(2);
  });

  it('does not throw on a rejected read, keeps the defaults, and writes nothing', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    readLegacy.mockRejectedValueOnce(new Error('locked storage'));
    const store = await launch();

    await expect(store.ensureClimbRowLegacySynced()).resolves.toBeUndefined();

    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(persisted()).toBeNull();
  });

  it('retries a rejected read on the next launch', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    readLegacy.mockRejectedValueOnce(new Error('locked storage'));
    const store = await launch();
    await store.ensureClimbRowLegacySynced();

    const relaunched = await launch();
    await relaunched.ensureClimbRowLegacySynced();

    expect(relaunched.getClimbRowDisplay().playlistTags).toBe(true);
    expect(persisted()).toMatchObject({ legacy: { playlistTags: true, quickActions: null } });
  });

  it('retries a rejected read when the next reader mounts, without waiting for a relaunch', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    readLegacy.mockRejectedValueOnce(new Error('locked storage'));
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    expect(store.getClimbRowDisplay().playlistTags).toBe(false);

    const { result } = renderHook(() => store.useClimbRowField('playlistTags'));

    await waitFor(() => expect(result.current).toBe(true));
  });
});

// A build from before this record reads only the old keys. After an OTA rollback
// it must find the choices made here, not the ones from before the upgrade.
describe('rolling back to a build that only knows the old keys', () => {
  it('finds both switches as the climber left them here', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    expect(store.getClimbRowDisplay()).toMatchObject({ playlistTags: true, quickActions: true });

    store.setClimbRowField('playlistTags', false);
    store.setClimbRowField('quickActions', false);
    await settle();

    expect(JSON.parse(legacyStorage.get(LEGACY_TAGS_KEY) ?? 'null')).toBe(false);
    expect(JSON.parse(legacyStorage.get(LEGACY_QUICK_ACTIONS_KEY) ?? 'null')).toBe(false);
    // And this build knows the keys hold them, so its next launch brings nothing in.
    expect(persisted()).toEqual({
      version: 1,
      overrides: { playlistTags: false, quickActions: false },
      legacy: { playlistTags: false, quickActions: false },
    });
  });

  it('finds the tags as a preset or a restored mix left them, and its own quick-actions choice untouched', async () => {
    legacyStorage.set(LEGACY_QUICK_ACTIONS_KEY, 'false');
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    store.setClimbRowField('setter', false);
    writeLegacy.mockClear();

    store.applyClimbRowPreset('everything');
    await settle();
    expect(JSON.parse(legacyStorage.get(LEGACY_TAGS_KEY) ?? 'null')).toBe(true);

    store.restoreLastCustomClimbRow();
    await settle();
    expect(JSON.parse(legacyStorage.get(LEGACY_TAGS_KEY) ?? 'null')).toBe(false);

    store.applyClimbRowPreset('default');
    await settle();
    expect(JSON.parse(legacyStorage.get(LEGACY_TAGS_KEY) ?? 'null')).toBe(false);

    expect(writeLegacy.mock.calls.map(([key]) => key)).toEqual([LEGACY_TAGS_KEY, LEGACY_TAGS_KEY, LEGACY_TAGS_KEY]);
    expect(legacyStorage.get(LEGACY_QUICK_ACTIONS_KEY)).toBe('false');
  });

  it('writes nothing to the old keys for a switch that never had one', async () => {
    seedStored({});
    const store = await launch();
    store.setClimbRowField('thumbnail', false);
    store.setClimbRowField('sends', false);
    await settle();
    expect(writeLegacy).not.toHaveBeenCalled();
  });

  it('writes quick flips in order, so the key ends on the last one even when a write is slow', async () => {
    seedStored({});
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    const slowFirstWrite = deferred<void>();
    writeLegacy.mockImplementationOnce(async (key: string, serialised: string) => {
      await slowFirstWrite.promise;
      legacyStorage.set(key, serialised);
    });

    store.setClimbRowField('playlistTags', true);
    store.setClimbRowField('playlistTags', false);
    store.setClimbRowField('playlistTags', true);
    await settle();
    // The second and third wait behind the first.
    expect(writeLegacy).toHaveBeenCalledTimes(1);

    slowFirstWrite.resolve();
    await settle();

    expect(writeLegacy.mock.calls.map(([, serialised]) => serialised)).toEqual(['true', 'false', 'true']);
    expect(legacyStorage.get(LEGACY_TAGS_KEY)).toBe('true');
    expect(persisted()).toMatchObject({ overrides: { playlistTags: true }, legacy: { playlistTags: true } });
  });

  it('keeps the choice here when the write to the old key fails, and carries on with later ones', async () => {
    seedStored({});
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    writeLegacy.mockRejectedValueOnce(new Error('disk full'));

    store.setClimbRowField('quickActions', false);
    await settle();
    expect(store.getClimbRowDisplay().quickActions).toBe(false);
    // Not written, so not recorded as written.
    expect(persisted()).toEqual({ version: 1, overrides: { quickActions: false }, ...KEYS_READ_EMPTY });

    store.setClimbRowField('playlistTags', true);
    await settle();
    expect(legacyStorage.get(LEGACY_TAGS_KEY)).toBe('true');

    // The key still holds what it held, so the next launch leaves the choice alone.
    const relaunched = await launch();
    await relaunched.ensureClimbRowLegacySynced();
    expect(relaunched.getClimbRowDisplay()).toMatchObject({ quickActions: false, playlistTags: true });
  });
});

// A tester opens a preview of this build, then goes back to a build that only
// knows the old keys and changes a switch there. When this build runs again it
// has to notice, although it has read those keys before.
describe('coming back from a build that only knows the old keys', () => {
  it('brings in a switch that build turned off in a key this one had read as empty', async () => {
    const preview = await launch();
    await preview.ensureClimbRowLegacySynced();
    expect(preview.getClimbRowDisplay().quickActions).toBe(true);
    expect(persisted()).toEqual({ version: 1, overrides: {}, ...KEYS_READ_EMPTY });

    legacyStorage.set(LEGACY_QUICK_ACTIONS_KEY, 'false');

    const shipped = await launch();
    expect(shipped.getClimbRowDisplay().quickActions).toBe(true);
    await shipped.ensureClimbRowLegacySynced();
    expect(shipped.getClimbRowDisplay().quickActions).toBe(false);
    expect(persisted()).toEqual({
      version: 1,
      overrides: { quickActions: false },
      legacy: { playlistTags: null, quickActions: false },
    });
  });

  it('lets that build’s later choice replace one made here earlier', async () => {
    const preview = await launch();
    await preview.ensureClimbRowLegacySynced();
    preview.setClimbRowField('playlistTags', true);
    await settle();
    expect(legacyStorage.get(LEGACY_TAGS_KEY)).toBe('true');

    legacyStorage.set(LEGACY_TAGS_KEY, 'false');

    const shipped = await launch();
    await shipped.ensureClimbRowLegacySynced();
    expect(shipped.getClimbRowDisplay().playlistTags).toBe(false);
  });

  it('still prefers a switch flipped here this launch, before the read lands', async () => {
    seedStored({ quickActions: true }, { legacy: { playlistTags: null, quickActions: true } });
    legacyStorage.set(LEGACY_QUICK_ACTIONS_KEY, 'false');
    const slowTagsRead = deferred<string | null>();
    readLegacy.mockImplementationOnce(() => slowTagsRead.promise);
    const store = await launch();

    const sync = store.ensureClimbRowLegacySynced();
    store.setClimbRowField('quickActions', true);
    slowTagsRead.resolve(null);
    await sync;
    await settle();

    expect(store.getClimbRowDisplay().quickActions).toBe(true);
    expect(legacyStorage.get(LEGACY_QUICK_ACTIONS_KEY)).toBe('true');
  });
});

// The read of an old key can fail for a whole launch, and so can the write that
// copies a choice to it. A choice made here must outlast both.
describe('a choice made before the old key could be read', () => {
  it('is on file at once, marked as decided', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    readLegacy.mockRejectedValue(new Error('locked storage'));
    writeLegacy.mockRejectedValue(new Error('locked storage'));
    const store = await launch();
    await store.ensureClimbRowLegacySynced();

    // Default writes no override; the baseline is all that records the choice.
    store.applyClimbRowPreset('default');

    expect(persisted()).toEqual({ version: 1, overrides: {}, legacy: { playlistTags: 'decided' } });
  });

  it('is not replaced by the old key on the next launch, although the write to that key failed', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    legacyStorage.set(LEGACY_QUICK_ACTIONS_KEY, 'false');
    readLegacy.mockRejectedValue(new Error('locked storage'));
    writeLegacy.mockRejectedValue(new Error('locked storage'));
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    store.applyClimbRowPreset('default');
    store.setClimbRowField('quickActions', true);
    await settle();
    expect(legacyStorage.get(LEGACY_TAGS_KEY)).toBe('true');
    expect(legacyStorage.get(LEGACY_QUICK_ACTIONS_KEY)).toBe('false');

    readLegacy.mockReset().mockImplementation(async (key: string) => legacyStorage.get(key) ?? null);
    const relaunched = await launch();
    await relaunched.ensureClimbRowLegacySynced();

    expect(relaunched.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    // The keys are known now, so a later change by an older build still shows.
    expect(persisted()).toEqual({
      version: 1,
      overrides: { quickActions: true },
      legacy: { playlistTags: true, quickActions: false },
    });
  });

  it('is not replaced when the read lands later the same launch and the write then fails', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    const slowTagsRead = deferred<string | null>();
    readLegacy.mockImplementationOnce(() => slowTagsRead.promise);
    writeLegacy.mockRejectedValue(new Error('disk full'));
    const store = await launch();

    const sync = store.ensureClimbRowLegacySynced();
    store.setClimbRowField('playlistTags', false);
    slowTagsRead.resolve('true');
    await sync;
    await settle();
    expect(store.getClimbRowDisplay().playlistTags).toBe(false);

    const relaunched = await launch();
    await relaunched.ensureClimbRowLegacySynced();
    expect(relaunched.getClimbRowDisplay().playlistTags).toBe(false);
  });
});
