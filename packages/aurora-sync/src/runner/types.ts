/**
 * Context passed to the `onError` callback. `userId`/`board` are the original
 * pair; the rest is the per-credential failure ledger snapshot so a callback
 * (a future Sentry/metric wiring) can escalate on the *state* of a credential
 * — how deep the consecutive-failure streak is and whether the attempt just
 * quarantined it out of the pool — instead of firing identically for a
 * one-off transient blip and a credential that's been dead for days.
 */
export type SyncErrorContext = {
  userId?: string;
  board?: string;
  boardType?: string;
  /** Resolved sync_status after this attempt (e.g. 'error', 'expired'). */
  syncStatus?: string;
  /** consecutive_failures after this attempt (drives backoff). */
  consecutiveFailures?: number;
  /** True when this attempt pushed the credential to 'expired' (out of the pool). */
  quarantined?: boolean;
};

export type SyncRunnerConfig = {
  onLog?: (message: string) => void;
  onError?: (error: Error, context: SyncErrorContext) => void;
  /**
   * Minimum time between shared-sync attempts on the same board. Multiple users
   * cycling through user-sync within this window only trigger one shared-sync
   * for that board. Defaults to 1 hour.
   *
   * The cooldown is tracked in-memory on the SyncRunner instance — a daemon
   * crash, restart, or fresh `aurora-sync` invocation resets it for every
   * board. That's intentional: the post-restart "first user wins" cycle
   * picks up shared changes that may have accumulated while we were down,
   * and even at the worst case we only re-sync once per process boot.
   */
  sharedSyncCooldownMs?: number;
};

export type DaemonOptions = {
  timeZone?: string;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  quietPollMs?: number;
  minDelayMinutes?: number;
  maxDelayMinutes?: number;
};

export type SyncSummary = {
  total: number;
  successful: number;
  failed: number;
  errors: SyncError[];
};

export type SyncError = {
  userId: string;
  boardType: string;
  error: string;
};

export type CredentialRecord = {
  userId: string;
  boardType: string;
  encryptedUsername: string | null;
  encryptedPassword: string | null;
  auroraUserId: number | null;
  auroraToken: string | null;
  syncStatus: string | null;
  syncError: string | null;
  credentialFailureCount: number | null;
  lastCredentialFailureAt: Date | null;
  lastSyncAt: Date | null;
  lastSyncAttemptAt: Date | null;
  consecutiveFailures: number | null;
};
