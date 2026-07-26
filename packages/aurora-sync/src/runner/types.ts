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
   * The cooldown is persisted in `board_shared_syncs` under a synthetic
   * `__local_*` cursor and claimed with a compare-and-set, so it survives a
   * restart and is shared across instances. It used to be an in-memory Map,
   * which meant every deploy re-fired a full shared sync per board on its first
   * cycle, and two overlapping containers each had their own copy — the pair of
   * behaviours that let followers get duplicate setter notifications.
   */
  sharedSyncCooldownMs?: number;
};

// The daemon loop itself lives in @boardsesh/sync-runtime (shared with
// kilter-sync). This package used to carry a forked copy of both the type and
// the loop; re-exporting keeps `@boardsesh/aurora-sync`'s public surface
// unchanged while there is only one implementation to maintain.
export type { DaemonOptions } from '@boardsesh/sync-runtime';

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
