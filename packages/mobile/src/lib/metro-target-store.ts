import * as SecureStore from 'expo-secure-store';
import { normalizeMetroTarget } from './metro-discovery';

const METRO_TARGETS_KEY = 'boardsesh_dev_metro_hosts';
const MAX_TARGETS = 20;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

type StoredTargets = { ok: true; targets: string[] } | { ok: false };

async function readStoredTargets(): Promise<StoredTargets> {
  const value = await SecureStore.getItemAsync(METRO_TARGETS_KEY);
  if (!value) return { ok: true, targets: [] };
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isStringArray(parsed)) {
      if (__DEV__) {
        console.warn('[metro-target-store] stored value is not a string array; leaving raw value intact');
      }
      return { ok: false };
    }
    const normalized = Array.from(
      new Set(parsed.map(normalizeMetroTarget).filter((target): target is string => target !== null)),
    );
    return { ok: true, targets: normalized };
  } catch (err) {
    if (__DEV__) {
      console.warn('[metro-target-store] JSON parse failed; leaving raw value intact', err);
    }
    return { ok: false };
  }
}

// Serializes read-modify-write paths so two parallel add/remove calls don't
// race on SecureStore. Reads also go through the queue so a write's
// pre-read sees the post-state of a prior write.
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task);
  // Swallow rejections on the chain so a failed write doesn't poison every
  // subsequent enqueue, but still propagate the result/error to the caller
  // via `next`.
  writeQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function getSavedMetroTargets(): Promise<string[]> {
  return enqueue(async () => {
    const stored = await readStoredTargets();
    return stored.ok ? stored.targets : [];
  });
}

export async function addSavedMetroTarget(value: string): Promise<string> {
  const normalizedTarget = normalizeMetroTarget(value);
  if (!normalizedTarget) {
    throw new Error('Enter a host or an http://host:port URL');
  }

  return enqueue(async () => {
    const stored = await readStoredTargets();
    // Refuse to overwrite a raw value we couldn't parse — otherwise a single
    // corrupted store silently wipes the user's list on the next add.
    if (!stored.ok) {
      throw new Error('Saved Metro server list is corrupted — clear it from app data and retry');
    }
    const updatedTargets = [normalizedTarget, ...stored.targets.filter((target) => target !== normalizedTarget)].slice(
      0,
      MAX_TARGETS,
    );

    await SecureStore.setItemAsync(METRO_TARGETS_KEY, JSON.stringify(updatedTargets));
    return normalizedTarget;
  });
}

export async function removeSavedMetroTarget(value: string): Promise<void> {
  // Stored entries are normalized on write (see addSavedMetroTarget +
  // readStoredTargets), so we have to normalize the incoming value too —
  // otherwise a caller passing the raw user-typed form ('HOST-A.example')
  // would silently no-op against a stored entry ('host-a.example').
  const normalizedValue = normalizeMetroTarget(value) ?? value;
  return enqueue(async () => {
    const stored = await readStoredTargets();
    // Same rule as add: don't overwrite an unparseable stored value.
    if (!stored.ok) {
      throw new Error('Saved Metro server list is corrupted — clear it from app data and retry');
    }
    const updatedTargets = stored.targets.filter((target) => target !== normalizedValue);
    await SecureStore.setItemAsync(METRO_TARGETS_KEY, JSON.stringify(updatedTargets));
  });
}
