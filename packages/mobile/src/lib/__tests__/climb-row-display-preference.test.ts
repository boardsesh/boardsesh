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
    removeLegacy: vi.fn(async (key: string): Promise<void> => {
      legacyStorage.delete(key);
    }),
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

/** An old key as a build that only knows the old keys would read it. */
function oldKey(key: string): unknown {
  return JSON.parse(legacyStorage.get(key) ?? 'null');
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

/** What the settings store does when its file cannot be written: it throws. */
function failedWrite(): never {
  throw new Error('mmkv write failed');
}

/** A write to an old key that reaches the disk and is never heard from again. */
function landsWithoutAnswering(answer: Promise<void>) {
  return async (key: string, serialised: string): Promise<void> => {
    legacyStorage.set(key, serialised);
    await answer;
  };
}

beforeEach(() => {
  mmkv.clear();
  legacyStorage.clear();
  mmkvSet.mockReset().mockImplementation((key: string, serialised: string) => {
    mmkv.set(key, serialised);
  });
  readLegacy.mockReset().mockImplementation(async (key: string) => legacyStorage.get(key) ?? null);
  writeLegacy.mockReset().mockImplementation(async (key: string, serialised: string) => {
    legacyStorage.set(key, serialised);
  });
  removeLegacy.mockReset().mockImplementation(async (key: string) => {
    legacyStorage.delete(key);
  });
  captured.subscribe = null;
});
afterEach(async () => {
  cleanup();
  await settle();
});

describe('the first read', () => {
  it('resets unsaved choices even when no record has ever persisted', async () => {
    const store = await launch();
    mmkvSet.mockImplementation(() => {
      throw new Error('Storage quota exceeded');
    });
    await store.ensureClimbRowLegacySynced();
    store.setClimbRowField('thumbnail', false);
    store.setClimbRowField('playlistTags', true);
    store.applyClimbRowPreset('textOnly');
    expect(store.getClimbRowDisplay().thumbnail).toBe(false);
    expect(persisted()).toBeNull();

    // An unrelated settings signal must still preserve the unsaved mix.
    mmkvSet.mockImplementation((key: string, serialised: string) => {
      mmkv.set(key, serialised);
    });
    store.setSetting('theme', 'dark');
    expect(store.getClimbRowDisplay().thumbnail).toBe(false);

    store.resetAllSettings();
    await settle();
    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(false);
    const { result } = renderHook(store.useClimbRowHasLastCustom);
    expect(result.current).toBe(false);
    expect((await launch()).getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
  });
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
    seedStored({});
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

  it('tells its reader when a reset drops the remembered mix and the row itself does not move', async () => {
    seedStored({});
    const store = await launch();
    const hasLastCustom = renderHook(store.useClimbRowHasLastCustom);
    act(() => store.setClimbRowField('setter', false));
    // Default is showing, with the hand-made mix remembered behind it.
    act(() => store.applyClimbRowPreset('default'));
    expect(hasLastCustom.result.current).toBe(true);
    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);

    act(() => store.resetAllSettings());

    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(hasLastCustom.result.current).toBe(false);
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

  // Every mounted row subscribes. What this build knows or owes about the old
  // keys changes behind every choice and at every launch; none of it is drawn.
  it('tells no reader when only what is known or owed about the old keys changes', async () => {
    legacyStorage.set(LEGACY_QUICK_ACTIONS_KEY, 'true');
    const store = await launch();
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return store.useClimbRowDisplay();
    });
    const publishes = vi.fn();
    const unsubscribe = captured.subscribe?.(publishes);

    // The launch read: two baselines recorded, and an override equal to the default.
    await store.ensureClimbRowLegacySynced();
    expect(persisted()).toEqual({
      version: 1,
      overrides: { quickActions: true },
      legacy: { playlistTags: null, quickActions: true },
    });
    expect(publishes).not.toHaveBeenCalled();

    // A choice: heard once. Its write to the old key landing: a pending value
    // cleared and a baseline moved, heard by no one.
    act(() => store.setClimbRowField('playlistTags', true));
    expect(publishes).toHaveBeenCalledTimes(1);
    expect(persisted()).toMatchObject({ legacyPending: { playlistTags: true } });
    mmkvSet.mockClear();
    await act(settle);

    expect(mmkvSet).toHaveBeenCalledTimes(1);
    expect(persisted()).toEqual({
      version: 1,
      overrides: { quickActions: true, playlistTags: true },
      legacy: { playlistTags: true, quickActions: true },
    });
    expect(publishes).toHaveBeenCalledTimes(1);
    expect(renders).toBe(2);
    unsubscribe?.();
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

  it('writes the next switch over the reset record, not the one it remembered', async () => {
    seedStored({ thumbnail: false });
    const store = await launch();
    store.resetAllSettings();
    store.setClimbRowField('sends', false);
    expect(persisted()).toMatchObject({ overrides: { sends: false } });
    expect(store.getClimbRowDisplay()).toEqual({ ...DEFAULT_CLIMB_ROW_DISPLAY, sends: false });
  });

  // A reset is a choice like any other. The old keys are never deleted, so
  // without owing them the defaults they would bring the old choices back at the
  // next launch, and a build that only knows the old keys would never see it.
  it('makes a reset hold: on this launch, on the next, and for a build that only knows the old keys', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    legacyStorage.set(LEGACY_QUICK_ACTIONS_KEY, 'false');
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    expect(store.getClimbRowDisplay()).toMatchObject({ playlistTags: true, quickActions: false });

    store.resetAllSettings();

    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    // Written back at once, owing each old key its default.
    expect(persisted()).toEqual({
      version: 1,
      overrides: {},
      legacy: { playlistTags: true, quickActions: false },
      legacyPending: { playlistTags: false, quickActions: true },
    });

    const { result } = renderHook(store.useClimbRowDisplay);
    await settle();
    expect(result.current).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(false);
    expect(oldKey(LEGACY_QUICK_ACTIONS_KEY)).toBe(true);
    expect(persisted()).toEqual({ version: 1, overrides: {}, legacy: { playlistTags: false, quickActions: true } });

    const relaunched = await launch();
    await relaunched.ensureClimbRowLegacySynced();
    expect(relaunched.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
  });

  it('makes a reset hold when the writes to the old keys fail and only the next launch can make them', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    writeLegacy.mockRejectedValue(new Error('disk full'));

    store.resetAllSettings();
    await settle();
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(true);

    writeLegacy.mockReset().mockImplementation(async (key: string, serialised: string) => {
      legacyStorage.set(key, serialised);
    });
    const relaunched = await launch();
    await relaunched.ensureClimbRowLegacySynced();
    expect(relaunched.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    await settle();
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(false);
  });

  it('makes a reset hold against the first read of the old keys, still in flight', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    legacyStorage.set(LEGACY_QUICK_ACTIONS_KEY, 'false');
    // On the phone, but its old keys have never been read.
    seedStored({ thumbnail: false }, {});
    const slowTagsRead = deferred<string | null>();
    readLegacy.mockImplementationOnce(() => slowTagsRead.promise);
    const store = await launch();
    const sync = store.ensureClimbRowLegacySynced();

    store.resetAllSettings();
    slowTagsRead.resolve('true');
    await sync;

    // The read found choices in both keys; the reset came after them.
    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    await settle();
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(false);
    expect(oldKey(LEGACY_QUICK_ACTIONS_KEY)).toBe(true);
    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
  });

  it('makes a reset hold against a read in flight that finds a key an older build changed since', async () => {
    // The baseline says the key shows the default. It is out of date.
    seedStored({}, { legacy: { playlistTags: false, quickActions: true } });
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    const slowTagsRead = deferred<string | null>();
    readLegacy.mockImplementationOnce(() => slowTagsRead.promise);
    const store = await launch();
    const sync = store.ensureClimbRowLegacySynced();

    store.resetAllSettings();
    slowTagsRead.resolve('true');
    await sync;
    await settle();

    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(false);
  });

  it('carries a second reset in a row', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    const store = await launch();
    await store.ensureClimbRowLegacySynced();

    store.resetAllSettings();
    store.resetAllSettings();

    expect(persisted()).toEqual({
      version: 1,
      overrides: {},
      legacy: { playlistTags: true, quickActions: null },
      legacyPending: { playlistTags: false, quickActions: true },
    });
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
    legacyStorage.set(LEGACY_TAGS_KEY, 'false');
    const slowTagsRead = deferred<string | null>();
    readLegacy.mockImplementationOnce(() => slowTagsRead.promise);
    const store = await launch();
    const sync = store.ensureClimbRowLegacySynced();
    seedStored({ thumbnail: false, playlistTags: false }, { legacy: { playlistTags: false, quickActions: null } });

    slowTagsRead.resolve('false');
    await sync;

    // The key still holds what the real record says it held: nothing comes in.
    expect(persisted()).toEqual({
      version: 1,
      overrides: { thumbnail: false, playlistTags: false },
      legacy: { playlistTags: false, quickActions: null },
    });
    expect(store.getClimbRowDisplay()).toMatchObject({ thumbnail: false, playlistTags: false });
  });

  it('applies a preset on top of a record the import-time read missed, keeping its quick-actions choice', async () => {
    const store = await launch();
    seedStored({ quickActions: false, setter: false });

    store.applyClimbRowPreset('everything');

    expect(store.getClimbRowDisplay()).toMatchObject({ quickActions: false, setter: true, playlistTags: true });
    expect(persisted()).toMatchObject({ lastCustom: { setter: false } });
  });

  it('restores the remembered mix of a record the import-time read missed', async () => {
    const store = await launch();
    // Names only showing, with a remembered mix behind it.
    seedStored(namesOnlyOverrides(), { ...KEYS_READ_EMPTY, lastCustom: { ...presetFieldsOn(), setter: false } });

    store.restoreLastCustomClimbRow();

    expect(store.getClimbRowDisplay()).toEqual({ ...DEFAULT_CLIMB_ROW_DISPLAY, setter: false });
  });
});

/** The Default preset's content values, as a remembered mix is stored. */
function presetFieldsOn() {
  return {
    thumbnail: true,
    communityGrade: true,
    sends: true,
    rating: true,
    setter: true,
    sentMark: true,
    playlistTags: false,
  };
}

function namesOnlyOverrides() {
  return {
    thumbnail: false,
    communityGrade: false,
    sends: false,
    rating: false,
    setter: false,
    sentMark: true,
    playlistTags: false,
  };
}

// A record write can be lost. Memory is then ahead of the phone, and nothing but
// a real reset may take that away.
describe('a write of the record that did not stick', () => {
  it('keeps the switch through an unrelated settings write, on a fresh install', async () => {
    const store = await launch();
    mmkvSet.mockImplementationOnce(failedWrite);

    store.setClimbRowField('thumbnail', false);
    expect(persisted()).toBeNull();
    store.setSetting('theme', 'dark');

    expect(store.getClimbRowDisplay().thumbnail).toBe(false);
  });

  it('keeps the switch through an unrelated settings write, with an older record on the phone', async () => {
    seedStored({ sends: false });
    const store = await launch();
    mmkvSet.mockImplementationOnce(failedWrite);

    store.setClimbRowField('thumbnail', false);
    expect(persisted()).toEqual({ version: 1, overrides: { sends: false }, ...KEYS_READ_EMPTY });
    store.setSetting('theme', 'dark');

    expect(store.getClimbRowDisplay()).toMatchObject({ thumbnail: false, sends: false });
  });

  it('carries the lost switch with the next one', async () => {
    seedStored({ sends: false });
    const store = await launch();
    mmkvSet.mockImplementationOnce(failedWrite);
    store.setClimbRowField('thumbnail', false);

    store.setClimbRowField('rating', false);

    expect(store.getClimbRowDisplay()).toMatchObject({ thumbnail: false, sends: false, rating: false });
    expect(persisted()).toEqual({
      version: 1,
      overrides: { sends: false, thumbnail: false, rating: false },
      ...KEYS_READ_EMPTY,
    });
  });

  it('writes the lost switch when the same choice is made again, though memory already has it', async () => {
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    mmkvSet.mockImplementationOnce(failedWrite);
    store.setClimbRowField('thumbnail', false);
    expect(persisted()).toEqual({ version: 1, overrides: {}, ...KEYS_READ_EMPTY });

    store.setClimbRowField('thumbnail', false);

    expect(persisted()).toEqual({ version: 1, overrides: { thumbnail: false }, ...KEYS_READ_EMPTY });
  });

  it('still takes a reset afterwards', async () => {
    seedStored({ sends: false });
    const store = await launch();
    mmkvSet.mockImplementationOnce(failedWrite);
    store.setClimbRowField('thumbnail', false);

    store.resetAllSettings();

    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
  });

  it('does not throw into the handler, and what is owed to the old key still goes out', async () => {
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    // The file could not be opened: every write fails for the rest of the launch.
    mmkvSet.mockImplementation(failedWrite);

    expect(() => store.setClimbRowField('quickActions', false)).not.toThrow();
    await settle();

    expect(store.getClimbRowDisplay().quickActions).toBe(false);
    expect(oldKey(LEGACY_QUICK_ACTIONS_KEY)).toBe(false);
  });

  it('reads the old keys once at launch, however many readers mount afterwards', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    const store = await launch();
    mmkvSet.mockImplementation(failedWrite);

    await expect(store.ensureClimbRowLegacySynced()).resolves.toBeUndefined();
    expect(store.getClimbRowDisplay().playlistTags).toBe(true);
    renderHook(() => store.useClimbRowField('thumbnail'));
    renderHook(() => store.useClimbRowField('thumbnail'));
    await settle();

    expect(readLegacy).toHaveBeenCalledTimes(2);
  });

  it('carries an import whose write was lost with the next choice', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    const store = await launch();
    mmkvSet.mockImplementationOnce(failedWrite);
    await store.ensureClimbRowLegacySynced();
    expect(persisted()).toBeNull();

    store.setClimbRowField('quickActions', false);
    await settle();

    expect(persisted()).toMatchObject({ overrides: { playlistTags: true, quickActions: false } });
    expect(oldKey(LEGACY_QUICK_ACTIONS_KEY)).toBe(false);
  });
});

describe('resetClimbRowDisplayForTests', () => {
  it('goes back to a fresh install: no record, default row, nothing remembered', async () => {
    seedStored({});
    const store = await launch();
    store.setClimbRowField('setter', false);
    store.applyClimbRowPreset('everything');
    const hasLastCustom = renderHook(store.useClimbRowHasLastCustom);
    expect(hasLastCustom.result.current).toBe(true);
    await act(settle);

    act(() => store.resetClimbRowDisplayForTests());

    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(hasLastCustom.result.current).toBe(false);
    expect(persisted()).toBeNull();
  });

  it('empties the old keys, so the next reader brings nothing in', async () => {
    seedStored({});
    const store = await launch();
    store.setClimbRowField('playlistTags', true);
    store.setClimbRowField('quickActions', false);
    await settle();
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(true);
    expect(oldKey(LEGACY_QUICK_ACTIONS_KEY)).toBe(false);

    store.resetClimbRowDisplayForTests();
    const { result } = renderHook(store.useClimbRowDisplay);
    await act(settle);

    expect([...legacyStorage]).toEqual([]);
    expect(result.current).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(persisted()).toEqual({ version: 1, overrides: {}, ...KEYS_READ_EMPTY });
  });

  it('drops a write to an old key that was queued and had not started', async () => {
    seedStored({});
    const store = await launch();
    store.setClimbRowField('playlistTags', true);

    store.resetClimbRowDisplayForTests();
    await settle();

    expect(writeLegacy).not.toHaveBeenCalled();
    expect([...legacyStorage]).toEqual([]);
    expect(persisted()).toBeNull();
  });

  it('lets nothing from a write already in flight land afterwards', async () => {
    seedStored({});
    const store = await launch();
    const answer = deferred<void>();
    writeLegacy.mockImplementationOnce(landsWithoutAnswering(answer.promise));
    store.setClimbRowField('playlistTags', true);
    await settle();
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(true);

    store.resetClimbRowDisplayForTests();
    answer.resolve();
    await settle();

    // Its value went with the keys, and its answer changed nothing.
    expect([...legacyStorage]).toEqual([]);
    expect(persisted()).toBeNull();
    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
  });

  it('writes a choice made again after the call once, not once more for the write it dropped', async () => {
    seedStored({});
    const store = await launch();
    store.setClimbRowField('playlistTags', true);

    store.resetClimbRowDisplayForTests();
    store.setClimbRowField('playlistTags', true);
    await settle();

    expect(writeLegacy).toHaveBeenCalledTimes(1);
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(true);
  });

  it('does not take the answer to a write from before the call for the same choice made after it', async () => {
    seedStored({});
    const store = await launch();
    const answer = deferred<void>();
    writeLegacy.mockImplementationOnce(landsWithoutAnswering(answer.promise));
    store.setClimbRowField('playlistTags', true);
    await settle();
    // The old keys are slow to empty, so the choice made again waits behind that.
    const removal = deferred<void>();
    removeLegacy.mockImplementation(async (key: string) => {
      await removal.promise;
      legacyStorage.delete(key);
    });

    store.resetClimbRowDisplayForTests();
    store.setClimbRowField('playlistTags', true);
    answer.resolve();
    await settle();
    removal.resolve();
    await settle();

    // Written again after the keys were emptied, and confirmed by that write.
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(true);
    expect(persisted()).toEqual({ version: 1, overrides: { playlistTags: true }, legacy: { playlistTags: true } });
  });

  it('drops a read of the old keys that was queued and had not started', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    const store = await launch();
    const sync = store.ensureClimbRowLegacySynced();

    store.resetClimbRowDisplayForTests();
    await sync;
    await settle();

    expect(readLegacy).not.toHaveBeenCalled();
    expect(persisted()).toBeNull();
  });

  it('drops a read of the old keys still in flight', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    const slowTagsRead = deferred<string | null>();
    readLegacy.mockImplementationOnce(() => slowTagsRead.promise);
    const store = await launch();
    const sync = store.ensureClimbRowLegacySynced();
    await settle();
    expect(readLegacy).toHaveBeenCalledTimes(2);

    store.resetClimbRowDisplayForTests();
    slowTagsRead.resolve('true');
    await sync;
    await settle();

    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(persisted()).toBeNull();
  });

  it('is not taken for a reset of every setting by the next settings write', async () => {
    seedStored({ thumbnail: false });
    const store = await launch();
    store.resetClimbRowDisplayForTests();
    mmkvSet.mockClear();

    store.setSetting('theme', 'dark');
    await settle();

    // Only the theme was written: nothing was owed to the old keys.
    expect(mmkvSet.mock.calls.map(([key]) => key)).toEqual(['theme']);
    expect(writeLegacy).not.toHaveBeenCalled();
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
    await settle();

    expect(readLegacy).toHaveBeenCalledTimes(4);
    expect(mmkvSet).not.toHaveBeenCalled();
    expect(writeLegacy).not.toHaveBeenCalled();
    expect(relaunched.getClimbRowDisplay().playlistTags).toBe(true);
  });

  it('writes nothing to the old keys for a climber who never chose', async () => {
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    await settle();
    expect(store.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    expect(persisted()).toEqual({ version: 1, overrides: {}, ...KEYS_READ_EMPTY });
    expect(writeLegacy).not.toHaveBeenCalled();
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

  it('lets a mix restored while the read is in flight win', async () => {
    // Names only showing, with a remembered mix that has tags on. The old keys
    // have never been read, and the tags' key holds an explicit "off".
    seedStored(namesOnlyOverrides(), { lastCustom: { ...presetFieldsOn(), playlistTags: true, setter: false } });
    legacyStorage.set(LEGACY_TAGS_KEY, 'false');
    const slowTagsRead = deferred<string | null>();
    readLegacy.mockImplementationOnce(() => slowTagsRead.promise);
    const store = await launch();
    const sync = store.ensureClimbRowLegacySynced();

    store.restoreLastCustomClimbRow();
    // On file at once, before any write to the old key is attempted.
    expect(persisted()).toMatchObject({ legacyPending: { playlistTags: true } });
    expect(writeLegacy).not.toHaveBeenCalled();
    slowTagsRead.resolve('false');
    await sync;
    await settle();

    expect(store.getClimbRowDisplay()).toMatchObject({ playlistTags: true, setter: false });
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(true);
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
    // Owed in the same write as the choice, before either key is touched.
    expect(persisted()).toEqual({
      version: 1,
      overrides: { playlistTags: false, quickActions: false },
      legacy: { playlistTags: true, quickActions: null },
      legacyPending: { playlistTags: false, quickActions: false },
    });
    expect(writeLegacy).not.toHaveBeenCalled();
    await settle();

    expect(oldKey(LEGACY_TAGS_KEY)).toBe(false);
    expect(oldKey(LEGACY_QUICK_ACTIONS_KEY)).toBe(false);
    // Confirmed: this build knows the keys hold them, and owes nothing.
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
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(true);

    store.restoreLastCustomClimbRow();
    await settle();
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(false);

    store.applyClimbRowPreset('default');
    await settle();
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(false);

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

  it('ends on the last of several quick flips, and skips a write a newer flip has overtaken', async () => {
    seedStored({});
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    const slowFirstWrite = deferred<void>();
    writeLegacy.mockImplementationOnce(async (key: string, serialised: string) => {
      await slowFirstWrite.promise;
      legacyStorage.set(key, serialised);
    });

    store.setClimbRowField('playlistTags', true);
    await settle();
    // The first write is under way. Two more flips queue behind it.
    store.setClimbRowField('playlistTags', false);
    store.setClimbRowField('playlistTags', true);
    await settle();
    expect(writeLegacy).toHaveBeenCalledTimes(1);

    slowFirstWrite.resolve();
    await settle();

    // "Off" never reached the disk: by its turn the climber was back on "on".
    expect(writeLegacy.mock.calls.map(([, serialised]) => serialised)).toEqual(['true']);
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(true);
    expect(persisted()).toEqual({
      version: 1,
      overrides: { playlistTags: true },
      legacy: { playlistTags: true, quickActions: null },
    });
  });

  it('writes each of several flips that its turn still finds wanted', async () => {
    seedStored({});
    const store = await launch();
    await store.ensureClimbRowLegacySynced();

    store.setClimbRowField('playlistTags', true);
    await settle();
    store.setClimbRowField('playlistTags', false);
    await settle();

    expect(writeLegacy.mock.calls.map(([, serialised]) => serialised)).toEqual(['true', 'false']);
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(false);
  });

  // The write to the old key is tried once per choice. When it fails, or the app
  // dies first, the value stays owed on file and the next launch makes the write.
  it('makes a write that failed again at the next launch, so the rollback still finds the choice', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    writeLegacy.mockRejectedValueOnce(new Error('disk full'));

    store.setClimbRowField('playlistTags', false);
    await settle();
    expect(store.getClimbRowDisplay().playlistTags).toBe(false);
    // A rollback now would show tags on. The record says so: still owed.
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(true);
    expect(persisted()).toEqual({
      version: 1,
      overrides: { playlistTags: false },
      legacy: { playlistTags: true, quickActions: null },
      legacyPending: { playlistTags: false },
    });

    const relaunched = await launch();
    await relaunched.ensureClimbRowLegacySynced();
    expect(relaunched.getClimbRowDisplay().playlistTags).toBe(false);
    await settle();

    expect(oldKey(LEGACY_TAGS_KEY)).toBe(false);
    expect(persisted()).toEqual({
      version: 1,
      overrides: { playlistTags: false },
      legacy: { playlistTags: false, quickActions: null },
    });
  });

  it('makes a write the app died before again at the next launch', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    // The storage call is made and never does anything: the process is gone.
    const neverAnswers = deferred<void>();
    writeLegacy.mockImplementationOnce(() => neverAnswers.promise);

    store.setClimbRowField('playlistTags', false);
    await settle();
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(true);

    const relaunched = await launch();
    await relaunched.ensureClimbRowLegacySynced();
    await settle();

    expect(relaunched.getClimbRowDisplay().playlistTags).toBe(false);
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(false);
    // Let the dead launch's call end, so its timeout cannot fire into a later test.
    neverAnswers.resolve();
    await settle();
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(false);
  });

  it('makes a failed write again with the next choice, without waiting for a launch', async () => {
    seedStored({});
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    writeLegacy.mockRejectedValueOnce(new Error('disk full'));

    store.setClimbRowField('quickActions', false);
    await settle();
    expect(legacyStorage.has(LEGACY_QUICK_ACTIONS_KEY)).toBe(false);

    store.setClimbRowField('playlistTags', true);
    await settle();

    expect(oldKey(LEGACY_TAGS_KEY)).toBe(true);
    expect(oldKey(LEGACY_QUICK_ACTIONS_KEY)).toBe(false);
  });

  // Key and baseline off. Tags on, then off again while the first write is under
  // way. The first write reaches the disk; the app dies before the second, and
  // before anything is confirmed. Read back cold, the key says "on".
  it('keeps the last of two quick flips when only the first write lands before the app dies', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'false');
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    const neverAnswers = deferred<void>();
    writeLegacy.mockImplementationOnce(landsWithoutAnswering(neverAnswers.promise));

    store.setClimbRowField('playlistTags', true);
    await settle();
    store.setClimbRowField('playlistTags', false);
    await settle();
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(true);
    expect(persisted()).toEqual({
      version: 1,
      overrides: { playlistTags: false },
      legacy: { playlistTags: false, quickActions: null },
      legacyPending: { playlistTags: false },
    });

    const relaunched = await launch();
    await relaunched.ensureClimbRowLegacySynced();
    // Its own overtaken write, not an older build's choice: the switch stays off.
    expect(relaunched.getClimbRowDisplay().playlistTags).toBe(false);
    await settle();
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(false);
    expect(persisted()).toEqual({
      version: 1,
      overrides: { playlistTags: false },
      legacy: { playlistTags: false, quickActions: null },
    });

    neverAnswers.resolve();
    await settle();
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(false);
    expect(relaunched.getClimbRowDisplay().playlistTags).toBe(false);
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
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(true);

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
    expect(oldKey(LEGACY_QUICK_ACTIONS_KEY)).toBe(true);
  });
});

// The read of an old key can fail for a whole launch, and so can the write that
// copies a choice to it. A choice made here must outlast both.
describe('a choice made before the old key could be read', () => {
  it('is on file at once, with its value owed to the key', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    readLegacy.mockRejectedValue(new Error('locked storage'));
    writeLegacy.mockRejectedValue(new Error('locked storage'));
    const store = await launch();
    await store.ensureClimbRowLegacySynced();

    // Default writes no override; the pending value is all that records the choice.
    store.applyClimbRowPreset('default');

    expect(persisted()).toEqual({ version: 1, overrides: {}, legacyPending: { playlistTags: false } });
  });

  it('is not replaced by the old key on the next launch, and reaches it then', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    legacyStorage.set(LEGACY_QUICK_ACTIONS_KEY, 'false');
    readLegacy.mockRejectedValue(new Error('locked storage'));
    writeLegacy.mockRejectedValue(new Error('locked storage'));
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    store.applyClimbRowPreset('default');
    store.setClimbRowField('quickActions', true);
    await settle();
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(true);
    expect(oldKey(LEGACY_QUICK_ACTIONS_KEY)).toBe(false);

    readLegacy.mockReset().mockImplementation(async (key: string) => legacyStorage.get(key) ?? null);
    writeLegacy.mockReset().mockImplementation(async (key: string, serialised: string) => {
      legacyStorage.set(key, serialised);
    });
    const relaunched = await launch();
    await relaunched.ensureClimbRowLegacySynced();
    expect(relaunched.getClimbRowDisplay()).toEqual(DEFAULT_CLIMB_ROW_DISPLAY);
    await settle();

    expect(oldKey(LEGACY_TAGS_KEY)).toBe(false);
    expect(oldKey(LEGACY_QUICK_ACTIONS_KEY)).toBe(true);
    expect(persisted()).toEqual({
      version: 1,
      overrides: { quickActions: true },
      legacy: { playlistTags: false, quickActions: true },
    });
  });

  it('is written to a key it already seems to match, so it does not stay owed for good', async () => {
    // Default applied with the key empty and the write failing: an older build
    // shows tags off either way, but nothing here knows the key holds that.
    writeLegacy.mockRejectedValueOnce(new Error('disk full'));
    const store = await launch();
    store.applyClimbRowPreset('default');
    await settle();
    expect(persisted()).toMatchObject({ legacyPending: { playlistTags: false } });

    const relaunched = await launch();
    await relaunched.ensureClimbRowLegacySynced();
    await settle();
    expect(oldKey(LEGACY_TAGS_KEY)).toBe(false);
    expect(persisted()).toEqual({ version: 1, overrides: {}, legacy: { playlistTags: false, quickActions: null } });

    // With nothing owed any more, a later choice on an older build arrives.
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    const afterOlderBuild = await launch();
    await afterOlderBuild.ensureClimbRowLegacySynced();
    expect(afterOlderBuild.getClimbRowDisplay().playlistTags).toBe(true);
  });
});

describe('a storage call for the old keys that never answers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives a write up after ten seconds, and makes the next one', async () => {
    seedStored({});
    const store = await launch();
    await store.ensureClimbRowLegacySynced();
    vi.useFakeTimers();
    writeLegacy.mockImplementationOnce(() => new Promise<void>(() => {}));

    store.setClimbRowField('playlistTags', true);
    store.setClimbRowField('quickActions', false);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(writeLegacy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(writeLegacy).toHaveBeenCalledTimes(2);
    expect(oldKey(LEGACY_QUICK_ACTIONS_KEY)).toBe(false);
    // The one that never answered stays owed.
    expect(persisted()).toEqual({
      version: 1,
      overrides: { playlistTags: true, quickActions: false },
      legacy: { playlistTags: null, quickActions: false },
      legacyPending: { playlistTags: true },
    });
  });

  it('gives the launch read up after ten seconds, leaves the launch unsynced and lets writes through', async () => {
    legacyStorage.set(LEGACY_TAGS_KEY, 'true');
    const store = await launch();
    vi.useFakeTimers();
    readLegacy.mockImplementationOnce(() => new Promise<string | null>(() => {}));

    const sync = store.ensureClimbRowLegacySynced();
    store.setClimbRowField('quickActions', false);
    await vi.advanceTimersByTimeAsync(10_000);
    await sync;

    expect(oldKey(LEGACY_QUICK_ACTIONS_KEY)).toBe(false);
    expect(store.getClimbRowDisplay().playlistTags).toBe(false);

    // Unsynced, so the next call reads again, and this time is answered.
    await store.ensureClimbRowLegacySynced();
    expect(store.getClimbRowDisplay().playlistTags).toBe(true);
  });

  it('leaves no timer behind once a call has answered', async () => {
    seedStored({});
    const store = await launch();
    vi.useFakeTimers();

    const sync = store.ensureClimbRowLegacySynced();
    store.setClimbRowField('playlistTags', true);
    await vi.advanceTimersByTimeAsync(0);
    await sync;

    expect(oldKey(LEGACY_TAGS_KEY)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
