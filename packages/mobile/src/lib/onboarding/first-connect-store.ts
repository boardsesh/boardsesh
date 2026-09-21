// Persisted state for the connect-step test (#5654, PR 7), and the external
// store its surfaces read.
//
// Two records in AsyncStorage (via preference-store):
// - `firstConnectDevice`: what this phone has done with a board (first connect,
//   "no lights", how often the card and pill have shown). One per phone, kept
//   across sign-outs: it describes the phone and the wall, not the account, and
//   clearing it at sign-out would make a returning phone look brand new.
// - `firstConnectEnrolments`: each account's arm, written once at exposure, so
//   `First Run Exposed` fires once per account per phone. Keyed by account, so a
//   second climber on a shared phone gets their own entry and nothing carries
//   over; kept across sign-outs for the same once-per-account reason.
//
// Neither holds anything sensitive: an arm, timestamps, launch ids and dates.
//
// Surfaces read one snapshot through `useFirstConnectSnapshot`
// (useSyncExternalStore), so a write repaints only what reads it and never
// re-renders a provider tree.

import { useSyncExternalStore } from 'react';
import { getPreference, setPreference } from '../preference-store';
import { getStoredLastConnectedBoard } from '../ble/last-connected-board-store';
import { reportError } from '../error-reporting';
import { isConnectStepArm } from './connect-step-arm';
import {
  EMPTY_FIRST_CONNECT_DEVICE_STATE,
  type ConnectStepEnrolment,
  type FirstConnectDeviceState,
} from './first-connect-decision';

const DEVICE_STORAGE_KEY = 'firstConnectDevice';
const ENROLMENTS_STORAGE_KEY = 'firstConnectEnrolments';
/** A shared phone rarely sees more than two accounts; this only bounds the blob. */
const MAX_STORED_ENROLMENTS = 10;
/** Bounds the id and day lists; the decisions only ever need the first few. */
const MAX_STORED_ENTRIES = 10;

/** One id per JS process: "a session" for the card's two-launch limit. */
export const FIRST_CONNECT_LAUNCH_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export type FirstConnectSnapshot = {
  /** Null until the phone's state has been read (or seeded). */
  device: FirstConnectDeviceState | null;
  /** The signed-in account the host bound, or null. */
  userId: string | null;
  /** That account's enrolment, or null when it is not in the test. */
  enrolment: ConnectStepEnrolment | null;
  /** "Not now" on the Climbs card, for this launch only. */
  cardDismissedThisLaunch: boolean;
};

type StoredEnrolment = Omit<ConnectStepEnrolment, 'userId'>;
type StoredEnrolments = Record<string, StoredEnrolment>;

const INITIAL_SNAPSHOT: FirstConnectSnapshot = {
  device: null,
  userId: null,
  enrolment: null,
  cardDismissedThisLaunch: false,
};

let snapshot: FirstConnectSnapshot = INITIAL_SNAPSHOT;
const listeners = new Set<() => void>();
let deviceLoad: Promise<FirstConnectDeviceState> | null = null;
let writeChain: Promise<void> = Promise.resolve();

function publish(next: Partial<FirstConnectSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isDeviceState(value: unknown): value is FirstConnectDeviceState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isFiniteOrNull(record.connectedAt) &&
    isFiniteOrNull(record.noLightsAt) &&
    isFiniteOrNull(record.confirmationShownAt) &&
    isStringList(record.cardLaunchIds) &&
    isStringList(record.pillDays)
  );
}

function isStoredEnrolment(value: unknown): value is StoredEnrolment {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isConnectStepArm(record.arm) &&
    typeof record.forced === 'boolean' &&
    typeof record.exposedAt === 'number' &&
    Number.isFinite(record.exposedAt)
  );
}

/**
 * Serialised, so an older write can never land after a newer one. Rejects with
 * the write's own failure; the chain itself swallows it so one failed write
 * does not block the ones after it.
 */
function persist(key: string, value: unknown): Promise<void> {
  const write = writeChain.then(() => setPreference(key, value));
  writeChain = write.catch(() => undefined);
  return write;
}

/**
 * First read of this phone's state. With nothing stored yet, it is SEEDED from
 * the remembered board: a phone that already keeps a board for a one-tap
 * reconnect has connected before (`connectedAt: 0`), so a returning climber
 * never lands in the treatment. Only the read of that store is used; nothing
 * under `lib/ble/` changes.
 */
async function readOrSeedDevice(): Promise<FirstConnectDeviceState> {
  const stored = await getPreference<unknown>(DEVICE_STORAGE_KEY);
  if (isDeviceState(stored)) return stored;
  let remembered = false;
  try {
    remembered = (await getStoredLastConnectedBoard()) !== null;
  } catch {
    // Unreadable: treat it as not remembered. The worst case is a returning
    // phone counted as new, which the next connect corrects.
    remembered = false;
  }
  const seeded: FirstConnectDeviceState = { ...EMPTY_FIRST_CONNECT_DEVICE_STATE, connectedAt: remembered ? 0 : null };
  void persist(DEVICE_STORAGE_KEY, seeded).catch(() => {});
  return seeded;
}

/**
 * This phone's CURRENT state, read from storage once per process and from
 * memory after that. A failed read is not cached, so the next caller retries (a
 * storage read can fail before first unlock).
 */
export async function loadFirstConnectDevice(): Promise<FirstConnectDeviceState> {
  if (!deviceLoad) {
    deviceLoad = readOrSeedDevice().then(
      (device) => {
        if (snapshot.device === null) publish({ device });
        return device;
      },
      (error: unknown) => {
        deviceLoad = null;
        throw error;
      },
    );
  }
  const loaded = await deviceLoad;
  // Anything written since the read lives in the snapshot, not the promise.
  return snapshot.device ?? loaded;
}

async function updateDevice(
  change: (device: FirstConnectDeviceState) => FirstConnectDeviceState | null,
): Promise<FirstConnectDeviceState | null> {
  let before: FirstConnectDeviceState;
  try {
    before = await loadFirstConnectDevice();
  } catch (error: unknown) {
    reportError(error);
    return null;
  }
  const current = snapshot.device ?? before;
  const next = change(current);
  if (next === null || next === current) return current;
  publish({ device: next });
  // The in-memory state already moved, so this launch behaves either way; a
  // failed write only costs the next launch this change.
  await persist(DEVICE_STORAGE_KEY, next).catch(reportError);
  return current;
}

function appendCapped(list: readonly string[], entry: string): string[] {
  if (list.includes(entry)) return [...list];
  return [...list, entry].slice(-MAX_STORED_ENTRIES);
}

/**
 * Records this phone's first successful connect. Returns the state from BEFORE
 * the write, which is what the confirmation decides on, or null when the state
 * could not be read.
 */
export function markFirstConnectPhoneConnected(atMs: number): Promise<FirstConnectDeviceState | null> {
  return updateDevice((device) => (device.connectedAt === null ? { ...device, connectedAt: atMs } : null));
}

/** "This wall has no lights": permanent on this phone. Never touches the board's `hasLeds`. */
export function markFirstConnectNoLights(atMs: number): Promise<FirstConnectDeviceState | null> {
  return updateDevice((device) => (device.noLightsAt === null ? { ...device, noLightsAt: atMs } : null));
}

export function markFirstConnectConfirmationShown(atMs: number): Promise<FirstConnectDeviceState | null> {
  return updateDevice((device) =>
    device.confirmationShownAt === null ? { ...device, confirmationShownAt: atMs } : null,
  );
}

export function recordFirstConnectCardLaunch(launchId: string): Promise<FirstConnectDeviceState | null> {
  return updateDevice((device) =>
    device.cardLaunchIds.includes(launchId)
      ? null
      : { ...device, cardLaunchIds: appendCapped(device.cardLaunchIds, launchId) },
  );
}

export function recordFirstConnectPillDay(day: string): Promise<FirstConnectDeviceState | null> {
  return updateDevice((device) =>
    device.pillDays.includes(day) ? null : { ...device, pillDays: appendCapped(device.pillDays, day) },
  );
}

/**
 * QA only: forget everything this phone did, so a forced arm starts from a
 * clean slate even on a phone that has connected before. Not seeded again.
 */
export async function resetFirstConnectDeviceForQa(): Promise<void> {
  await updateDevice(() => ({ ...EMPTY_FIRST_CONNECT_DEVICE_STATE }));
  publish({ cardDismissedThisLaunch: false });
}

/** "Not now" on the card: gone for this launch, back on the next (within its two). */
export function dismissFirstConnectCardForLaunch(): void {
  if (snapshot.cardDismissedThisLaunch) return;
  publish({ cardDismissedThisLaunch: true });
}

async function readEnrolments(): Promise<StoredEnrolments> {
  const stored = await getPreference<unknown>(ENROLMENTS_STORAGE_KEY);
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  const valid: StoredEnrolments = {};
  for (const [userId, entry] of Object.entries(stored as Record<string, unknown>)) {
    if (isStoredEnrolment(entry)) valid[userId] = entry;
  }
  return valid;
}

/** The account's enrolment on this phone. Throws when storage cannot be read. */
export async function readConnectStepEnrolment(userId: string): Promise<ConnectStepEnrolment | null> {
  const enrolments = await readEnrolments();
  const entry = enrolments[userId];
  return entry ? { userId, ...entry } : null;
}

/** Writes the account's enrolment and, when that account is signed in, publishes it. */
export async function writeConnectStepEnrolment(enrolment: ConnectStepEnrolment): Promise<void> {
  const enrolments = await readEnrolments();
  const { userId, ...entry } = enrolment;
  const next: StoredEnrolments = { ...enrolments, [userId]: entry };
  const keys = Object.keys(next);
  // Oldest exposures go first once the blob is full.
  if (keys.length > MAX_STORED_ENROLMENTS) {
    keys
      .filter((key) => key !== userId)
      .sort((left, right) => (next[left]?.exposedAt ?? 0) - (next[right]?.exposedAt ?? 0))
      .slice(0, keys.length - MAX_STORED_ENROLMENTS)
      .forEach((key) => {
        delete next[key];
      });
  }
  await persist(ENROLMENTS_STORAGE_KEY, next);
  if (snapshot.userId === userId) publish({ enrolment });
}

/** Drops the account's enrolment (a forced arm the QA override no longer asks for). */
export async function dropConnectStepEnrolment(userId: string): Promise<void> {
  const enrolments = await readEnrolments();
  if (!(userId in enrolments)) return;
  const next = { ...enrolments };
  delete next[userId];
  await persist(ENROLMENTS_STORAGE_KEY, next);
  if (snapshot.userId === userId) publish({ enrolment: null });
}

/**
 * Binds the store to the signed-in account (`FirstConnectHost`, on every
 * profile change) and loads that account's enrolment. `null` on sign-out.
 * Resolves with the enrolment it published.
 */
export async function bindFirstConnectAccount(userId: string | null): Promise<ConnectStepEnrolment | null> {
  if (snapshot.userId !== userId) publish({ userId, enrolment: null });
  void loadFirstConnectDevice().catch(reportError);
  if (userId === null) return null;
  let enrolment: ConnectStepEnrolment | null = null;
  try {
    enrolment = await readConnectStepEnrolment(userId);
  } catch (error: unknown) {
    reportError(error);
    return null;
  }
  // A later bind (an account switch mid-read) wins.
  if (snapshot.userId !== userId) return null;
  // An enrolment written while this read was in flight is already published.
  if (snapshot.enrolment === null) publish({ enrolment });
  return snapshot.enrolment;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): FirstConnectSnapshot {
  return snapshot;
}

export function getFirstConnectSnapshot(): FirstConnectSnapshot {
  return snapshot;
}

export function useFirstConnectSnapshot(): FirstConnectSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only: back to a fresh process. */
export function resetFirstConnectStoreForTests(): void {
  if (process.env.NODE_ENV !== 'test') return;
  snapshot = INITIAL_SNAPSHOT;
  deviceLoad = null;
  writeChain = Promise.resolve();
  for (const listener of listeners) listener();
}
