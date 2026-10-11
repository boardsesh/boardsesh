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

export function forgetBoardArtInMemory(): void {
  inMemoryUris.clear();
  displayedGenerations.clear();
}
