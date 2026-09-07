import type { ClimbStatsEvent } from '@boardsesh/shared-schema';

export type ClimbStatsKey = {
  boardType: string;
  layoutId: number;
  climbUuid: string;
  angle: number;
};

export type CanonicalClimbStats = ClimbStatsEvent;

export type ClimbStatsSnapshot = {
  canonical: CanonicalClimbStats | null;
  optimisticFloor: number | null;
};

export type SettledOfflineTickAscent = {
  key: ClimbStatsKey;
  token: string;
  status: 'acknowledged' | 'dead_letter';
};

type OptimisticAscent = {
  token: string;
  floor: number;
  authEpoch: number;
  status: 'pending' | 'queued' | 'acknowledged';
  tickUuid: string | null;
};

type StoreEntry = {
  key: ClimbStatsKey;
  canonical: CanonicalClimbStats | null;
  optimistic: Map<string, OptimisticAscent>;
  listeners: Set<() => void>;
  refCount: number;
  snapshot: ClimbStatsSnapshot;
};

const EMPTY_SNAPSHOT: ClimbStatsSnapshot = Object.freeze({ canonical: null, optimisticFloor: null });
const entries = new Map<string, StoreEntry>();
const tokenKeys = new Map<string, string>();
const offlineTickTokens = new Map<string, string>();
const unmatchedOfflineSettlements = new Map<string, 'acknowledged' | 'dead_letter'>();
let activeAuthEpoch = 0;

export function climbStatsKeyString(key: ClimbStatsKey): string {
  return `${key.boardType}\u0000${key.layoutId}\u0000${key.climbUuid}\u0000${key.angle}`;
}

function validRevision(revision: string): boolean {
  return /^(0|[1-9]\d*)$/.test(revision);
}

function revisionIsNewer(next: string, current: string): boolean {
  if (!validRevision(next)) return false;
  if (!validRevision(current)) return true;
  return BigInt(next) > BigInt(current);
}

function getOrCreateEntry(key: ClimbStatsKey): StoreEntry {
  const serialized = climbStatsKeyString(key);
  const existing = entries.get(serialized);
  if (existing) return existing;
  const entry: StoreEntry = {
    key,
    canonical: null,
    optimistic: new Map(),
    listeners: new Set(),
    refCount: 0,
    snapshot: EMPTY_SNAPSHOT,
  };
  entries.set(serialized, entry);
  return entry;
}

function deleteIfUnused(serialized: string, entry: StoreEntry): void {
  if (entry.refCount !== 0 || entry.optimistic.size !== 0) return;
  entries.delete(serialized);
}

function publish(entry: StoreEntry): void {
  let optimisticFloor: number | null = null;
  for (const mutation of entry.optimistic.values()) {
    optimisticFloor = Math.max(optimisticFloor ?? mutation.floor, mutation.floor);
  }
  const next: ClimbStatsSnapshot = { canonical: entry.canonical, optimisticFloor };
  if (entry.snapshot.canonical === next.canonical && entry.snapshot.optimisticFloor === next.optimisticFloor) {
    return;
  }
  entry.snapshot = next;
  for (const listener of entry.listeners) listener();
}

function removeToken(entry: StoreEntry, token: string): void {
  const mutation = entry.optimistic.get(token);
  if (!mutation) return;
  entry.optimistic.delete(token);
  tokenKeys.delete(token);
  if (mutation.tickUuid) offlineTickTokens.delete(mutation.tickUuid);
}

function retireSatisfiedAcknowledged(entry: StoreEntry): void {
  const canonicalCount = entry.canonical?.ascensionistCount;
  if (canonicalCount == null) return;
  for (const [token, mutation] of entry.optimistic) {
    if (mutation.status === 'acknowledged' && canonicalCount >= mutation.floor) removeToken(entry, token);
  }
}

export function subscribeClimbStats(key: ClimbStatsKey, listener: () => void): () => void {
  const serialized = climbStatsKeyString(key);
  const entry = getOrCreateEntry(key);
  entry.refCount += 1;
  entry.listeners.add(listener);
  return () => {
    const current = entries.get(serialized);
    if (!current) return;
    current.listeners.delete(listener);
    current.refCount = Math.max(0, current.refCount - 1);
    deleteIfUnused(serialized, current);
  };
}

export function getClimbStatsSnapshot(key: ClimbStatsKey): ClimbStatsSnapshot {
  return entries.get(climbStatsKeyString(key))?.snapshot ?? EMPTY_SNAPSHOT;
}

export function getRetainedClimbStatsKeys(boardType: string, layoutId: number): ClimbStatsKey[] {
  const retained: ClimbStatsKey[] = [];
  for (const entry of entries.values()) {
    if (entry.refCount > 0 && entry.key.boardType === boardType && entry.key.layoutId === layoutId) {
      retained.push(entry.key);
    }
  }
  return retained;
}

/** Whether a read key still has a mounted selector or an unsettled mutation. */
export function isClimbStatsReadRetained(boardType: string, climbUuid: string): boolean {
  for (const entry of entries.values()) {
    if (
      entry.key.boardType === boardType &&
      entry.key.climbUuid === climbUuid &&
      (entry.refCount > 0 || entry.optimistic.size > 0)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Snapshot the exact acknowledged mutations a successful primary read may
 * retire. The acknowledged mutation itself is the durable repair obligation:
 * canceling a delayed repair or losing a request to a terminal transport error
 * cannot orphan it, because the next primary read discovers it here. Callers
 * snapshot immediately before dispatch so a newer acknowledgement cannot be
 * retired by an older in-flight response.
 */
export function getAcknowledgedClimbStatsTokens(boardType: string, climbUuid: string, authEpoch: number): string[] {
  if (authEpoch !== activeAuthEpoch) return [];
  const acknowledgedTokens: string[] = [];
  for (const entry of entries.values()) {
    if (entry.key.boardType !== boardType || entry.key.climbUuid !== climbUuid) continue;
    for (const mutation of entry.optimistic.values()) {
      if (mutation.authEpoch === authEpoch && mutation.status === 'acknowledged') {
        acknowledgedTokens.push(mutation.token);
      }
    }
  }
  return acknowledgedTokens;
}

export function applyCanonicalClimbStats(payload: CanonicalClimbStats): boolean {
  if (!validRevision(payload.syncSeq)) return false;
  const serialized = climbStatsKeyString(payload);
  const entry = entries.get(serialized);
  // A layout subscription can carry thousands of different climbs over its
  // lifetime. Cache only exact keys a mounted selector or optimistic mutation
  // retained; otherwise the layout stream would become an unbounded map.
  if (!entry) return false;
  if (entry.canonical && !revisionIsNewer(payload.syncSeq, entry.canonical.syncSeq)) return false;
  entry.canonical = payload;
  retireSatisfiedAcknowledged(entry);
  publish(entry);
  deleteIfUnused(serialized, entry);
  return true;
}

export function beginOptimisticAscent(
  key: ClimbStatsKey,
  token: string,
  authEpoch: number,
  baseAscensionistCount: number,
): void {
  if (authEpoch !== activeAuthEpoch || tokenKeys.has(token)) return;
  const entry = getOrCreateEntry(key);
  entry.optimistic.set(token, {
    token,
    // The form's base is immutable for its whole lifetime. Never derive this
    // from another optimistic token: two concurrent sends both target base+1,
    // not base+2. A newer canonical snapshot may already satisfy that target.
    floor: Math.max(entry.canonical?.ascensionistCount ?? 0, baseAscensionistCount + 1),
    authEpoch,
    status: 'pending',
    tickUuid: null,
  });
  tokenKeys.set(token, climbStatsKeyString(key));
  publish(entry);
}

export function markOptimisticAscentQueued(
  token: string,
  tickUuid: string,
  authEpoch: number,
): SettledOfflineTickAscent | null {
  if (authEpoch !== activeAuthEpoch) return null;
  const serialized = tokenKeys.get(token);
  const entry = serialized ? entries.get(serialized) : undefined;
  const mutation = entry?.optimistic.get(token);
  if (!serialized || !entry || !mutation || mutation.authEpoch !== authEpoch) return null;
  mutation.status = 'queued';
  mutation.tickUuid = tickUuid;
  offlineTickTokens.set(tickUuid, token);
  const settled = unmatchedOfflineSettlements.get(tickUuid);
  if (settled) {
    unmatchedOfflineSettlements.delete(tickUuid);
    return settleOfflineTickAscent(tickUuid, settled, authEpoch);
  }
  return null;
}

export function acknowledgeOptimisticAscent(token: string, authEpoch: number): void {
  if (authEpoch !== activeAuthEpoch) return;
  const serialized = tokenKeys.get(token);
  const entry = serialized ? entries.get(serialized) : undefined;
  const mutation = entry?.optimistic.get(token);
  if (!serialized || !entry || !mutation || mutation.authEpoch !== authEpoch) return;
  mutation.status = 'acknowledged';
  retireSatisfiedAcknowledged(entry);
  publish(entry);
  deleteIfUnused(serialized, entry);
}

export function rejectOptimisticAscent(token: string, authEpoch: number): void {
  if (authEpoch !== activeAuthEpoch) return;
  const serialized = tokenKeys.get(token);
  const entry = serialized ? entries.get(serialized) : undefined;
  const mutation = entry?.optimistic.get(token);
  if (!serialized || !entry || !mutation || mutation.authEpoch !== authEpoch) return;
  removeToken(entry, token);
  publish(entry);
  deleteIfUnused(serialized, entry);
}

/**
 * Retire only the acknowledged mutations whose post-ack primary repair just
 * succeeded. A stale absolute base can leave canonical below a mutation's
 * floor forever, so primary authority — not floor comparison — settles these
 * exact tokens. Tokens created after the batch snapshot are deliberately not
 * touched.
 */
export function retireAcknowledgedOptimisticAscents(tokens: Iterable<string>, authEpoch: number): void {
  if (authEpoch !== activeAuthEpoch) return;
  const changedEntries = new Map<string, StoreEntry>();
  for (const token of tokens) {
    const serialized = tokenKeys.get(token);
    const entry = serialized ? entries.get(serialized) : undefined;
    const mutation = entry?.optimistic.get(token);
    if (!serialized || !entry || !mutation || mutation.authEpoch !== authEpoch || mutation.status !== 'acknowledged') {
      continue;
    }
    removeToken(entry, token);
    changedEntries.set(serialized, entry);
  }
  for (const [serialized, entry] of changedEntries) {
    publish(entry);
    deleteIfUnused(serialized, entry);
  }
}

export function settleOfflineTickAscent(
  tickUuid: string,
  status: 'acknowledged' | 'dead_letter',
  authEpoch: number,
): SettledOfflineTickAscent | null {
  const token = offlineTickTokens.get(tickUuid);
  if (!token) {
    // An eager drain can acknowledge between saveTickOffline returning and the
    // React Query onSuccess callback re-keying the temp token to tickUuid.
    // Hold that one settlement until markOptimisticAscentQueued closes the race.
    if (unmatchedOfflineSettlements.size >= 100) {
      const oldest = unmatchedOfflineSettlements.keys().next().value;
      if (typeof oldest === 'string') unmatchedOfflineSettlements.delete(oldest);
    }
    unmatchedOfflineSettlements.set(tickUuid, status);
    return null;
  }
  const serialized = tokenKeys.get(token);
  const key = serialized ? (entries.get(serialized)?.key ?? null) : null;
  if (status === 'acknowledged') acknowledgeOptimisticAscent(token, authEpoch);
  else rejectOptimisticAscent(token, authEpoch);
  return key ? { key, token, status } : null;
}

export function setClimbStatsAuthEpoch(authEpoch: number): void {
  if (authEpoch === activeAuthEpoch) return;
  activeAuthEpoch = authEpoch;
  tokenKeys.clear();
  offlineTickTokens.clear();
  unmatchedOfflineSettlements.clear();
  for (const [serialized, entry] of entries) {
    if (entry.optimistic.size > 0) {
      entry.optimistic.clear();
      publish(entry);
    }
    deleteIfUnused(serialized, entry);
  }
}

/** Test-only state reset. */
export function resetClimbStatsStoreForTests(): void {
  entries.clear();
  tokenKeys.clear();
  offlineTickTokens.clear();
  unmatchedOfflineSettlements.clear();
  activeAuthEpoch = 0;
}

/** Test/debug aid for StrictMode ref-count assertions. */
export function getClimbStatsRefCount(key: ClimbStatsKey): number {
  return entries.get(climbStatsKeyString(key))?.refCount ?? 0;
}
