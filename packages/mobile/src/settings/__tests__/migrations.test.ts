// Auto-disconnect carried into Stop driving after (2.7): every timeout's drive
// length, who gets writes and who doesn't, choices the climber already made,
// and a second run doing nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_AUTO_DISCONNECT_KEY,
  LEGACY_AUTO_DISCONNECT_TIMEOUT_KEY,
  LEGACY_LIGHT_ON_CLIMB_TAP_KEY,
  LEGACY_LIGHT_ON_SWIPE_KEY,
  migrateAutoDisconnect,
  migrateLightAutomatically,
  planAlwaysDriveMigration,
  planAutoDisconnectMigration,
  stopDrivingAfterForTimeout,
  type SettingsMigrationStore,
} from '../migrations';
import type { SettingsKey } from '../types';

const mockStorage = new Map<string, string>();

vi.mock('react-native-mmkv', () => ({
  createMMKV: vi.fn(() => ({
    getString: (key: string) => mockStorage.get(key),
    set: (key: string, value: string) => mockStorage.set(key, value),
    remove: (key: string) => mockStorage.delete(key),
    clearAll: () => mockStorage.clear(),
  })),
}));

/** An in-memory store over raw JSON strings, as MMKV holds them. */
function memoryStore(initial: Record<string, unknown>): SettingsMigrationStore & {
  raw: Map<string, string>;
  writes: string[];
} {
  const raw = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  const writes: string[] = [];
  return {
    raw,
    writes,
    read: (key) => {
      const stored = raw.get(key);
      return stored === undefined ? undefined : (JSON.parse(stored) as unknown);
    },
    has: (key: SettingsKey) => raw.has(key),
    set: (key, value) => {
      writes.push(key);
      raw.set(key, JSON.stringify(value));
    },
  };
}

function parsed(store: { raw: Map<string, string> }, key: string): unknown {
  const stored = store.raw.get(key);
  return stored === undefined ? undefined : (JSON.parse(stored) as unknown);
}

describe('stopDrivingAfterForTimeout', () => {
  it.each([
    [10, '30'],
    [15, '30'],
    [30, '30'],
    [45, '45'],
    [60, '60'],
    [120, '120'],
    [300, '300'],
    [600, '300'],
  ] as const)('carries a %i s timeout into %s', (seconds, choice) => {
    expect(stopDrivingAfterForTimeout(seconds)).toBe(choice);
  });

  it('reads a timeout the old setting could never hold as its 30 s default', () => {
    expect(stopDrivingAfterForTimeout(undefined)).toBe('30');
    expect(stopDrivingAfterForTimeout('45')).toBe('30');
    expect(stopDrivingAfterForTimeout(Number.NaN)).toBe('30');
    expect(stopDrivingAfterForTimeout(0)).toBe('30');
    expect(stopDrivingAfterForTimeout(-60)).toBe('30');
  });
});

describe('planAutoDisconnectMigration', () => {
  const ON = {
    migrated: false,
    autoDisconnect: true,
    timeoutSeconds: 60,
    keepLightingSet: false,
  };

  // One Stop driving after for every board: no MoonBoard length any more.
  it('turns on the disconnect and sets the length, then the flag last', () => {
    expect(planAutoDisconnectMigration(ON)).toEqual([
      { key: 'disconnectWhenDrivingEnds', value: true },
      { key: 'putOnBoardKeepsLighting', value: '60' },
      { key: 'autoDisconnectMigrated', value: true },
    ]);
  });

  it('leaves a length the climber already chose', () => {
    expect(planAutoDisconnectMigration({ ...ON, keepLightingSet: true })).toEqual([
      { key: 'disconnectWhenDrivingEnds', value: true },
      { key: 'autoDisconnectMigrated', value: true },
    ]);
  });

  it('writes nothing for a climber without auto-disconnect on', () => {
    expect(planAutoDisconnectMigration({ ...ON, autoDisconnect: false })).toEqual([]);
    expect(planAutoDisconnectMigration({ ...ON, autoDisconnect: undefined })).toEqual([]);
    expect(planAutoDisconnectMigration({ ...ON, autoDisconnect: 'true' })).toEqual([]);
  });

  it('writes nothing once it has run', () => {
    expect(planAutoDisconnectMigration({ ...ON, migrated: true })).toEqual([]);
  });
});

describe('migrateAutoDisconnect', () => {
  it.each([
    [10, '30'],
    [15, '30'],
    [30, '30'],
    [45, '45'],
    [60, '60'],
    [120, '120'],
    [300, '300'],
    [600, '300'],
  ] as const)('auto-disconnect on at %i s: Stop driving after %s on every board, disconnect on', (seconds, choice) => {
    const store = memoryStore({ [LEGACY_AUTO_DISCONNECT_KEY]: true, [LEGACY_AUTO_DISCONNECT_TIMEOUT_KEY]: seconds });
    expect(migrateAutoDisconnect(store)).toBe(true);
    expect(parsed(store, 'putOnBoardKeepsLighting')).toBe(choice);
    // The retired MoonBoard length is never written.
    expect(parsed(store, 'moonboardPutOnBoardKeepsLighting')).toBeUndefined();
    expect(parsed(store, 'disconnectWhenDrivingEnds')).toBe(true);
    expect(parsed(store, 'autoDisconnectMigrated')).toBe(true);
  });

  it('auto-disconnect on with the timeout never picked: 30 s', () => {
    const store = memoryStore({ [LEGACY_AUTO_DISCONNECT_KEY]: true });
    migrateAutoDisconnect(store);
    expect(parsed(store, 'putOnBoardKeepsLighting')).toBe('30');
  });

  it('keeps the Stop driving after length a climber already set, and leaves the retired MoonBoard one alone', () => {
    const store = memoryStore({
      [LEGACY_AUTO_DISCONNECT_KEY]: true,
      [LEGACY_AUTO_DISCONNECT_TIMEOUT_KEY]: 600,
      putOnBoardKeepsLighting: 'until_stopped',
      moonboardPutOnBoardKeepsLighting: 'off',
    });
    migrateAutoDisconnect(store);
    expect(parsed(store, 'putOnBoardKeepsLighting')).toBe('until_stopped');
    expect(parsed(store, 'moonboardPutOnBoardKeepsLighting')).toBe('off');
    expect(parsed(store, 'disconnectWhenDrivingEnds')).toBe(true);
  });

  it('changes nothing for everyone else, and writes no flag', () => {
    for (const initial of [
      {},
      { [LEGACY_AUTO_DISCONNECT_KEY]: false, [LEGACY_AUTO_DISCONNECT_TIMEOUT_KEY]: 10 },
      { [LEGACY_AUTO_DISCONNECT_TIMEOUT_KEY]: 120 },
    ]) {
      const store = memoryStore(initial);
      expect(migrateAutoDisconnect(store)).toBe(false);
      expect(store.writes).toEqual([]);
    }
  });

  it('runs once: a second run, after the climber changed things, writes nothing', () => {
    const store = memoryStore({ [LEGACY_AUTO_DISCONNECT_KEY]: true, [LEGACY_AUTO_DISCONNECT_TIMEOUT_KEY]: 45 });
    expect(migrateAutoDisconnect(store)).toBe(true);
    // The climber turns the disconnect off and picks another length.
    store.set('disconnectWhenDrivingEnds', false);
    store.set('putOnBoardKeepsLighting', '120');
    store.writes.length = 0;
    expect(migrateAutoDisconnect(store)).toBe(false);
    expect(store.writes).toEqual([]);
    expect(parsed(store, 'disconnectWhenDrivingEnds')).toBe(false);
    expect(parsed(store, 'putOnBoardKeepsLighting')).toBe('120');
  });

  it('leaves the retired keys on disk for an older bundle', () => {
    const store = memoryStore({ [LEGACY_AUTO_DISCONNECT_KEY]: true, [LEGACY_AUTO_DISCONNECT_TIMEOUT_KEY]: 120 });
    migrateAutoDisconnect(store);
    expect(parsed(store, LEGACY_AUTO_DISCONNECT_KEY)).toBe(true);
    expect(parsed(store, LEGACY_AUTO_DISCONNECT_TIMEOUT_KEY)).toBe(120);
  });
});

// The two Always drive the wall switches carried into one (alwaysDrive): either
// one on turns it on; nothing else changes, and a second run writes nothing.
describe('planAlwaysDriveMigration', () => {
  it.each([
    [true, undefined],
    [undefined, true],
    [true, true],
    [true, false],
    [false, true],
  ] as const)('tap %s, swipe %s: Always drive the wall on', (lightOnClimbTap, lightOnSwipe) => {
    expect(planAlwaysDriveMigration({ alwaysDriveSet: false, lightOnClimbTap, lightOnSwipe })).toEqual([
      { key: 'alwaysDrive', value: true },
    ]);
  });

  it.each([
    [undefined, undefined],
    [false, false],
    [false, undefined],
    ['true', 1],
    [null, 'yes'],
  ] as const)('tap %s, swipe %s: nothing written', (lightOnClimbTap, lightOnSwipe) => {
    expect(planAlwaysDriveMigration({ alwaysDriveSet: false, lightOnClimbTap, lightOnSwipe })).toEqual([]);
  });

  it('writes nothing once Always drive the wall is stored, whatever the old switches say', () => {
    expect(planAlwaysDriveMigration({ alwaysDriveSet: true, lightOnClimbTap: true, lightOnSwipe: true })).toEqual([]);
  });
});

describe('migrateLightAutomatically', () => {
  it.each([
    [{ [LEGACY_LIGHT_ON_CLIMB_TAP_KEY]: true }],
    [{ [LEGACY_LIGHT_ON_SWIPE_KEY]: true }],
    [{ [LEGACY_LIGHT_ON_CLIMB_TAP_KEY]: true, [LEGACY_LIGHT_ON_SWIPE_KEY]: true }],
    [{ [LEGACY_LIGHT_ON_CLIMB_TAP_KEY]: false, [LEGACY_LIGHT_ON_SWIPE_KEY]: true }],
  ])('%o: Always drive the wall on, and nothing else written', (initial) => {
    const store = memoryStore(initial);
    expect(migrateLightAutomatically(store)).toBe(true);
    expect(parsed(store, 'alwaysDrive')).toBe(true);
    expect(store.writes).toEqual(['alwaysDrive']);
  });

  it('changes nothing for a climber with both switches off or never set', () => {
    for (const initial of [
      {},
      { [LEGACY_LIGHT_ON_CLIMB_TAP_KEY]: false },
      { [LEGACY_LIGHT_ON_CLIMB_TAP_KEY]: false, [LEGACY_LIGHT_ON_SWIPE_KEY]: false },
    ]) {
      const store = memoryStore(initial);
      expect(migrateLightAutomatically(store)).toBe(false);
      expect(store.writes).toEqual([]);
      expect(parsed(store, 'alwaysDrive')).toBeUndefined();
    }
  });

  it('runs once: after the climber turns Always drive the wall off, a second run leaves it off', () => {
    const store = memoryStore({ [LEGACY_LIGHT_ON_SWIPE_KEY]: true });
    expect(migrateLightAutomatically(store)).toBe(true);
    store.set('alwaysDrive', false);
    store.writes.length = 0;
    expect(migrateLightAutomatically(store)).toBe(false);
    expect(store.writes).toEqual([]);
    expect(parsed(store, 'alwaysDrive')).toBe(false);
  });

  it('keeps a choice the climber already made', () => {
    const store = memoryStore({ alwaysDrive: false, [LEGACY_LIGHT_ON_CLIMB_TAP_KEY]: true });
    expect(migrateLightAutomatically(store)).toBe(false);
    expect(parsed(store, 'alwaysDrive')).toBe(false);
  });

  it('leaves the retired switches on disk for an older bundle', () => {
    const store = memoryStore({ [LEGACY_LIGHT_ON_CLIMB_TAP_KEY]: true, [LEGACY_LIGHT_ON_SWIPE_KEY]: false });
    migrateLightAutomatically(store);
    expect(parsed(store, LEGACY_LIGHT_ON_CLIMB_TAP_KEY)).toBe(true);
    expect(parsed(store, LEGACY_LIGHT_ON_SWIPE_KEY)).toBe(false);
  });
});

// The settings store runs it at its first import, before anything reads a setting.
describe('at the settings store import', () => {
  beforeEach(() => {
    mockStorage.clear();
    vi.resetModules();
  });

  it('carries auto-disconnect before the first read', async () => {
    mockStorage.set(LEGACY_AUTO_DISCONNECT_KEY, 'true');
    mockStorage.set(LEGACY_AUTO_DISCONNECT_TIMEOUT_KEY, '15');
    const { getSetting } = await import('../hooks');
    expect(getSetting('putOnBoardKeepsLighting')).toBe('30');
    expect(getSetting('disconnectWhenDrivingEnds')).toBe(true);
    expect(getSetting('autoDisconnectMigrated')).toBe(true);
  });

  it('leaves a climber without auto-disconnect on the defaults, with nothing written', async () => {
    mockStorage.set(LEGACY_AUTO_DISCONNECT_KEY, 'false');
    const { getSetting } = await import('../hooks');
    expect(getSetting('putOnBoardKeepsLighting')).toBe('45');
    expect(getSetting('disconnectWhenDrivingEnds')).toBe(false);
    expect([...mockStorage.keys()]).toEqual([LEGACY_AUTO_DISCONNECT_KEY]);
  });

  it('turns Always drive the wall on for a climber who had Light the board as I swipe on', async () => {
    mockStorage.set(LEGACY_LIGHT_ON_SWIPE_KEY, 'true');
    const { getSetting } = await import('../hooks');
    expect(getSetting('alwaysDrive')).toBe(true);
  });

  it('leaves Always drive the wall off with both switches off, and writes nothing', async () => {
    mockStorage.set(LEGACY_LIGHT_ON_CLIMB_TAP_KEY, 'false');
    const { getSetting } = await import('../hooks');
    expect(getSetting('alwaysDrive')).toBe(false);
    expect([...mockStorage.keys()]).toEqual([LEGACY_LIGHT_ON_CLIMB_TAP_KEY]);
  });

  it('does not turn Always drive the wall back on at the next launch', async () => {
    mockStorage.set(LEGACY_LIGHT_ON_CLIMB_TAP_KEY, 'true');
    await import('../hooks');
    mockStorage.set('alwaysDrive', 'false');
    vi.resetModules();
    const { getSetting } = await import('../hooks');
    expect(getSetting('alwaysDrive')).toBe(false);
  });

  it('does not run again on the next launch', async () => {
    mockStorage.set(LEGACY_AUTO_DISCONNECT_KEY, 'true');
    await import('../hooks');
    mockStorage.set('disconnectWhenDrivingEnds', 'false');
    vi.resetModules();
    const { getSetting } = await import('../hooks');
    expect(getSetting('disconnectWhenDrivingEnds')).toBe(false);
  });
});
