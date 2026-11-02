// Renderer/cache readers must not import expo-image merely to inspect readiness.
const IN_MEMORY_URIS_MAX = 160;
const inMemoryUris = new Set<string>();
const displayedGenerations = new Map<string, string>();

export function noteBoardArtInMemory(uri: string, generation?: string): void {
  if (generation !== undefined) displayedGenerations.set(uri, generation);
  inMemoryUris.delete(uri);
  inMemoryUris.add(uri);
  if (inMemoryUris.size > IN_MEMORY_URIS_MAX) {
    const oldest = inMemoryUris.values().next().value;
    if (oldest !== undefined) {
      inMemoryUris.delete(oldest);
      displayedGenerations.delete(oldest);
    }
  }
}

export function isBoardArtInMemory(uri: string | null | undefined, generation?: string): boolean {
  return (
    uri != null && inMemoryUris.has(uri) && (generation === undefined || displayedGenerations.get(uri) === generation)
  );
}

// When the last forget ran, on the monotonic clock: a device clock set back
// must not make an old sweep read as one that just ran. Every image-memory
// sweep (app background, memory warning, iPad tab switch) forgets here in the
// same breath as it clears expo-image's memory cache, so this is also when that
// cache was last emptied.
let lastForgottenAtMs: number | null = null;

function monotonicNowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

export function forgetBoardArtInMemory(): void {
  inMemoryUris.clear();
  displayedGenerations.clear();
  lastForgottenAtMs = monotonicNowMs();
}

/**
 * Milliseconds since the image memory cache was last swept, or `null` when no
 * sweep has run this JS lifetime. Reported on the play board's paint timeout,
 * to tell a board that went blank right after a sweep from one that did not.
 */
export function msSinceImageMemorySweep(): number | null {
  return lastForgottenAtMs === null ? null : Math.max(0, Math.round(monotonicNowMs() - lastForgottenAtMs));
}
