import { useSyncExternalStore } from 'react';
import { getSetting, setSetting, subscribeSettings } from '../settings/hooks';
import { getPreference } from './preference-store';
import {
  CLIMB_ROW_FIELD_IDS,
  CLIMB_ROW_PRESET_FIELD_IDS,
  resolveClimbRowDisplay,
  sameStoredClimbRowDisplay,
  sanitiseStoredClimbRowDisplay,
  withClimbRowField,
  withClimbRowLastCustomRestored,
  withClimbRowLegacyChoices,
  withClimbRowPreset,
  type ClimbRowDisplay,
  type ClimbRowFieldId,
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

// The AsyncStorage keys this record replaces. Copied in once and left in place:
// a build from before this record, reached by an OTA rollback, still reads them.
const LEGACY_PLAYLIST_TAGS_KEY = 'showPlaylistTagsOnClimbList';
const LEGACY_QUICK_ACTIONS_KEY = 'showClimbQuickActionsButton';

function readStored(): StoredClimbRowDisplay {
  return sanitiseStoredClimbRowDisplay(getSetting(SETTINGS_KEY));
}

let stored = readStored();
let display = resolveClimbRowDisplay(stored.overrides);
const listeners = new Set<() => void>();
// What the climber touched since launch. The legacy copy is asynchronous, so a
// choice made while it is in flight must not be replaced by the older value.
const changedThisLaunch = new Set<ClimbRowFieldId>();
let legacyMigration: Promise<void> | null = null;

/** Takes a record as the current one. Listeners hear about it only when a reader's answer moved. */
function adopt(next: StoredClimbRowDisplay): void {
  const nextDisplay = resolveClimbRowDisplay(next.overrides);
  const displayChanged = CLIMB_ROW_FIELD_IDS.some((fieldId) => nextDisplay[fieldId] !== display[fieldId]);
  const lastCustomChanged = (next.lastCustom === undefined) !== (stored.lastCustom === undefined);
  stored = next;
  if (displayChanged) display = nextDisplay;
  if (displayChanged || lastCustomChanged) for (const listener of listeners) listener();
}

/** One in-memory publish, then one write. */
function commit(next: StoredClimbRowDisplay): void {
  if (sameStoredClimbRowDisplay(next, stored)) return;
  adopt(next);
  setSetting(SETTINGS_KEY, next);
}

// The key can change underneath this module: `resetAllSettings` clears the whole
// store. The settings store signals every write without saying which key, so
// re-read this one and compare. That costs one small parse per settings write,
// of which there are a handful per session, and it is a no-op after our own
// `commit`, which has already adopted what it wrote.
subscribeSettings(() => {
  const persisted = readStored();
  if (!sameStoredClimbRowDisplay(persisted, stored)) adopt(persisted);
});

/**
 * Copies the two older AsyncStorage choices into the record, once per install.
 * Kicked at launch; never rejects.
 *
 * A rejected read (iOS denies the backing file on a background launch before
 * the first unlock) leaves the marker unset, so the copy is tried again by the
 * next reader that mounts and, failing that, on the next launch.
 */
export function ensureClimbRowLegacyMigrated(): Promise<void> {
  if (stored.legacyMigrated) return Promise.resolve();
  if (legacyMigration) return legacyMigration;
  const migration: Promise<void> = Promise.all([
    getPreference<unknown>(LEGACY_PLAYLIST_TAGS_KEY),
    getPreference<unknown>(LEGACY_QUICK_ACTIONS_KEY),
  ])
    .then(([playlistTags, quickActions]) => {
      if (legacyMigration !== migration) return;
      commit(withClimbRowLegacyChoices(stored, { playlistTags, quickActions }, changedThisLaunch));
    })
    .catch(() => {
      // Defaults stay usable and nothing is reported: this is expected on a
      // locked phone, and the retry is already arranged.
    })
    .finally(() => {
      if (legacyMigration === migration) legacyMigration = null;
    });
  legacyMigration = migration;
  return migration;
}

function subscribe(listener: () => void): () => void {
  // The retry for a legacy read that was rejected earlier this launch. One
  // boolean test per mount once the copy has happened, so rows can afford it.
  if (!stored.legacyMigrated) void ensureClimbRowLegacyMigrated();
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
  changedThisLaunch.add(fieldId);
  commit(withClimbRowField(stored, fieldId, value));
}

export function applyClimbRowPreset(presetId: ClimbRowPresetId): void {
  for (const fieldId of CLIMB_ROW_PRESET_FIELD_IDS) changedThisLaunch.add(fieldId);
  commit(withClimbRowPreset(stored, presetId));
}

export function restoreLastCustomClimbRow(): void {
  if (!stored.lastCustom) return;
  for (const fieldId of CLIMB_ROW_PRESET_FIELD_IDS) changedThisLaunch.add(fieldId);
  commit(withClimbRowLastCustomRestored(stored));
}

/** Back to a fresh install: no stored record, nothing changed, no copy in flight. */
export function resetClimbRowDisplayForTests(): void {
  changedThisLaunch.clear();
  legacyMigration = null;
  commit({ version: 1, overrides: {} });
}
