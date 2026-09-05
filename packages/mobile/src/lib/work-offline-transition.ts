export type WorkOfflineOutboxSummary = { pendingCount: number; deadLetterCount: number };

export type WorkOfflineTransitionDeps = {
  readOutboxSummary: () => Promise<WorkOfflineOutboxSummary>;
  confirmGoingOnline: (summary: WorkOfflineOutboxSummary) => Promise<boolean>;
  persist: (enabled: boolean) => void;
  applyNetworkPolicy: (enabled: boolean) => void;
  syncNow: () => void;
  onSummaryError?: (error: unknown) => void;
};

/** Applies the toggle atomically from the UI's perspective; cancel changes nothing. */
export async function transitionWorkOffline(next: boolean, deps: WorkOfflineTransitionDeps): Promise<boolean> {
  if (next) {
    deps.applyNetworkPolicy(true);
    deps.persist(true);
    return true;
  }

  let summary: WorkOfflineOutboxSummary = { pendingCount: 0, deadLetterCount: 0 };
  try {
    summary = await deps.readOutboxSummary();
  } catch (error) {
    deps.onSummaryError?.(error);
  }
  if (!(await deps.confirmGoingOnline(summary))) return false;

  deps.persist(false);
  deps.applyNetworkPolicy(false);
  deps.syncNow();
  return true;
}
