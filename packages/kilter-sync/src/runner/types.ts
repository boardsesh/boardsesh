import type postgres from 'postgres';
import type { ProviderSyncDb, SyncBatchRunner } from '@boardsesh/db/queries';

export type RunnerClient = ReturnType<typeof postgres>;
/** Any Drizzle Postgres database: the runner's own pool, or one a caller injected. */
export type RunnerDb = ProviderSyncDb;

export type SyncRunnerConfig = {
  /**
   * Minimum delay between catalog (shared) syncs across users on the same
   * board. The first per-user cycle in a window triggers a catalog cycle;
   * later cycles skip until the cooldown elapses. Default: 1 hour.
   */
  sharedSyncCooldownMs?: number;
  /**
   * Apply Kilter's server-side deletions during the daemon's catalog piggyback.
   * Default true — reconciliation is batched, reversible (soft-delete), and only
   * ever touches Kilter-synced climbs (never user-authored). Set false to keep
   * the daemon report-only.
   */
  applyCatalogDeletions?: boolean;
  /** Max deletion changes applied per catalog run; the backlog drains over cycles. */
  deleteBatchLimit?: number;
  onLog?: (message: string) => void;
  onError?: (error: Error, context: { userId?: string; board?: string }) => void;
  /**
   * A database the caller owns (a background worker's pool). When set the
   * runner never opens its own `postgres` pool and `stop()` leaves this one
   * alone. Unset, the runner connects to `DATABASE_URL` itself (the daemon).
   */
  db?: RunnerDb;
  /** Default batch runner for credential writes and user-sync flushes. See {@link RunCycleOptions}. */
  transaction?: SyncBatchRunner;
  /** Default abort signal for the PowerSync stream. */
  signal?: AbortSignal;
};

export type RunCycleOptions = {
  /**
   * Runs every credential write and every user-sync flush in one transaction
   * behind the caller's fences. The Keycloak token refresh never runs inside
   * it: its own transaction holds the credential row `FOR UPDATE` across the
   * Keycloak call (up to 30 s), which must never happen inside a fence.
   */
  transaction?: SyncBatchRunner;
  /** Cancels the PowerSync stream and stops before the next flush. */
  signal?: AbortSignal;
  /** Leave the catalog piggyback to its own schedule. */
  skipCatalogSync?: boolean;
};

/**
 * How one credential's cycle ended. `transient` marks a failure a retry may
 * fix; the credential's status is left as it was then.
 */
export type SyncOutcome = {
  status: 'active' | 'error' | 'expired';
  error?: string;
  transient?: boolean;
  /** Kilter answered 429 with a readable `Retry-After`: how long it asked us to wait. */
  retryAfterMs?: number;
};

/** Options for {@link SyncRunner.runCatalogSyncJob}. */
export type CatalogSyncJobOptions = {
  signal?: AbortSignal;
  /**
   * Runs every write batch of the job: the slot claim and stamp, each catalog
   * flush, stats chunk, location and deletion batch, the weekly repair's apply
   * and watermark, and the history snapshot. A background job passes its
   * attempt fence, so a run that lost its lease stops at its next batch.
   */
  transaction?: SyncBatchRunner;
  /** Overrides the runner's catalog cooldown for this claim. */
  cooldownMs?: number;
  /** Where the ROPC fallback token comes from. Defaults to `process.env`. */
  environment?: Readonly<Record<string, string | undefined>>;
};

/**
 * How a scheduled catalog sync ended when it did not throw: it ran (with a
 * linked climber's refresh token, or the ROPC test account), another run holds
 * the cooldown slot, or there is no token source at all.
 */
export type CatalogSyncJobResult =
  | { status: 'synced'; tokenSource: 'credential' | 'password' }
  | { status: 'cooldown'; lastRunAt: Date | null }
  | { status: 'no_donor' };

export type SyncSummary = {
  total: number;
  successful: number;
  failed: number;
  errors: Array<{ userId: string; boardType: string; error: string }>;
};

/**
 * Row shape we select from `aurora_credentials WHERE board_type = 'kilter'`.
 * Encrypted columns stay encrypted at the type level so callers can't
 * accidentally log them — pass them through decrypt() at the point of use.
 */
export type KilterCredentialRecord = {
  userId: string;
  boardType: string;
  encryptedRefreshToken: string | null;
  syncStatus: string | null;
  syncError: string | null;
  lastSyncAt: Date | null;
  consecutiveFailures: number | null;
};
