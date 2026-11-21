// Suppression belongs to a live removal operation, never a persisted reason.
// After a crash the next process must reconcile the request normally.
const removals = new Set<string>();

export function holdDownloadRemoval(requestId: string): () => void {
  removals.add(requestId);
  return () => {
    removals.delete(requestId);
  };
}

export function isDownloadRemovalPending(requestId: string): boolean {
  return removals.has(requestId);
}
