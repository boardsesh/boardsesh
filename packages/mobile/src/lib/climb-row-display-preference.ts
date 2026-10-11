import { useSyncExternalStore } from 'react';
import { getSetting, setSetting, subscribeSettings } from '../settings/hooks';
import { getPreference, setPreference } from './preference-store';
import {
  CLIMB_ROW_FIELD_IDS,
  CLIMB_ROW_PRESET_FIELD_IDS,
  isClimbRowLegacyFieldId,
  resolveClimbRowDisplay,
  sameStoredClimbRowDisplay,
  sanitiseStoredClimbRowDisplay,
  withClimbRowDisplayReset,
  withClimbRowField,
  withClimbRowLastCustomRestored,
  withClimbRowLegacyMirrored,
  withClimbRowLegacyRead,
  withClimbRowPreset,
  type ClimbRowDisplay,
  type ClimbRowFieldId,
  type ClimbRowLegacyFieldId,
  type ClimbRowPresetId,
  type StoredClimbRowDisplay,
} from './climb-row-display';

// What a climb list row shows, persisted. The rules live in `climb-row-display.ts`;
// this file is only the storage and the subscription.
//
// One record in the SYNCHRONOUS settings store (MMKV), not AsyncStorage: a switch
// can change the row's geometry, so the answer has to be known before the first
// row paints. That is also why there is no `loaded` flag here.
//
// This module is the only reader and writer of the key, and it keeps its own
// snapshot and listeners instead of going through `useSetting`. The settings
// store drops every cached snapshot on every write, which would hand this
// object-valued key a new identity on an unrelated write and re-render every
// mounted row. Here the snapshot only changes identity when a switch changes.
const SETTINGS_KEY = 'climbRowDisplayV1';

// The AsyncStorage keys the two oldest switches had to themselves. A build from
// before this record still reads and writes them, so they are read at every
// launch (an older build may have changed one since) and written on every choice
// made here (an OTA rollback must find it). Never deleted.
const LEGACY_STORAGE_KEYS: Record<ClimbRowLegacyFieldId, string> = {
  playlistTags: 'showPlaylistTagsOnClimbList',
  quickActions: 'showClimbQuickActionsButton',
};

let stored = sanitiseStoredClimbRowDisplay(getSetting(SETTINGS_KEY));
let display = resolveClimbRowDisplay(stored.overrides);
const listeners = new Set<() => void>();
// What the climber touched since launch. The read of the old keys is
// asynchronous, so a choice made while it is in flight must not be replaced by
// the older value it comes back with.
const changedThisLaunch = new Set<ClimbRowFieldId>();
let legacySynced = false;
let legacySync: Promise<void> | null = null;
// Everything that touches the old keys runs one after another, so a read cannot
// land between a write and the baseline that write sets.
let legacyQueue: Promise<void> = Promise.resolve();
// Bumped by the test reset, so work still in flight cannot land in the next test.
let generation = 0;
let writing = false;

/** Takes a record as the current one. Listeners hear about it only when a reader's answer moved. */
function adopt(next: StoredClimbRowDisplay): void {
  const nextDisplay = resolveClimbRowDisplay(next.overrides);
  const displayChanged = CLIMB_ROW_FIELD_IDS.some((fieldId) => nextDisplay[fieldId] !== display[fieldId]);
  const lastCustomChanged = (next.lastCustom === undefined) !== (stored.lastCustom === undefined);
  stored = next;
  if (displayChanged) display = nextDisplay;
  if (displayChanged || lastCustomChanged) for (const listener of listeners) listener();
}

function write(record: StoredClimbRowDisplay): void {
  // The settings store signals our own write like any other. There is nothing to
  // learn from it, and a write that did not stick must not read as a reset.
  writing = true;
  try {
    setSetting(SETTINGS_KEY, record);
  } finally {
    writing = false;
  }
}

/**
 * Takes the record on the phone as the current one when memory holds something
 * else. False when there is no record to take.
 */
function adoptRecordOnPhone(): boolean {
  const persisted = getSetting(SETTINGS_KEY);
  if (persisted === null) return false;
  const read = sanitiseStoredClimbRowDisplay(persisted);
  if (!sameStoredClimbRowDisplay(read, stored)) adopt(read);
  return true;
}

/**
 * A change on top of what is on the phone now: one in-memory publish, then one
 * write.
 *
 * It looks before it builds. The read at import can have come back empty while a
 * record exists, and a change built on that empty read would overwrite the real
 * one. Finding no record says nothing (a fresh install looks the same), so then
 * memory stands.
 */
function mutate(change: (current: StoredClimbRowDisplay) => StoredClimbRowDisplay): void {
  adoptRecordOnPhone();
  const next = change(stored);
  if (sameStoredClimbRowDisplay(next, stored)) return;
  adopt(next);
  write(next);
}

// The key can change underneath this module: `resetAllSettings` clears the whole
// store. The settings store signals every write without saying which key, so look
// at this one each time; that is one small parse per settings write, of which
// there are a handful per session.
subscribeSettings(() => {
  if (writing || adoptRecordOnPhone()) return;
  // No record after a signal: every setting was reset. Back to the defaults, but
  // still knowing what the old keys hold, and with that written back. Otherwise
  // the next launch would read those keys as new and undo the reset.
  const kept = withClimbRowDisplayReset(stored);
  if (!sameStoredClimbRowDisplay(kept, stored)) adopt(kept);
  if (kept.legacy) write(kept);
});

function enqueueLegacyStorage(task: () => Promise<void>): Promise<void> {
  // A failure is expected (iOS denies the backing file on a background launch
  // before the first unlock) and must not stop what is queued behind it.
  const settled = legacyQueue.then(task).catch(() => {});
  legacyQueue = settled;
  return settled;
}

/** Copies a choice made here to its old key, then records that the key holds it. */
function mirrorToLegacyKey(fieldId: ClimbRowLegacyFieldId): void {
  const value = display[fieldId];
  const startedIn = generation;
  void enqueueLegacyStorage(async () => {
    await setPreference(LEGACY_STORAGE_KEYS[fieldId], value);
    if (startedIn !== generation) return;
    mutate((current) => withClimbRowLegacyMirrored(current, fieldId, value));
  });
}

/** A choice the climber made here: applied, kept ahead of a read still in flight, and mirrored. */
function decide(
  fieldIds: readonly ClimbRowFieldId[],
  change: (current: StoredClimbRowDisplay) => StoredClimbRowDisplay,
): void {
  for (const fieldId of fieldIds) changedThisLaunch.add(fieldId);
  mutate(change);
  for (const fieldId of fieldIds) if (isClimbRowLegacyFieldId(fieldId)) mirrorToLegacyKey(fieldId);
}

/**
 * Reads the two old keys and reconciles them with the record, once per launch.
 * Kicked at launch; never rejects.
 *
 * Every launch, not once per install: an older build can have changed a key
 * since this one last ran (a tester back from a preview), and that only shows as
 * a difference from the stored baseline.
 *
 * A rejected read changes nothing and leaves the launch unsynced, so it is tried
 * again by the next reader that mounts and, failing that, on the next launch.
 */
export function ensureClimbRowLegacySynced(): Promise<void> {
  if (legacySynced) return Promise.resolve();
  if (legacySync) return legacySync;
  const startedIn = generation;
  const sync: Promise<void> = enqueueLegacyStorage(async () => {
    const [playlistTags, quickActions] = await Promise.all([
      getPreference<unknown>(LEGACY_STORAGE_KEYS.playlistTags),
      getPreference<unknown>(LEGACY_STORAGE_KEYS.quickActions),
    ]);
    if (startedIn !== generation) return;
    mutate((current) => withClimbRowLegacyRead(current, { playlistTags, quickActions }, changedThisLaunch));
    legacySynced = true;
  }).finally(() => {
    if (legacySync === sync) legacySync = null;
  });
  legacySync = sync;
  return sync;
}

function subscribe(listener: () => void): () => void {
  // The retry for a read of the old keys that was rejected earlier this launch.
  // One boolean test per mount once it has succeeded, so rows can afford it.
  if (!legacySynced) void ensureClimbRowLegacySynced();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getDisplaySnapshot(): ClimbRowDisplay {
  return display;
}

function getHasLastCustomSnapshot(): boolean {
  return stored.lastCustom !== undefined;
}

// One getter per field, made once. A getter built during render would have a new
// identity on every render, and `useSyncExternalStore` schedules an effect each
// time that happens: a cost per row, per render, for nothing.
const fieldSnapshots = new Map<ClimbRowFieldId, () => boolean>();
function fieldSnapshot(fieldId: ClimbRowFieldId): () => boolean {
  let getFieldSnapshot = fieldSnapshots.get(fieldId);
  if (!getFieldSnapshot) {
    getFieldSnapshot = () => display[fieldId];
    fieldSnapshots.set(fieldId, getFieldSnapshot);
  }
  return getFieldSnapshot;
}

export function getClimbRowDisplay(): ClimbRowDisplay {
  return display;
}

/** The whole row. The object keeps its identity until a switch changes. */
export function useClimbRowDisplay(): ClimbRowDisplay {
  return useSyncExternalStore(subscribe, getDisplaySnapshot, getDisplaySnapshot);
}

/** One switch. A primitive, so a reader re-renders only when that switch changes. */
export function useClimbRowField(fieldId: ClimbRowFieldId): boolean {
  const getFieldSnapshot = fieldSnapshot(fieldId);
  return useSyncExternalStore(subscribe, getFieldSnapshot, getFieldSnapshot);
}

/** Whether `restoreLastCustomClimbRow` has a hand-made mix to bring back. */
export function useClimbRowHasLastCustom(): boolean {
  return useSyncExternalStore(subscribe, getHasLastCustomSnapshot, getHasLastCustomSnapshot);
}

export function setClimbRowField(fieldId: ClimbRowFieldId, value: boolean): void {
  decide([fieldId], (current) => withClimbRowField(current, fieldId, value));
}

export function applyClimbRowPreset(presetId: ClimbRowPresetId): void {
  decide(CLIMB_ROW_PRESET_FIELD_IDS, (current) => withClimbRowPreset(current, presetId));
}

export function restoreLastCustomClimbRow(): void {
  // Asked of the record on the phone, like every other change.
  adoptRecordOnPhone();
  if (!stored.lastCustom) return;
  decide(CLIMB_ROW_PRESET_FIELD_IDS, withClimbRowLastCustomRestored);
}

/** Back to a fresh install: an empty record, nothing changed, nothing in flight. */
export function resetClimbRowDisplayForTests(): void {
  generation += 1;
  changedThisLaunch.clear();
  legacySynced = false;
  legacySync = null;
  legacyQueue = Promise.resolve();
  const fresh: StoredClimbRowDisplay = { version: 1, overrides: {} };
  adopt(fresh);
  write(fresh);
}
