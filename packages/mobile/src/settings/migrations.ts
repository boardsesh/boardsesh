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
 * - Auto-disconnect on: Disconnect Bluetooth when driving ends on; each Stop
 *   driving after choice the climber never set (the general one and the
 *   MoonBoard's) takes the timeout's drive length; then the one-shot flag,
 *   last, so a launch killed half-way runs the rest again.
 */
export function planAutoDisconnectMigration({
  migrated,
  autoDisconnect,
  timeoutSeconds,
  keepLightingSet,
  moonboardKeepLightingSet,
}: {
  /** `autoDisconnectMigrated` is on: it already ran. */
  migrated: boolean;
  /** The stored `autoDisconnectBle`, as parsed (undefined when absent). */
  autoDisconnect: unknown;
  /** The stored `autoDisconnectTimeoutSeconds`, as parsed (undefined when absent). */
  timeoutSeconds: unknown;
  /** The climber chose a Stop driving after length (the key is stored). */
  keepLightingSet: boolean;
  /** The climber chose the MoonBoard's Stop driving after length. */
  moonboardKeepLightingSet: boolean;
}): AutoDisconnectMigrationWrite[] {
  if (migrated || autoDisconnect !== true) return [];
  const length = stopDrivingAfterForTimeout(timeoutSeconds);
  const writes: AutoDisconnectMigrationWrite[] = [{ key: 'disconnectWhenDrivingEnds', value: true }];
  if (!keepLightingSet) writes.push({ key: 'putOnBoardKeepsLighting', value: length });
  if (!moonboardKeepLightingSet) writes.push({ key: 'moonboardPutOnBoardKeepsLighting', value: length });
  writes.push({ key: 'autoDisconnectMigrated', value: true });
  return writes;
}

/** The settings store, as the migration reads and writes it. */
export type AutoDisconnectMigrationStore = {
  /** A stored key's parsed value, or undefined when absent or unreadable: the retired keys too. */
  read: (key: string) => unknown;
  /** The key is stored (`hasSetting`). */
  has: (key: SettingsKey) => boolean;
  set: <K extends SettingsKey>(key: K, value: AppSettings[K]) => void;
};

/** Carry auto-disconnect into Stop driving after, once. Returns whether anything was written. */
export function migrateAutoDisconnect(store: AutoDisconnectMigrationStore): boolean {
  // The flag first: once it is on, the retired keys are never read again.
  if (store.read('autoDisconnectMigrated') === true) return false;
  const writes = planAutoDisconnectMigration({
    migrated: false,
    autoDisconnect: store.read(LEGACY_AUTO_DISCONNECT_KEY),
    timeoutSeconds: store.read(LEGACY_AUTO_DISCONNECT_TIMEOUT_KEY),
    keepLightingSet: store.has('putOnBoardKeepsLighting'),
    moonboardKeepLightingSet: store.has('moonboardPutOnBoardKeepsLighting'),
  });
  for (const write of writes) store.set(write.key, write.value);
  return writes.length > 0;
}
