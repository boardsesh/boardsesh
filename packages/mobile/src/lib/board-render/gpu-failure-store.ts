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

export type GpuFailureStatus = 'loading' | 'allowed' | 'blocked' | 'unavailable';

/** Do not retry a known broken configuration while its saved latch is loading. */
export function useGpuFailureStatus(configJson: string | null, apiVersion: number): GpuFailureStatus {
  const store = failureStore(apiVersion);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
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
  return snapshot.keys.has(hash) ? 'blocked' : 'allowed';
}

export function recordGpuConfigFailure(configJson: string, apiVersion: number): void {
  const store = failureStore(apiVersion);
  const resolved = hashes.get(configJson)?.resolved;
  if (resolved) {
    store.record(resolved);
    return;
  }
  void configHash(configJson).then(
    (hash) => store.record(hash),
    () => {},
  );
}
