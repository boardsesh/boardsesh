import { useSyncExternalStore } from 'react';
import { getSetting, setSetting, subscribeSettings } from '../settings/hooks';
import { getPreference, removePreference, setPreference } from './preference-store';
import {
  CLIMB_ROW_FIELD_IDS,
  CLIMB_ROW_LEGACY_FIELD_IDS,
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

// One call to that storage is given up on after this long. The calls run one
// after another, so one that never answered would hold up every later one for
// the rest of the session.
const LEGACY_STORAGE_TIMEOUT_MS = 10_000;

const NO_RECORD: StoredClimbRowDisplay = Object.freeze({ version: 1, overrides: Object.freeze({}) });

function readOnPhone(): StoredClimbRowDisplay | null {
  const persisted = getSetting(SETTINGS_KEY);
  return persisted === null ? null : sanitiseStoredClimbRowDisplay(persisted);
}

// The record as this module last SAW it on the phone: at import, before each
// change and straight after each write. `null` while it has seen none. Kept
// apart from what is in memory, because the two can differ and each way means
// something else: a write that did not stick leaves memory ahead, and a record
// the import-time read missed leaves the phone ahead.
let seenOnPhone = readOnPhone();
let stored = seenOnPhone ?? NO_RECORD;
let display = resolveClimbRowDisplay(stored.overrides);
const listeners = new Set<() => void>();
let legacySynced = false;
let legacySync: Promise<void> | null = null;
// Everything that touches the old keys runs one after another, so a read cannot
// land between a write and the baseline that write sets.
let legacyQueue: Promise<void> = Promise.resolve();
// Per old key, the newest write waiting in that queue, so a value already on its
// way is not queued a second time.
const queuedMirrors = new Map<ClimbRowLegacyFieldId, { value: boolean }>();
// Bumped by the test reset, so work still in flight cannot land in the next test.
let generation = 0;
let writing = false;

function ignore(): void {}

/** Takes a record as the current one. Listeners hear about it only when a reader's answer moved. */
function adopt(next: StoredClimbRowDisplay): void {
  const nextDisplay = resolveClimbRowDisplay(next.overrides);
  const displayChanged = CLIMB_ROW_FIELD_IDS.some((fieldId) => nextDisplay[fieldId] !== display[fieldId]);
  const lastCustomChanged = (next.lastCustom === undefined) !== (stored.lastCustom === undefined);
  stored = next;
  if (displayChanged) display = nextDisplay;
  if (displayChanged || lastCustomChanged) for (const listener of listeners) listener();
}

function write(record: StoredClimbRowDisplay | null): void {
  // The settings store signals our own write like any other; there is nothing to
  // learn from that signal.
  writing = true;
  try {
    setSetting(SETTINGS_KEY, record);
  } catch {
    // The settings store throws when its file cannot be written (it stays that
    // way for the rest of the launch once the file could not be opened). That is
    // a write that did not stick, not a fault: the choice stands in memory, and
    // what is owed to the old keys still goes out.
  } finally {
    writing = false;
  }
  // Look at what stuck instead of assuming. After a write that was lost this
  // stays what it was, which is how memory is known to be ahead.
  seenOnPhone = readOnPhone();
}

/**
 * Looks at the phone and takes what is news there. Memory is never judged
 * against the phone directly, only against what was last seen on it:
 *
 * - The same as last seen: nothing happened. Memory stands, also when it is
 *   ahead because a write did not stick.
 * - A record that was not there, or has changed: the read at import missed it
 *   (it can come back empty while a record exists). It becomes the current one,
 *   so nothing is built on the empty read and written over it.
 * - A record that was seen and is gone: every setting was reset
 *   (`resetAllSettings` clears the whole store). That is a choice by the
 *   climber, and is applied and written back as one.
 * - No record, and none seen before: a fresh install, or a first write that did
 *   not stick. Not a reset; memory stands.
 */
function syncWithPhone(): void {
  const onPhone = readOnPhone();
  if (onPhone === null) {
    if (seenOnPhone === null) return;
    resetChoices();
    return;
  }
  if (seenOnPhone !== null && sameStoredClimbRowDisplay(onPhone, seenOnPhone)) return;
  seenOnPhone = onPhone;
  if (!sameStoredClimbRowDisplay(onPhone, stored)) adopt(onPhone);
}

/** Reset also withdraws choices whose first persistent write never succeeded. */
function resetChoices(): void {
  const reset = withClimbRowDisplayReset(stored);
  if (!sameStoredClimbRowDisplay(reset, stored)) adopt(reset);
  write(reset);
  flushLegacyPending();
}

/**
 * A change on top of what is on the phone now: one in-memory publish, then one
 * write. The write happens whenever the result is not what the phone holds, so a
 * change after a lost write carries the lost one with it.
 */
function mutate(change: (current: StoredClimbRowDisplay) => StoredClimbRowDisplay): void {
  syncWithPhone();
  const next = change(stored);
  if (!sameStoredClimbRowDisplay(next, stored)) adopt(next);
  if (!sameStoredClimbRowDisplay(next, seenOnPhone ?? NO_RECORD)) write(next);
}

// The settings store signals every write without saying which key, so look at
// this one each time. That is one small parse per settings write, of which there
// are a handful per session.
subscribeSettings((change) => {
  if (change?.kind === 'reset') resetChoices();
  else if (!writing) syncWithPhone();
});

type LegacyStorageOutcome<Result> = { completed: true; result: Result } | { completed: false };

/**
 * One call to the old keys' storage. It can fail (iOS denies the backing file on
 * a background launch before the first unlock) and it can never answer; both are
 * expected, both come back as not completed, and neither is an error. This is
 * the only place such a failure is caught, so a fault in this module's own code
 * is never mistaken for one.
 */
function callLegacyStorage<Result>(call: () => Promise<Result>): Promise<LegacyStorageOutcome<Result>> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ completed: false });
    }, LEGACY_STORAGE_TIMEOUT_MS);
    call().then(
      (result) => {
        clearTimeout(timeout);
        resolve({ completed: true, result });
      },
      () => {
        clearTimeout(timeout);
        resolve({ completed: false });
      },
    );
  });
}

/**
 * Runs a task after the ones queued before it. The queue moves on whatever
 * happened to a task, but the promise handed back still rejects when the task
 * threw: storage failures never reach here (`callLegacyStorage` turns them into
 * an outcome), so a rejection is a fault in our own code and must stay visible.
 */
function enqueueLegacyStorage(task: () => Promise<void>): Promise<void> {
  const run = legacyQueue.then(task);
  legacyQueue = run.then(ignore, ignore);
  return run;
}

/** Writes a pending value to its old key and, once it has landed, records that the key holds it. */
function queueMirror(fieldId: ClimbRowLegacyFieldId, value: boolean): void {
  const startedIn = generation;
  const queued = { value };
  queuedMirrors.set(fieldId, queued);
  void enqueueLegacyStorage(async () => {
    try {
      // A newer choice has replaced this one while it waited: its own write is
      // queued behind, and this one would only put a stale value on disk.
      if (startedIn !== generation || stored.legacyPending?.[fieldId] !== value) return;
      const written = await callLegacyStorage(() => setPreference(LEGACY_STORAGE_KEYS[fieldId], value));
      if (startedIn !== generation || !written.completed) return;
      mutate((current) => withClimbRowLegacyMirrored(current, fieldId, value));
    } finally {
      if (queuedMirrors.get(fieldId) === queued) queuedMirrors.delete(fieldId);
    }
  });
}

/** Queues a write for every pending value that has none on its way yet. */
function flushLegacyPending(): void {
  for (const fieldId of CLIMB_ROW_LEGACY_FIELD_IDS) {
    const value = stored.legacyPending?.[fieldId];
    if (value !== undefined && queuedMirrors.get(fieldId)?.value !== value) queueMirror(fieldId, value);
  }
}

/**
 * A choice the climber made here. The record it produces already names what is
 * owed to the old keys, and is written before any of that is attempted.
 */
function decide(change: (current: StoredClimbRowDisplay) => StoredClimbRowDisplay): void {
  mutate(change);
  flushLegacyPending();
}

/**
 * Reads the two old keys and reconciles them with the record, once per launch.
 * Kicked at launch. A storage failure never rejects it.
 *
 * Every launch, not once per install: an older build can have changed a key
 * since this one last ran (a tester back from a preview), and that only shows as
 * a difference from the stored baseline. It is also where a write to an old key
 * that failed, or was cut off, is found and made again.
 *
 * A read that fails or never answers changes nothing and leaves the launch
 * unsynced, so it is tried again by the next reader that mounts and, failing
 * that, on the next launch.
 */
export function ensureClimbRowLegacySynced(): Promise<void> {
  if (legacySynced) return Promise.resolve();
  if (legacySync) return legacySync;
  const startedIn = generation;
  const sync: Promise<void> = enqueueLegacyStorage(async () => {
    if (startedIn !== generation) return;
    const read = await callLegacyStorage(() =>
      Promise.all([
        getPreference<unknown>(LEGACY_STORAGE_KEYS.playlistTags),
        getPreference<unknown>(LEGACY_STORAGE_KEYS.quickActions),
      ]),
    );
    if (startedIn !== generation || !read.completed) return;
    const [playlistTags, quickActions] = read.result;
    mutate((current) => withClimbRowLegacyRead(current, { playlistTags, quickActions }));
    legacySynced = true;
    flushLegacyPending();
  }).finally(() => {
    if (legacySync === sync) legacySync = null;
  });
  legacySync = sync;
  return sync;
}

function subscribe(listener: () => void): () => void {
  // The retry for a read of the old keys that failed earlier this launch. One
  // boolean test per mount once it has succeeded, so rows can afford it.
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
  decide((current) => withClimbRowField(current, fieldId, value));
}

export function applyClimbRowPreset(presetId: ClimbRowPresetId): void {
  decide((current) => withClimbRowPreset(current, presetId));
}

export function restoreLastCustomClimbRow(): void {
  decide(withClimbRowLastCustomRestored);
}

/**
 * A fresh install, for suites that import this module statically: no record,
 * nothing in the two old keys, and nothing from before the call able to land
 * after it. What was queued is dropped before it writes; what was already
 * writing has landed by now and is removed with the keys.
 *
 * The next read of the old keys waits for that removal. A suite that exercises
 * the launch read fills the keys AFTER this call, or takes a module that has
 * never run with `vi.resetModules()` and a fresh import.
 */
export function resetClimbRowDisplayForTests(): void {
  generation += 1;
  legacySynced = false;
  legacySync = null;
  queuedMirrors.clear();
  legacyQueue = Promise.all(Object.values(LEGACY_STORAGE_KEYS).map((key) => removePreference(key))).then(
    ignore,
    ignore,
  );
  adopt(NO_RECORD);
  write(null);
}
