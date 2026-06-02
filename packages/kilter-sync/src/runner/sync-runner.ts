import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';

import { auroraCredentials } from '@boardsesh/db/schema';
import { decrypt, encrypt } from '@boardsesh/crypto';
import {
  DEFAULT_DAEMON_OPTIONS,
  resolveDaemonOptions,
  runDaemonLoop,
  type ResolvedDaemonOptions,
  type DaemonOptions,
} from '@boardsesh/sync-runtime';

import { KILTER_BOARD_TYPE } from '../api/types';
import { isTransientKilterError, KilterApiError } from '../api/errors';
import { refreshAccessToken, type KeycloakClientConfig } from '../api/keycloak';
import { syncKilterUserData } from '../sync/user-sync';
import type { RunnerClient, RunnerDb, SyncRunnerConfig, SyncSummary, KilterCredentialRecord } from './types';

export class SyncRunner {
  private config: SyncRunnerConfig;
  private daemonController: AbortController | null = null;
  private client: RunnerClient | null = null;
  private db: RunnerDb | null = null;

  constructor(config: SyncRunnerConfig = {}) {
    this.config = config;
  }

  // NOTE: catalog cooldown / piggyback wiring lives in aurora-sync but is
  // intentionally absent here. Kilter publishes its catalog via different
  // PowerSync buckets and (notably) without a `climbs` table. When that
  // mapping lands, re-introduce a `lastCatalogSyncAt` member, a cooldown
  // getter backed by `sharedSyncCooldownMs`, a try/catch piggyback call
  // inside runCycleForCredential, plus a `syncCatalog()` method and a
  // matching `catalog` CLI command. Both were intentionally removed
  // alongside this note to keep the surface honest — we don't want a CLI
  // command that prints "✓ catalog sync complete" while doing nothing.

  private getClient(): { client: RunnerClient; db: RunnerDb } {
    if (!this.client || !this.db) {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error('DATABASE_URL is required');
      }
      // prepare: false matches aurora-sync — Railway's pooled URL uses
      // PgBouncer in transaction mode, which is incompatible with prepared
      // statements. Direct (non-pooled) URLs work either way, so this is
      // the safe default for both.
      this.client = postgres(connectionString, {
        max: 5,
        idle_timeout: 30,
        connect_timeout: 30,
        prepare: false,
      });
      this.db = drizzle(this.client);
    }
    return { client: this.client, db: this.db };
  }

  private getKeycloakClient(): KeycloakClientConfig {
    const clientId = process.env.KILTER_OAUTH_CLIENT_ID;
    if (!clientId) {
      throw new Error('KILTER_OAUTH_CLIENT_ID is required for kilter-sync');
    }
    return {
      clientId,
      // Confidential clients only: leave unset for public PKCE clients.
      clientSecret: process.env.KILTER_OAUTH_CLIENT_SECRET,
    };
  }

  private log(message: string): void {
    if (this.config.onLog) {
      this.config.onLog(message);
    } else {
      console.info(message);
    }
  }

  private handleError(error: Error, context: { userId?: string; board?: string }): void {
    if (this.config.onError) {
      this.config.onError(error, context);
    } else {
      console.error(`[KilterSyncRunner] Error:`, error, context);
    }
  }

  /**
   * Sync exactly one user — the daemon's per-cycle unit. Picks the oldest
   * `last_sync_at` (NULLs first) credential that's neither disabled nor
   * permanently errored.
   */
  async syncNextUser(): Promise<SyncSummary> {
    const summary: SyncSummary = { total: 1, successful: 0, failed: 0, errors: [] };
    const { db } = this.getClient();

    const cred = await this.getNextCredentialToSync(db);
    if (!cred) {
      summary.total = 0;
      return summary;
    }

    try {
      await this.runCycleForCredential(db, cred);
      summary.successful = 1;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const transient = isTransientKilterError(err);

      if (transient) {
        // Don't touch syncStatus — retry next cycle. Surface the message
        // so the daemon log shows what's been retrying.
        this.handleError(err, { userId: cred.userId, board: KILTER_BOARD_TYPE });
        summary.failed = 1;
        summary.errors.push({ userId: cred.userId, boardType: KILTER_BOARD_TYPE, error: err.message });
        return summary;
      }

      // Permanent failure — mark errored so the next cycle picks a
      // different user. invalid_grant maps to 'expired' specifically so
      // the UI knows to prompt re-auth instead of "something went wrong".
      const isExpired = err instanceof KilterApiError && err.code === 'invalid_grant';
      const status = isExpired ? 'expired' : 'error';
      await db
        .update(auroraCredentials)
        .set({ syncStatus: status, syncError: err.message, updatedAt: new Date() })
        .where(and(eq(auroraCredentials.userId, cred.userId), eq(auroraCredentials.boardType, KILTER_BOARD_TYPE)));

      this.handleError(err, { userId: cred.userId, board: KILTER_BOARD_TYPE });
      summary.failed = 1;
      summary.errors.push({ userId: cred.userId, boardType: KILTER_BOARD_TYPE, error: err.message });
    }

    return summary;
  }

  /**
   * Force a sync for a specific user (CLI `kilter-sync user <userId>`).
   * Errors propagate to the caller so a CLI run prints the failure.
   */
  async syncUser(userId: string): Promise<void> {
    const { db } = this.getClient();
    const cred = await this.getCredential(db, userId);
    if (!cred) {
      throw new Error(`No kilter credential for user ${userId}`);
    }
    await this.runCycleForCredential(db, cred);
  }

  private async runCycleForCredential(db: RunnerDb, cred: KilterCredentialRecord): Promise<void> {
    const accessToken = await this.refreshTokenFor(cred, db);

    await syncKilterUserData({
      db,
      userId: cred.userId,
      accessToken,
      log: (msg) => this.log(msg),
    });

    // Push-back (Boardsesh → Kilter for ticks/ratings/circuits) is gated
    // behind KILTER_SYNC_PUSH_ENABLED. Pull works end-to-end against a
    // real account; push waits on a separate verification pass that
    // involves writing to a real Kilter database, which we shouldn't do
    // speculatively from sync. See packages/kilter-sync/src/sync/push-back.ts.

    await db
      .update(auroraCredentials)
      .set({
        lastSyncAt: new Date(),
        syncStatus: 'active',
        syncError: null,
        updatedAt: new Date(),
      })
      .where(and(eq(auroraCredentials.userId, cred.userId), eq(auroraCredentials.boardType, KILTER_BOARD_TYPE)));

    // Piggyback catalog refresh is intentionally not invoked here — wire
    // it up via the comment block above the class once the catalog
    // mapping is implemented.
  }

  private async refreshTokenFor(cred: KilterCredentialRecord, db: RunnerDb): Promise<string> {
    if (!cred.encryptedRefreshToken) {
      throw new KilterApiError(
        'invalid_grant',
        `Kilter credential for ${cred.userId} has no refresh token — user must reconnect`,
      );
    }

    const refreshToken = decrypt(cred.encryptedRefreshToken);
    const response = await refreshAccessToken({
      refreshToken,
      client: this.getKeycloakClient(),
    });

    // Keycloak rotates refresh tokens on each refresh by default. Persist
    // the new one (encrypted) so the next cycle uses the fresh value;
    // re-using a stale refresh_token after rotation gets you invalid_grant.
    // Use the caller's db handle so the rotation update lands in the same
    // connection as the rest of the cycle (matters under PgBouncer
    // transaction pooling — opening a second connection here would put
    // the writes on a different session).
    if (response.refresh_token && response.refresh_token !== refreshToken) {
      await db
        .update(auroraCredentials)
        .set({
          encryptedRefreshToken: encrypt(response.refresh_token),
          updatedAt: new Date(),
        })
        .where(and(eq(auroraCredentials.userId, cred.userId), eq(auroraCredentials.boardType, KILTER_BOARD_TYPE)));
    }

    return response.access_token;
  }

  /**
   * Filter mirrors aurora-sync's syncableCredentialsFilter — board_type
   * scoped, refresh token present, syncStatus ∈ {pending, active, error}
   * (skip disabled + expired).
   */
  private async getNextCredentialToSync(db: RunnerDb): Promise<KilterCredentialRecord | null> {
    const rows = await db
      .select({
        userId: auroraCredentials.userId,
        boardType: auroraCredentials.boardType,
        encryptedRefreshToken: auroraCredentials.encryptedRefreshToken,
        syncStatus: auroraCredentials.syncStatus,
        syncError: auroraCredentials.syncError,
        lastSyncAt: auroraCredentials.lastSyncAt,
      })
      .from(auroraCredentials)
      .where(
        and(
          eq(auroraCredentials.boardType, KILTER_BOARD_TYPE),
          isNotNull(auroraCredentials.encryptedRefreshToken),
          // The allowed set is positive (pending/active/error). 'expired'
          // and 'disabled' are excluded by omission — adding explicit
          // ne() clauses for them would be dead code given the or().
          or(
            eq(auroraCredentials.syncStatus, 'pending'),
            eq(auroraCredentials.syncStatus, 'active'),
            eq(auroraCredentials.syncStatus, 'error'),
          ),
        ),
      )
      .orderBy(sql`${auroraCredentials.lastSyncAt} ASC NULLS FIRST`)
      .limit(1);

    return rows[0] ?? null;
  }

  private async getCredential(db: RunnerDb, userId: string): Promise<KilterCredentialRecord | null> {
    const rows = await db
      .select({
        userId: auroraCredentials.userId,
        boardType: auroraCredentials.boardType,
        encryptedRefreshToken: auroraCredentials.encryptedRefreshToken,
        syncStatus: auroraCredentials.syncStatus,
        syncError: auroraCredentials.syncError,
        lastSyncAt: auroraCredentials.lastSyncAt,
      })
      .from(auroraCredentials)
      .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, KILTER_BOARD_TYPE)))
      .limit(1);

    return rows[0] ?? null;
  }

  async runDaemon(options: DaemonOptions = {}): Promise<void> {
    const resolved: ResolvedDaemonOptions = resolveDaemonOptions(options);
    this.daemonController = new AbortController();
    try {
      await runDaemonLoop(
        async () => {
          await this.syncNextUser();
        },
        resolved,
        { signal: this.daemonController.signal, onLog: (m: string) => this.log(m) },
      );
    } finally {
      this.daemonController = null;
    }
  }

  async stop(): Promise<void> {
    this.daemonController?.abort();
    if (this.client) {
      await this.client.end({ timeout: 5 });
      this.client = null;
      this.db = null;
    }
  }
}

export { DEFAULT_DAEMON_OPTIONS };
