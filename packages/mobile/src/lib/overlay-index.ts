// The synchronous index of already-rendered overlay PNGs (issue #3647).
//
// Extracted out of use-native-climb-render.ts so the disk sweeper can drop keys
// it just deleted WITHOUT the sweeper importing the render hook (and with it
// React, expo-image, and the whole board-config graph). The hook imports this;
// the sweeper imports this; neither imports the other, so the module graph stays
// acyclic under Metro's CJS interop, where a cycle binds `undefined` rather than
// failing loudly.
//
// Behaviour is unchanged from the map that used to live in the hook, plus two
// additions the sweeper needs: an access clock and a write odometer.

export type RenderedOverlayEntry = {
  uri: string;
  generation: number;
};

/**
 * Synchronous lookup of already-rendered overlay PNGs keyed by cache key.
 * Populated when (a) any successful render completes, and (b) on first module
 * import when the hook scans the on-disk cache directory to surface PNGs from
 * prior app sessions.
 *
 * This is the mechanism that makes drawer-open instant after the list has
 * scrolled past a climb: the hook's useState initial value reads from this map,
 * so a cache hit displays the overlay on the very first render with no
 * useEffect-driven update.
 */
const renderedOverlays = new Map<string, RenderedOverlayEntry>();

/**
 * When JS last READ each key — not when the file was written.
 *
 * Kept beside the index rather than inside the entry so `RenderedOverlayEntry`
 * stays the immutable identity the hook's exact-match failure guards compare by
 * value.
 */
const lastUsedAtMs = new Map<string, number>();

export const RENDERED_OVERLAYS_MAX = 200;
let nextOverlayGeneration = 1;

let overlayWritesSinceSweep = 0;
let writeThresholdListener: (() => void) | null = null;
let writeThreshold = 0;

function dropKey(cacheKey: string): boolean {
  lastUsedAtMs.delete(cacheKey);
  return renderedOverlays.delete(cacheKey);
}

/**
 * The only insertion path for the synchronous overlay cache. A generation is
 * minted even when native rewrites the same URI, which lets mounted consumers
 * distinguish the replacement from the missing file they just failed to load.
 */
export function cacheRenderedOverlay(cacheKey: string, uri: string): RenderedOverlayEntry {
  const entry = { uri, generation: nextOverlayGeneration };
  nextOverlayGeneration += 1;

  // Delete first so replacing an entry also promotes it to most-recently used.
  renderedOverlays.delete(cacheKey);
  if (renderedOverlays.size >= RENDERED_OVERLAYS_MAX) {
    const oldestKey = renderedOverlays.keys().next().value;
    if (oldestKey !== undefined) dropKey(oldestKey);
  }
  renderedOverlays.set(cacheKey, entry);
  lastUsedAtMs.set(cacheKey, Date.now());

  noteOverlayWrite();
  return entry;
}

export function getRenderedOverlay(cacheKey: string): RenderedOverlayEntry | undefined {
  const entry = renderedOverlays.get(cacheKey);
  if (!entry) return undefined;
  // Map iteration order is the LRU order. Reads promote without changing the
  // immutable entry identity used by exact failure guards.
  renderedOverlays.delete(cacheKey);
  renderedOverlays.set(cacheKey, entry);
  lastUsedAtMs.set(cacheKey, Date.now());
  return entry;
}

export function invalidateRenderedOverlay(cacheKey: string, expected: RenderedOverlayEntry): boolean {
  const current = renderedOverlays.get(cacheKey);
  if (!current || current.uri !== expected.uri || current.generation !== expected.generation) return false;
  return dropKey(cacheKey);
}

/**
 * The cache keys a live surface actually READ recently.
 *
 * Not the tail of the map — the warm-up inserts a couple of hundred prior-session
 * PNGs in directory-listing order, so map order after launch is an arbitrary
 * sample of the disk, not the working set. What a sweep must not delete is what
 * something on screen is displaying, and the only honest record of that is when
 * JS last looked a key up. Warm-up insertions are stamped at insert time and
 * fall out of the window within `withinMs`, which is correct: an overlay nothing
 * has read is not on screen.
 */
export function getRecentlyUsedCacheKeys(withinMs: number, nowMs = Date.now()): Set<string> {
  const recent = new Set<string>();
  for (const [cacheKey, usedAt] of lastUsedAtMs) {
    // A timestamp whose entry is gone (an evicted key, or a test reaching into
    // the map directly) is bookkeeping, not a protection — drop it here so the
    // clock can't outgrow the index it describes.
    if (!renderedOverlays.has(cacheKey)) {
      lastUsedAtMs.delete(cacheKey);
      continue;
    }
    if (nowMs - usedAt <= withinMs) recent.add(cacheKey);
  }
  return recent;
}

/** Drop keys whose PNG has just been deleted, so nothing hands out a dead URI. */
export function forgetOverlays(cacheKeys: Iterable<string>): number {
  let forgotten = 0;
  for (const cacheKey of cacheKeys) {
    if (dropKey(cacheKey)) forgotten += 1;
  }
  return forgotten;
}

export function clearOverlayIndex(): void {
  renderedOverlays.clear();
  lastUsedAtMs.clear();
}

/**
 * Fire a listener every `threshold` overlay writes.
 *
 * The sweep triggers that come for free — launch, and the transition to
 * background — both miss the failure mode this issue is about: a session that
 * stays in the foreground for days (#3803's ~3.7-day iPad) never backgrounds and
 * never relaunches, so nothing ever enforces the cap while it grows. Counting
 * writes tracks growth directly and costs one integer increment per render.
 */
export function onOverlayWriteThreshold(threshold: number, listener: () => void): () => void {
  writeThreshold = threshold;
  writeThresholdListener = listener;
  overlayWritesSinceSweep = 0;
  return () => {
    if (writeThresholdListener === listener) {
      writeThresholdListener = null;
      writeThreshold = 0;
    }
  };
}

/** Reset the odometer — a sweep just ran, from whatever trigger. */
export function resetOverlayWriteOdometer(): void {
  overlayWritesSinceSweep = 0;
}

function noteOverlayWrite(): void {
  if (writeThresholdListener === null || writeThreshold <= 0) return;
  overlayWritesSinceSweep += 1;
  if (overlayWritesSinceSweep < writeThreshold) return;
  overlayWritesSinceSweep = 0;
  writeThresholdListener();
}

/** Test-only handles. Not part of the public API. */
export function _resetOverlayIndexForTests(): void {
  clearOverlayIndex();
  nextOverlayGeneration = 1;
  overlayWritesSinceSweep = 0;
  writeThresholdListener = null;
  writeThreshold = 0;
}

export const _renderedOverlaysForTests = renderedOverlays;
