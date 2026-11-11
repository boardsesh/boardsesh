import {
  DEFAULT_LED_BRIGHTNESS,
  LED_CONTROLLER_TYPES,
  resolveLedLightingOptions,
  type LedControllerType,
} from '@boardsesh/led-controller';
import { removePreference, removePreferencesMatching } from '../preference-store';

export type SprayWallLedSettings = {
  version: 1;
  enabled: boolean;
  /** `ble` reaches the controller over Bluetooth; `url` then stays as the Wi-Fi address, unused. */
  controller: { type: LedControllerType; url: string };
  /** WLED master brightness, 1–255, shared by every phone at the wall. */
  brightness: number;
  /** Minutes after the last lighting before the controller turns the wall off; 0 never does. */
  autoOffMinutes: number;
};

export type SprayWallLedField = 'settings' | 'layout';

/**
 * The phone's copy of a wall's LED setup. The server is the source of truth
 * (`spray-wall-led-sync`); this copy is what lights the wall with no internet.
 * Kept apart from the sync so a screen can subscribe without pulling in the
 * network client.
 */
export const sprayWallLedSettingsKey = (wallUuid: string) => `sprayWallLedSettings:${wallUuid}`;
export const sprayWallLedLayoutKey = (wallUuid: string) => `sprayWallTnutLayout:${wallUuid}`;
/** This phone's Bluetooth controller for the wall. Never uploaded: iOS ids differ per phone. */
export const sprayWallLedBleDeviceKey = (wallUuid: string) => `sprayWallLedBleDevice:${wallUuid}`;
/** Set before a save writes the copy, and cleared once the server has it. */
export const sprayWallLedUnsentKey = (field: SprayWallLedField, wallUuid: string) =>
  `sprayWallLedUnsent:${field}:${wallUuid}`;

const CACHE_KEY_PREFIXES = [
  'sprayWallLedSettings:',
  'sprayWallTnutLayout:',
  'sprayWallLedUnsent:',
  'sprayWallLedBleDevice:',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fail closed on future versions or corruption; never replace them with defaults. */
export function readSprayWallLedSettings(stored: unknown): SprayWallLedSettings {
  if (stored === null)
    return {
      version: 1,
      enabled: false,
      controller: { type: 'wled', url: '' },
      brightness: DEFAULT_LED_BRIGHTNESS,
      autoOffMinutes: 0,
    };
  if (
    !isRecord(stored) ||
    stored.version !== 1 ||
    typeof stored.enabled !== 'boolean' ||
    !isRecord(stored.controller) ||
    !(LED_CONTROLLER_TYPES as readonly unknown[]).includes(stored.controller.type) ||
    typeof stored.controller.url !== 'string' ||
    (stored.brightness !== undefined && typeof stored.brightness !== 'number') ||
    (stored.autoOffMinutes !== undefined && typeof stored.autoOffMinutes !== 'number')
  ) {
    throw new Error('Invalid spray wall LED settings');
  }
  // A copy saved before brightness and auto-off existed reads with the defaults.
  const lighting = resolveLedLightingOptions({
    brightness: stored.brightness as number | undefined,
    autoOffMinutes: stored.autoOffMinutes as number | undefined,
  });
  return {
    version: 1,
    enabled: stored.enabled,
    controller: { type: stored.controller.type as LedControllerType, url: stored.controller.url },
    brightness: lighting.brightness,
    autoOffMinutes: lighting.autoOffMinutes,
  };
}

// ============================================
// Events a screen listens to
// ============================================

export type SprayWallLedUploadOutcome = 'uploaded' | 'failed';

const uploadOutcomeListeners = new Set<(wallUuid: string, outcome: SprayWallLedUploadOutcome) => void>();

/** Whether the newest save for a wall reached the server. A failed one stays unsent and retries on the next load. */
export function subscribeSprayWallLedUploadOutcome(
  listener: (wallUuid: string, outcome: SprayWallLedUploadOutcome) => void,
): () => void {
  uploadOutcomeListeners.add(listener);
  return () => uploadOutcomeListeners.delete(listener);
}

export function notifySprayWallLedUploadOutcome(wallUuid: string, outcome: SprayWallLedUploadOutcome): void {
  for (const listener of uploadOutcomeListeners) listener(wallUuid, outcome);
}

const serverChangeListeners = new Set<(wallUuid: string) => void>();

/** The server's copy replaced this phone's. Only then does a screen need to read again. */
export function subscribeSprayWallLedServerChange(listener: (wallUuid: string) => void): () => void {
  serverChangeListeners.add(listener);
  return () => serverChangeListeners.delete(listener);
}

export function notifySprayWallLedServerChange(wallUuid: string): void {
  for (const listener of serverChangeListeners) listener(wallUuid);
}

const erasureListeners = new Set<(wallUuid: string | null) => void>();

/** Called with the wall, or null for all of them. The sync drops its in-memory state. */
export function subscribeSprayWallLedCacheErased(listener: (wallUuid: string | null) => void): () => void {
  erasureListeners.add(listener);
  return () => erasureListeners.delete(listener);
}

// All cache writes and erasures share one lane per wall. A global erasure also
// blocks newly queued writes until every old lane has drained and been erased.
const cacheWrites = new Map<string, Promise<unknown>>();
let globalErasure: Promise<unknown> = Promise.resolve();
let accountGeneration = 0;
const wallErasureGenerations = new Map<string, number>();

export function sprayWallLedCacheGeneration(wallUuid: string): string {
  return `${accountGeneration}:${wallErasureGenerations.get(wallUuid) ?? 0}`;
}

export function serializeSprayWallLedCacheWrite<Result>(
  wallUuid: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const preceding = cacheWrites.get(wallUuid) ?? Promise.resolve();
  const pending = Promise.allSettled([preceding, globalErasure]).then(operation);
  cacheWrites.set(wallUuid, pending);
  void pending
    .finally(() => {
      if (cacheWrites.get(wallUuid) === pending) cacheWrites.delete(wallUuid);
    })
    .catch(() => undefined);
  return pending;
}

// ============================================
// Forgetting the copy
// ============================================

/**
 * A wall this viewer can no longer read (`subscribeToSprayWallWithdrawals`) must
 * not stay on the phone, and neither must a save it can no longer send.
 * Storage failures are swallowed: this runs from a sign-out and a registry
 * withdrawal, neither of which may throw.
 */
export async function eraseSprayWallLedCache(wallUuid: string): Promise<void> {
  wallErasureGenerations.set(wallUuid, (wallErasureGenerations.get(wallUuid) ?? 0) + 1);
  for (const listener of erasureListeners) listener(wallUuid);
  await serializeSprayWallLedCacheWrite(wallUuid, () =>
    Promise.allSettled([
      removePreference(sprayWallLedSettingsKey(wallUuid)),
      removePreference(sprayWallLedLayoutKey(wallUuid)),
      removePreference(sprayWallLedBleDeviceKey(wallUuid)),
      removePreference(sprayWallLedUnsentKey('settings', wallUuid)),
      removePreference(sprayWallLedUnsentKey('layout', wallUuid)),
    ]),
  );
}

/** Sign-out and account changes: the next climber on this phone starts from the server. */
export async function eraseAllSprayWallLedCaches(): Promise<void> {
  accountGeneration += 1;
  for (const listener of erasureListeners) listener(null);
  const pendingWrites = [...cacheWrites.values(), globalErasure];
  const clearing = Promise.allSettled(pendingWrites).then(async () => {
    try {
      await removePreferencesMatching((key) => CACHE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)));
    } catch {
      // A locked store must not stop sign-out.
    }
  });
  globalErasure = clearing;
  await clearing;
}
