// Pure planning for the on-disk caches this app owns (issue #3647).
//
// Zero imports on purpose: every rule here is a decision about *which files are
// ours to delete*, and that decision has to be testable without a filesystem,
// a native module, or a React tree. The I/O that feeds it lives in
// `cache-dir-io.ts`; the orchestration lives in `sweep-caches.ts`.
//
// The board-art rules below MIRROR the native pruner's contract. If you change
// one, change the other:
//   - packages/mobile/modules/board-renderer/android/src/main/java/com/boardsesh/
//     boardrenderer/CachePruner.kt  (`.png`-only accounting + eviction, temp sweep)
//   - .../boardrenderer/AtomicFileWrite.kt  (`TEMP_PREFIX` / `TEMP_SUFFIX`)
//   - packages/mobile/modules/board-renderer/ios/BoardRendererModule.swift
//     (`cacheCapBytes`, and the `.skipsHiddenFiles` that keeps its own
//     `write(to:options:.atomic)` staging file out of the sweep)
//
// Two pruners walking the same directory with different ideas of what is safe
// to delete is how you manufacture a "file vanished mid-write" storm, which is
// the exact Sentry noise this issue is trying to remove.

/** One directory entry, reduced to what a plan can be built from. */
export type CacheDirEntry = {
  name: string;
  sizeBytes: number;
  /** Milliseconds since the epoch, or null when the platform wouldn't say. */
  modifiedAtMs: number | null;
};

/**
 * What a name in `{cache}/board-thumbnails` is, from the sweeper's point of view.
 *
 * - `cache-entry` — a finished overlay PNG. The only class that counts toward the
 *   size budget and the only class eviction may delete.
 * - `managed-temp` — an in-flight (or orphaned) atomic write from the Android
 *   module. Ours, but deletable only once it is old enough to be certainly dead.
 * - `foreign` — everything else, including EVERY other dot-prefixed name. iOS
 *   stages its atomic write as a hidden dot-file in this same directory and its
 *   own pruner deliberately skips hidden files; deleting one mid-write is a
 *   guaranteed ENOENT for a render already on the bridge.
 */
export type OverlayEntryKind = 'cache-entry' | 'managed-temp' | 'foreign';

/** Mirrors `AtomicFileWrite.TEMP_PREFIX`. */
const MANAGED_TEMP_PREFIX = '.bsov-';
/** Mirrors `AtomicFileWrite.TEMP_SUFFIX`. */
const MANAGED_TEMP_SUFFIX = '.tmp';
/** Mirrors `CachePruner.CACHE_ENTRY_SUFFIX`. */
const CACHE_ENTRY_SUFFIX = '.png';

/**
 * The size ceiling for the rendered board-art cache, mirroring the native
 * modules' own cap (`BoardRendererModule.swift`'s `cacheCapBytes`, and the
 * `maxBytes` Android passes to `CachePruner`). Deliberately the same number:
 * the JS sweeper exists to enforce it *during* a session, not to disagree
 * with it.
 */
export const OVERLAY_CACHE_TARGET_BYTES = 200 * 1024 * 1024;

/**
 * How old a managed temp file must be before a mid-session sweep will delete it.
 *
 * The native pruner deletes them unconditionally, which is safe there because it
 * runs once at module start, before any render is in flight. A JS sweep can fire
 * while a write is happening, and no single PNG encode takes an hour — so age is
 * the cheap way to tell "orphaned by a kill" from "being written right now".
 */
export const MANAGED_TEMP_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * How long a downloaded snapshot artifact may sit in `{cache}/board-snapshots`
 * before it is treated as leaked.
 *
 * The engine deletes its artifact in a `finally`, so anything still here was
 * orphaned by a kill mid-bootstrap — and a Kilter artifact is ~271 MB. A day is
 * deliberately generous: a resumable/partial download (#4310) or a retryable
 * bootstrap (#4313) must never be reaped out from under a retry that is still
 * plausibly coming.
 */
export const SNAPSHOT_LEFTOVER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How old a snapshot artifact must be before the explicit Clear button will
 * reap it.
 *
 * Not zero: the whole point of Clear is to hand back the biggest thing in the
 * cache directory, but deleting the file a bootstrap is downloading right now
 * breaks that download. Five minutes clears the observed Kilter download (p50
 * ~3 minutes) with room to spare, so anything older is certainly abandoned.
 */
export const SNAPSHOT_CLEAR_MIN_AGE_MS = 5 * 60 * 1000;

/**
 * Overlay writes between foreground sweeps.
 *
 * The launch and background sweeps miss the failure mode this issue names — a
 * long-lived foreground session, the same shape as the ~3.7-day iPad uptime in
 * #3803. Counting writes rather than minutes makes the trigger track growth: 400
 * writes is roughly 25 MB at the issue's ~60 KB/climb average, so a session that
 * is browsing hard gets swept often and an idle one never pays anything.
 */
export const OVERLAY_WRITES_PER_SWEEP = 400;

/** Classify one directory entry name. See `OverlayEntryKind`. */
export function classifyOverlayEntry(name: string): OverlayEntryKind {
  if (name.startsWith(MANAGED_TEMP_PREFIX) && name.endsWith(MANAGED_TEMP_SUFFIX)) return 'managed-temp';
  // Hidden files are never ours, whatever they end in — iOS's atomic staging
  // file can carry any suffix and its own pruner skips it.
  if (name.startsWith('.')) return 'foreign';
  if (name.endsWith(CACHE_ENTRY_SUFFIX)) return 'cache-entry';
  return 'foreign';
}

/** Bytes held by finished overlay PNGs. Temps and foreign files are not our budget. */
export function measureOverlayCacheBytes(entries: readonly CacheDirEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    if (classifyOverlayEntry(entry.name) === 'cache-entry') total += entry.sizeBytes;
  }
  return total;
}

/** A null mtime sorts oldest, so an entry the platform can't date is evicted first. */
function modifiedAtOrEpoch(entry: CacheDirEntry): number {
  return entry.modifiedAtMs ?? 0;
}

export type OverlayEvictionPlan = {
  /** Finished PNGs to delete, oldest first. */
  evictNames: string[];
  /** Orphaned atomic-write temps old enough to be certainly dead. */
  staleTempNames: string[];
  beforeBytes: number;
  afterBytes: number;
};

/**
 * Least-recently-modified eviction down to `targetBytes`.
 *
 * mtime is the LRU proxy both native modules already maintain — they bump it on
 * a cache hit — so JS does not need its own access database on disk. What JS
 * adds is `protectedNames`: the keys a live surface read in the last couple of
 * minutes, which no amount of mtime can tell you about a file written days ago
 * and displayed right now.
 */
export function planLruEviction(params: {
  entries: readonly CacheDirEntry[];
  targetBytes: number;
  protectedNames?: ReadonlySet<string>;
  nowMs: number;
  managedTempMinAgeMs?: number;
}): OverlayEvictionPlan {
  const { entries, targetBytes, nowMs } = params;
  const protectedNames = params.protectedNames ?? new Set<string>();
  const managedTempMinAgeMs = params.managedTempMinAgeMs ?? MANAGED_TEMP_MIN_AGE_MS;

  const cacheEntries: CacheDirEntry[] = [];
  const staleTempNames: string[] = [];
  for (const entry of entries) {
    const kind = classifyOverlayEntry(entry.name);
    if (kind === 'cache-entry') {
      cacheEntries.push(entry);
    } else if (kind === 'managed-temp' && nowMs - modifiedAtOrEpoch(entry) >= managedTempMinAgeMs) {
      staleTempNames.push(entry.name);
    }
  }

  const beforeBytes = cacheEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (beforeBytes <= targetBytes) {
    return { evictNames: [], staleTempNames, beforeBytes, afterBytes: beforeBytes };
  }

  const oldestFirst = [...cacheEntries].sort((left, right) => modifiedAtOrEpoch(left) - modifiedAtOrEpoch(right));
  const evictNames: string[] = [];
  let remainingBytes = beforeBytes;
  for (const entry of oldestFirst) {
    if (remainingBytes <= targetBytes) break;
    // A name a surface just read is worth more than the bytes it holds: deleting
    // it blanks live art and costs a re-render plus a Sentry warning.
    if (protectedNames.has(cacheKeyForOverlayName(entry.name))) continue;
    evictNames.push(entry.name);
    remainingBytes -= entry.sizeBytes;
  }
  return { evictNames, staleTempNames, beforeBytes, afterBytes: remainingBytes };
}

/** Everything the Clear button deletes: every finished PNG, plus certainly-dead temps. */
export function planOverlayCacheClear(params: {
  entries: readonly CacheDirEntry[];
  nowMs: number;
  managedTempMinAgeMs?: number;
}): { deleteNames: string[]; freedBytes: number } {
  const plan = planLruEviction({ ...params, targetBytes: -1 });
  return {
    deleteNames: [...plan.evictNames, ...plan.staleTempNames],
    freedBytes: plan.beforeBytes - plan.afterBytes,
  };
}

/** Leaked download artifacts: anything older than `maxAgeMs`. Undateable entries are left alone. */
export function planStaleArtifactSweep(params: {
  entries: readonly CacheDirEntry[];
  nowMs: number;
  maxAgeMs: number;
}): { deleteNames: string[]; freedBytes: number } {
  const deleteNames: string[] = [];
  let freedBytes = 0;
  for (const entry of params.entries) {
    // Null mtime means "the platform wouldn't say"; for a 271 MB artifact that a
    // retry may still want, guessing "old" is the wrong way to be wrong.
    if (entry.modifiedAtMs === null) continue;
    if (params.nowMs - entry.modifiedAtMs < params.maxAgeMs) continue;
    deleteNames.push(entry.name);
    freedBytes += entry.sizeBytes;
  }
  return { deleteNames, freedBytes };
}

/** The cache key a PNG name encodes (i.e. the name without its `.png`). */
export function cacheKeyForOverlayName(name: string): string {
  return name.endsWith(CACHE_ENTRY_SUFFIX) ? name.slice(0, -CACHE_ENTRY_SUFFIX.length) : name;
}

/**
 * Whether an overlay PNG belongs to one downloaded board scope.
 *
 * `buildCacheKey` (use-native-climb-render.ts) lays the identity out as
 * `v{version}_{style}_w{width}_{boardName}_{layoutId}_{sizeId}_{setIds}_{hash}`,
 * so the scope is an underscore-delimited run inside the name. The delimiters on
 * BOTH sides are load-bearing: without the trailing one, layout 1 also matches
 * layout 12, and size 7 also matches size 70.
 */
export function overlayNameMatchesScope(
  name: string,
  scope: { boardType: string; layoutId: number; sizeId: number },
): boolean {
  if (classifyOverlayEntry(name) !== 'cache-entry') return false;
  return name.includes(`_${scope.boardType}_${scope.layoutId}_${scope.sizeId}_`);
}
