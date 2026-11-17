import { useEffect, useState, useSyncExternalStore } from 'react';
import * as Application from 'expo-application';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import * as Updates from 'expo-updates';
import { getPreference, setPreference } from '../preference-store';
import { createGpuFailureStore } from './gpu-failure-store-core';

const STORAGE_KEY = 'auraGpuFailedConfigs.v1';
const stores = new Map<number, ReturnType<typeof createGpuFailureStore>>();
function failureStore(apiVersion: number) {
  const cached = stores.get(apiVersion);
  if (cached) return cached;
  // The running JS bundle is part of the identity: an OTA can fix what made a
  // config fail, so a new update starts with no remembered failures.
  const binaryParts = [
    process.env.EXPO_OS ?? 'native',
    Application.applicationId,
    Application.nativeApplicationVersion,
    Application.nativeBuildVersion,
    apiVersion,
    Updates.updateId ?? 'embedded',
  ];
  // Read the API from the visible board. Importing its native view manager
  // here would initialize it for every thumbnail that imports the render hook.
  const persistentIdentity =
    binaryParts.slice(0, 4).every((part) => typeof part === 'string' && part.trim().length > 0) &&
    Number.isSafeInteger(apiVersion) &&
    apiVersion > 0;
  const created = createGpuFailureStore({
    binaryIdentity: JSON.stringify(binaryParts),
    read: () => (persistentIdentity ? getPreference<unknown>(STORAGE_KEY) : Promise.resolve(null)),
    write: (record) => (persistentIdentity ? setPreference(STORAGE_KEY, record) : Promise.resolve()),
  });
  stores.set(apiVersion, created);
  return created;
}

// These keys never leave the device. Retain at most eight configuration strings.
const hashes = new Map<string, { pending: Promise<string>; resolved?: string }>();
function configHash(configJson: string): Promise<string> {
  const cached = hashes.get(configJson);
  if (cached) return cached.pending;
  const entry: { pending: Promise<string>; resolved?: string } = {
    pending: digestStringAsync(CryptoDigestAlgorithm.SHA256, configJson),
  };
  hashes.set(configJson, entry);
  if (hashes.size > 8) hashes.delete(hashes.keys().next().value!);
  void entry.pending.then(
    (digest) => {
      entry.resolved = digest;
    },
    () => {
      if (hashes.get(configJson) === entry) hashes.delete(configJson);
    },
  );
  return entry.pending;
}

function withConfigHash(configJson: string, action: (hash: string) => void): void {
  const resolved = hashes.get(configJson)?.resolved;
  if (resolved) {
    action(resolved);
    return;
  }
  void configHash(configJson).then(action, () => {});
}

// A missed presentation deadline never reaches storage: it can be a slow phone
// or a view that left the screen. Two in a row for one config still mean every
// climb change waits out another deadline, so that config uses PNG until the
// JS runtime restarts. A relaunch or an OTA tries the GPU again.
const SESSION_TIMEOUT_STRIKES = 2;
const MAX_SESSION_ENTRIES = 64;
const timeoutStrikes = new Map<string, number>();
let sessionBlocked: ReadonlySet<string> = new Set();
const sessionListeners = new Set<() => void>();
function subscribeSessionBlocked(listener: () => void) {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}
const getSessionBlocked = () => sessionBlocked;

export function recordGpuPresentationTimeout(configJson: string): void {
  withConfigHash(configJson, (hash) => {
    if (sessionBlocked.has(hash)) return;
    const strikes = (timeoutStrikes.get(hash) ?? 0) + 1;
    timeoutStrikes.delete(hash);
    if (strikes < SESSION_TIMEOUT_STRIKES) {
      timeoutStrikes.set(hash, strikes);
      if (timeoutStrikes.size > MAX_SESSION_ENTRIES) timeoutStrikes.delete(timeoutStrikes.keys().next().value!);
      return;
    }
    const blocked = new Set(sessionBlocked).add(hash);
    if (blocked.size > MAX_SESSION_ENTRIES) blocked.delete(blocked.values().next().value!);
    sessionBlocked = blocked;
    for (const listener of sessionListeners) listener();
  });
}

/** A presented frame proves the config can draw; its timeout count starts over. */
export function recordGpuPresented(configJson: string): void {
  if (timeoutStrikes.size === 0) return;
  withConfigHash(configJson, (hash) => timeoutStrikes.delete(hash));
}

export type GpuFailureStatus = 'loading' | 'allowed' | 'blocked' | 'unavailable';

/** Do not retry a known broken configuration while its saved latch is loading. */
export function useGpuFailureStatus(configJson: string | null, apiVersion: number): GpuFailureStatus {
  const store = failureStore(apiVersion);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const blockedThisSession = useSyncExternalStore(subscribeSessionBlocked, getSessionBlocked, getSessionBlocked);
  const [checked, setChecked] = useState<{ configJson: string; hash: string | null } | null>(null);
  useEffect(() => {
    if (!configJson) return;
    let cancelled = false;
    void Promise.all([store.hydrate(), configHash(configJson)]).then(
      ([, hash]) => {
        if (!cancelled) setChecked({ configJson, hash });
      },
      () => {
        if (!cancelled) setChecked({ configJson, hash: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [configJson, store]);
  if (!configJson) return 'allowed';
  const hash = hashes.get(configJson)?.resolved ?? (checked?.configJson === configJson ? checked.hash : undefined);
  if (!snapshot.hydrated || hash === undefined) return 'loading';
  if (snapshot.unavailable || hash === null) return 'unavailable';
  return snapshot.keys.has(hash) || blockedThisSession.has(hash) ? 'blocked' : 'allowed';
}

export function recordGpuConfigFailure(configJson: string, apiVersion: number): void {
  const store = failureStore(apiVersion);
  withConfigHash(configJson, (hash) => store.record(hash));
}
