import type { KeepLightingChoice, KeepLightingSettingKey } from '../lib/keep-lighting';
import type { AppSettings, SettingsKey } from './types';

// Auto-disconnect gave way to auto stop driving (2.7): the drive Put on board
// starts stops on its own after the climber's choice, and "Disconnect
// Bluetooth when driving ends" lets go of the board then. A climber who had
// auto-disconnect on keeps what it did for them: their timeout becomes the
// drive's length, and the board is let go when the drive ends.
//
// Runs once, at the settings store's first import (`hooks.ts`), before any
// screen reads a setting. Only a climber with auto-disconnect on has anything
// written; everyone else is left exactly as they were. The old keys stay on
// disk, untouched, so an older bundle (an OTA rollback) still finds them.

/** The retired auto-disconnect switch. Read only here. */
export const LEGACY_AUTO_DISCONNECT_KEY = 'autoDisconnectBle';
/** The retired auto-disconnect timeout, in seconds. Read only here. */
export const LEGACY_AUTO_DISCONNECT_TIMEOUT_KEY = 'autoDisconnectTimeoutSeconds';
/** What the timeout read as before the climber picked one. */
const LEGACY_DEFAULT_TIMEOUT_SECONDS = 30;

/** A timed Stop driving after choice: what an auto-disconnect timeout carries into. */
export type TimedKeepLightingChoice = Exclude<KeepLightingChoice, 'off' | 'until_stopped'>;

/**
 * The drive length an auto-disconnect timeout carries into: the shortest
 * choice that is at least as long, capped at 5 minutes. 10 and 15 s become
 * 30 s; 30, 45 and 60 s stay; 2 and 5 minutes stay; 10 minutes becomes 5. A
 * value the old setting could never hold reads as its default, 30 s.
 */
export function stopDrivingAfterForTimeout(seconds: unknown): TimedKeepLightingChoice {
  const timeout =
    typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : LEGACY_DEFAULT_TIMEOUT_SECONDS;
  if (timeout <= 30) return '30';
  if (timeout <= 45) return '45';
  if (timeout <= 60) return '60';
  if (timeout <= 120) return '120';
  return '300';
}

/** One write the migration makes, in order. */
export type AutoDisconnectMigrationWrite =
  | { key: 'disconnectWhenDrivingEnds' | 'autoDisconnectMigrated'; value: boolean }
  | { key: KeepLightingSettingKey; value: KeepLightingChoice };

/**
 * What the migration writes, or an empty list. Pure, for the table tests.
 *
 * - Already migrated: nothing, whatever the old keys say now.
 * - Auto-disconnect not on (`=== true`): nothing.
 * - Auto-disconnect on: Disconnect Bluetooth when driving ends on; Stop
 *   driving after, where the climber never set it, takes the timeout's drive
 *   length; then the one-shot flag, last, so a launch killed half-way runs the
 *   rest again.
 */
export function planAutoDisconnectMigration({
  migrated,
  autoDisconnect,
  timeoutSeconds,
  keepLightingSet,
}: {
  /** `autoDisconnectMigrated` is on: it already ran. */
  migrated: boolean;
  /** The stored `autoDisconnectBle`, as parsed (undefined when absent). */
  autoDisconnect: unknown;
  /** The stored `autoDisconnectTimeoutSeconds`, as parsed (undefined when absent). */
  timeoutSeconds: unknown;
  /** The climber chose a Stop driving after length (the key is stored). */
  keepLightingSet: boolean;
}): AutoDisconnectMigrationWrite[] {
  if (migrated || autoDisconnect !== true) return [];
  const length = stopDrivingAfterForTimeout(timeoutSeconds);
  const writes: AutoDisconnectMigrationWrite[] = [{ key: 'disconnectWhenDrivingEnds', value: true }];
  if (!keepLightingSet) writes.push({ key: 'putOnBoardKeepsLighting', value: length });
  writes.push({ key: 'autoDisconnectMigrated', value: true });
  return writes;
}

/** The settings store, as the migrations read and write it. */
export type SettingsMigrationStore = {
  /** A stored key's parsed value, or undefined when absent or unreadable: the retired keys too. */
  read: (key: string) => unknown;
  /** The key is stored (`hasSetting`). */
  has: (key: SettingsKey) => boolean;
  set: <K extends SettingsKey>(key: K, value: AppSettings[K]) => void;
};

/** Carry auto-disconnect into Stop driving after, once. Returns whether anything was written. */
export function migrateAutoDisconnect(store: SettingsMigrationStore): boolean {
  // The flag first: once it is on, the retired keys are never read again.
  if (store.read('autoDisconnectMigrated') === true) return false;
  const writes = planAutoDisconnectMigration({
    migrated: false,
    autoDisconnect: store.read(LEGACY_AUTO_DISCONNECT_KEY),
    timeoutSeconds: store.read(LEGACY_AUTO_DISCONNECT_TIMEOUT_KEY),
    keepLightingSet: store.has('putOnBoardKeepsLighting'),
  });
  for (const write of writes) store.set(write.key, write.value);
  return writes.length > 0;
}

// Two switches gave way to one, Always drive the wall (2026-11): Light the
// board when I tap a climb and Light the board as I swipe each lit picks
// their own way, outside a drive. Always drive the wall now always drives the
// wall while this phone holds the board, so every pick lights as after a
// swipe on the wall button. A climber who had either switch on keeps
// automatic lighting: Always drive the wall turns on for them.
//
// Runs at the settings store's first import, after the auto-disconnect carry.
// It writes only `alwaysDrive`, and only while that key was never stored, so
// once it carried (or the climber chose for themselves) it never runs again.
// The old keys stay on disk, untouched, so an older bundle (an OTA rollback)
// still finds them.

/** The retired Light the board when I tap a climb. Read only here. */
export const LEGACY_LIGHT_ON_CLIMB_TAP_KEY = 'lightOnClimbTap';
/** The retired Light the board as I swipe. Read only here. */
export const LEGACY_LIGHT_ON_SWIPE_KEY = 'lightOnSwipe';

/** The write the Always drive the wall carry makes. */
export type AlwaysDriveMigrationWrite = { key: 'alwaysDrive'; value: true };

/**
 * What the carry writes, or an empty list. Pure, for the table tests.
 *
 * - Always drive the wall already stored (carried, or the climber's own
 *   choice): nothing, whatever the old keys say.
 * - Either old switch on (`=== true`): Always drive the wall on.
 * - Otherwise: nothing. The default (off) is what they had.
 */
export function planAlwaysDriveMigration({
  alwaysDriveSet,
  lightOnClimbTap,
  lightOnSwipe,
}: {
  /** `alwaysDrive` is stored (`hasSetting`). */
  alwaysDriveSet: boolean;
  /** The stored `lightOnClimbTap`, as parsed (undefined when absent). */
  lightOnClimbTap: unknown;
  /** The stored `lightOnSwipe`, as parsed (undefined when absent). */
  lightOnSwipe: unknown;
}): AlwaysDriveMigrationWrite[] {
  if (alwaysDriveSet) return [];
  if (lightOnClimbTap !== true && lightOnSwipe !== true) return [];
  return [{ key: 'alwaysDrive', value: true }];
}

/** Carry the two retired switches into Always drive the wall, once. Returns whether anything was written. */
export function migrateLightAutomatically(store: SettingsMigrationStore): boolean {
  const writes = planAlwaysDriveMigration({
    alwaysDriveSet: store.has('alwaysDrive'),
    lightOnClimbTap: store.read(LEGACY_LIGHT_ON_CLIMB_TAP_KEY),
    lightOnSwipe: store.read(LEGACY_LIGHT_ON_SWIPE_KEY),
  });
  for (const write of writes) store.set(write.key, write.value);
  return writes.length > 0;
}
