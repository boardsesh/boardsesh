import type postgres from 'postgres';
import type { drizzle } from 'drizzle-orm/postgres-js';

export type RunnerClient = ReturnType<typeof postgres>;
export type RunnerDb = ReturnType<typeof drizzle>;

export type SyncRunnerConfig = {
  /**
   * Minimum delay between catalog (shared) syncs across users on the same
   * board. The first per-user cycle in a window triggers a catalog cycle;
   * later cycles skip until the cooldown elapses. Default: 1 hour.
   */
  sharedSyncCooldownMs?: number;
  onLog?: (message: string) => void;
  onError?: (error: Error, context: { userId?: string; board?: string }) => void;
};

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
};
