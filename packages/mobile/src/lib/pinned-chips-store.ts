import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';
import { DEFAULT_PINNED_CHIPS, normalizePinnedChips, type PinnableChipKind } from './pinnable-chips';

// Which filter chips the user has pinned to the persistent chip row. A non-secret
// UI-layout preference → AsyncStorage via preference-store (NOT SecureStore).
// Device-global, like grade-format-preference: it's a layout choice, not per-user
// sensitive data, so no auth-provider sign-out cleanup is needed. Auth-gated chips
// (progress) just hide at render when signed out; the pin persists.
//
// Reactivity mirrors grade-format-preference.ts exactly: a module-level singleton
// with useSyncExternalStore so every mounted consumer (chip row, sheet pin
// toggles, token dedup) re-renders live on pin/unpin, sharing ONE load + ONE
// subscription. `snapshot` is rebuilt only in notify() so getSnapshot stays
// referentially stable across renders.
export const STORAGE_KEY = 'pinnedFilterChips';

type PinnedChipsSnapshot = { pinned: readonly PinnableChipKind[]; loaded: boolean };

let current: readonly PinnableChipKind[] = DEFAULT_PINNED_CHIPS;
let hasLoaded = false;
let snapshot: PinnedChipsSnapshot = { pinned: current, loaded: hasLoaded };
const listeners = new Set<() => void>();

const SERVER_SNAPSHOT: PinnedChipsSnapshot = { pinned: DEFAULT_PINNED_CHIPS, loaded: false };

function notify(): void {
  snapshot = { pinned: current, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

async function persist(kinds: readonly PinnableChipKind[]): Promise<void> {
  await setPreference(STORAGE_KEY, kinds);
}

export async function loadPinnedChips(): Promise<readonly PinnableChipKind[]> {
  if (hasLoaded) return current;
  const stored = await getPreference<unknown[]>(STORAGE_KEY);
  // A togglePinnedChip may have raced in while we awaited storage — honour the
  // user's choice rather than clobbering it with the (now stale) persisted value.
  if (hasLoaded) return current;
  const normalized = Array.isArray(stored) ? normalizePinnedChips(stored) : DEFAULT_PINNED_CHIPS;
  // An empty/garbage payload falls back to defaults so the row is never blank.
  current = normalized.length > 0 ? normalized : DEFAULT_PINNED_CHIPS;
  hasLoaded = true;
  notify();
  return current;
}

export async function setPinnedChips(kinds: readonly PinnableChipKind[]): Promise<void> {
  current = normalizePinnedChips(kinds);
  hasLoaded = true;
  notify();
  await persist(current);
}

export async function togglePinnedChip(kind: PinnableChipKind): Promise<void> {
  // Wait for the persisted set to load first, so a toggle during the cold-start
  // load window flips the user's SAVED pins — not the transient DEFAULT snapshot.
  // Without this, an early tap would compute DEFAULT±kind and setPinnedChips'
  // hasLoaded=true would then make the in-flight load discard the saved set.
  await ensurePinnedChipsLoaded();
  const next = current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind];
  await setPinnedChips(next);
}

let loadPromise: Promise<readonly PinnableChipKind[]> | null = null;
function ensurePinnedChipsLoaded(): Promise<readonly PinnableChipKind[]> {
  if (!loadPromise) loadPromise = loadPinnedChips();
  return loadPromise;
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): PinnedChipsSnapshot {
  return snapshot;
}

function getServerSnapshot(): PinnedChipsSnapshot {
  return SERVER_SNAPSHOT;
}

export function usePinnedChips(): {
  pinned: readonly PinnableChipKind[];
  loaded: boolean;
  isPinned: (kind: PinnableChipKind) => boolean;
  togglePin: (kind: PinnableChipKind) => void;
} {
  const { pinned, loaded } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    void ensurePinnedChipsLoaded();
  }, []);

  const isPinned = useCallback((kind: PinnableChipKind) => pinned.includes(kind), [pinned]);
  const togglePin = useCallback((kind: PinnableChipKind) => {
    void togglePinnedChip(kind);
  }, []);

  return { pinned, loaded, isPinned, togglePin };
}

/** Test-only: reset the module singleton between tests (see grade-format-preference / section-expand-store). */
export function resetPinnedChipsStoreForTests(): void {
  current = DEFAULT_PINNED_CHIPS;
  hasLoaded = false;
  snapshot = { pinned: current, loaded: hasLoaded };
  loadPromise = null;
  listeners.clear();
}
