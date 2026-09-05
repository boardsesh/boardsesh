import { serializePersistedCache, utf8ByteLength, type PersistedQueryEntry } from './envelope';

/**
 * Asserted by a test against a realistic populated cache (profile + 6 boards +
 * 3 gyms + grades/angles for two boards), not enforced at runtime. If a real
 * device drifts past it, the `bytes` property on the restore event says so long
 * before the hard cap does.
 */
export const PERSIST_TARGET_BYTES = 100 * 1024;
/** Hard cap. Past this, entries are evicted lowest-priority-first until it fits. */
export const PERSIST_MAX_BYTES = 512 * 1024;
/** One entry this big is a bug in the allowlist, not something to make room for. */
export const PERSIST_MAX_ENTRY_BYTES = 64 * 1024;

export type BudgetCandidate = {
  readonly entry: PersistedQueryEntry;
  readonly priority: number;
};

export type BudgetResult = {
  readonly kept: readonly PersistedQueryEntry[];
  readonly droppedOversize: number;
  readonly droppedEvicted: number;
  /** Serialized size of the kept entries, including the JSON array delimiters. */
  readonly bytes: number;
};

/** Serialized size of one entry, measured once and reused by every pass below. */
function entryBytes(entry: PersistedQueryEntry): number {
  return utf8ByteLength(JSON.stringify(entry));
}

/**
 * The array's own bytes: `[` + `]` plus one comma between entries. Close enough
 * that the caller can add the envelope's fixed overhead and compare against a
 * cap without re-stringifying the whole blob on every candidate drop.
 */
function totalBytes(sizes: readonly number[]): number {
  if (sizes.length === 0) return 2;
  return sizes.reduce((sum, size) => sum + size, 0) + sizes.length + 1;
}

/**
 * Drop what cannot fit, in two passes:
 *  1. any single entry over `PERSIST_MAX_ENTRY_BYTES`,
 *  2. while the rest still exceeds `PERSIST_MAX_BYTES`, evict ascending by
 *     priority and, within a priority, oldest `dataUpdatedAt` first.
 *
 * Lowest priority first is what keeps `['profile']` — the entry the whole
 * feature exists for — as the last thing standing.
 */
export function applyBudget(candidates: readonly BudgetCandidate[]): BudgetResult {
  const sized = candidates
    .map((candidate) => ({ ...candidate, bytes: entryBytes(candidate.entry) }))
    .filter((candidate) => candidate.bytes <= PERSIST_MAX_ENTRY_BYTES);
  const droppedOversize = candidates.length - sized.length;

  // Ascending: the head of this list is what gets evicted first.
  sized.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    return (left.entry.state.dataUpdatedAt ?? 0) - (right.entry.state.dataUpdatedAt ?? 0);
  });

  let firstKeptIndex = 0;
  while (
    firstKeptIndex < sized.length &&
    totalBytes(sized.slice(firstKeptIndex).map((candidate) => candidate.bytes)) > PERSIST_MAX_BYTES
  ) {
    firstKeptIndex += 1;
  }

  const keptCandidates = sized.slice(firstKeptIndex);
  return {
    kept: keptCandidates.map((candidate) => candidate.entry),
    droppedOversize,
    droppedEvicted: firstKeptIndex,
    bytes: totalBytes(keptCandidates.map((candidate) => candidate.bytes)),
  };
}

/** Serialized size of a whole envelope — used by tests and by the restore path. */
export function envelopeBytes(userId: string, savedAt: number, queries: readonly PersistedQueryEntry[]): number {
  return utf8ByteLength(serializePersistedCache({ version: 1, userId, savedAt, queries }));
}
