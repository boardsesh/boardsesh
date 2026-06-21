import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, ne, and, or, isNotNull, sql } from 'drizzle-orm';

import { auroraCredentials } from '@boardsesh/db/schema/auth';
import { syncUserData } from '../sync/user-sync';
import { syncSharedData } from '../sync/shared-sync';
import {
  AURORA_LOCATION_BOARDS,
  syncAllAuroraBoardLocations,
  syncAuroraBoardLocations,
  type AuroraLocationBoardName,
} from '../sync/locations-sync';
import { AuroraClimbingClient } from '../api/aurora-client';
import { isAuroraRequestError, isTransientAuroraError } from '../api/errors';
import { decrypt, encrypt } from '@boardsesh/crypto';
import type { LocationSyncSummary } from '@boardsesh/location-sync';
import type { AuroraBoardName } from '../api/types';
import { resolveDaemonOptions, runDaemonLoop } from './daemon';
import type { SyncRunnerConfig, SyncSummary, CredentialRecord, DaemonOptions } from './types';

type RunnerClient = ReturnType<typeof postgres>;
type RunnerDb = ReturnType<typeof drizzle>;

// Cooldown between shared-sync attempts on the same board, regardless of which
// user-sync triggered them. Without this, if N users on the same board cycle
// in quick succession, we'd fire N independent shared-sync loops against
// Aurora and N independent setter-notification scans — all redundant, since
// the per-table cursors mean only the first one would actually find new rows.
// 1 hour matches the smallest unit of meaningful change for board-wide data
// (climbs, climb_stats); tune via SyncRunnerConfig.sharedSyncCooldownMs.
const DEFAULT_SHARED_SYNC_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_CREDENTIAL_FAILURES = 2;

type CredentialFailureUpdate = {
  credentialFailureCount?: number;
  lastCredentialFailureAt?: Date | null;
};

export class SyncRunner {
  private config: SyncRunnerConfig;
  private daemonController: AbortController | null = null;
  private client: RunnerClient | null = null;
  private db: RunnerDb | null = null;
  private lastSharedSyncAt = new Map<string, number>();

  constructor(config: SyncRunnerConfig = {}) {
    this.config = config;
  }

  private getSharedSyncCooldownMs(): number {
    return this.config.sharedSyncCooldownMs ?? DEFAULT_SHARED_SYNC_COOLDOWN_MS;
  }

  private getClient(): { client: RunnerClient; db: RunnerDb } {
    if (!this.client || !this.db) {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error('DATABASE_URL is required');
      }
      // `prepare: false` is required for Railway's PgBouncer pooled URL
      // (transaction-pooling mode is incompatible with prepared statements).
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
      console.error(`[SyncRunner] Error:`, error, context);
    }
  }

  async syncNextUser(): Promise<SyncSummary> {
    const results: SyncSummary = {
      total: 1,
      successful: 0,
      failed: 0,
      errors: [],
    };

    const cred = await this.getNextCredentialToSync();

    if (!cred) {
      this.log(`[SyncRunner] No users with Aurora credentials to sync`);
      results.total = 0;
      return results;
    }

    this.log(`[SyncRunner] Syncing next user: ${cred.userId} for ${cred.boardType}`);

    try {
      await this.syncSingleCredential(cred);
      results.successful++;
      this.log(`[SyncRunner] ✓ Successfully synced user ${cred.userId} for ${cred.boardType}`);
    } catch (error) {
      results.failed++;
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      results.errors.push({
        userId: cred.userId,
        boardType: cred.boardType,
        error: errorMsg,
      });
      this.handleError(error instanceof Error ? error : new Error(errorMsg), {
        userId: cred.userId,
        board: cred.boardType,
      });
      this.log(`[SyncRunner] ✗ Failed to sync user ${cred.userId} for ${cred.boardType}: ${errorMsg}`);
    }

    return results;
  }

  /** @deprecated Use syncNextUser() instead to avoid IP blocking */
  async syncAllUsers(): Promise<SyncSummary> {
    const results: SyncSummary = {
      total: 0,
      successful: 0,
      failed: 0,
      errors: [],
    };

    const credentials = await this.getActiveCredentials();
    results.total = credentials.length;

    this.log(`[SyncRunner] Found ${credentials.length} users with Aurora credentials to sync`);

    for (const cred of credentials) {
      try {
        await this.syncSingleCredential(cred);
        await new Promise((resolve) => setTimeout(resolve, 10000));
        results.successful++;
        this.log(`[SyncRunner] ✓ Successfully synced user ${cred.userId} for ${cred.boardType}`);
      } catch (error) {
        results.failed++;
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        results.errors.push({
          userId: cred.userId,
          boardType: cred.boardType,
          error: errorMsg,
        });
        this.handleError(error instanceof Error ? error : new Error(errorMsg), {
          userId: cred.userId,
          board: cred.boardType,
        });
        this.log(`[SyncRunner] ✗ Failed to sync user ${cred.userId} for ${cred.boardType}: ${errorMsg}`);
      }
    }

    return results;
  }

  async syncUser(userId: string, boardType: string): Promise<void> {
    const { db } = this.getClient();
    const credentials = await db
      .select()
      .from(auroraCredentials)
      .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, boardType)))
      .limit(1);

    if (credentials.length === 0) {
      throw new Error(`No credentials found for user ${userId} on ${boardType}`);
    }

    const cred = credentials[0] as CredentialRecord;
    await this.syncSingleCredential(cred);
  }

  async runDaemon(options: DaemonOptions = {}): Promise<void> {
    if (this.daemonController && !this.daemonController.signal.aborted) {
      throw new Error('Daemon mode is already running');
    }

    const resolved = resolveDaemonOptions(options);
    const controller = new AbortController();
    this.daemonController = controller;

    this.log(
      `[SyncRunner] Starting daemon mode (${resolved.timeZone}, quiet ${resolved.quietHoursStart}:00-${resolved.quietHoursEnd}:00, random interval ${resolved.minDelayMinutes}-${resolved.maxDelayMinutes} minutes)`,
    );

    try {
      await runDaemonLoop(
        async () => {
          await this.syncNextUser();
        },
        resolved,
        {
          signal: controller.signal,
          onLog: this.log.bind(this),
          onCycleError: (error) => {
            const err = error instanceof Error ? error : new Error(String(error));
            this.handleError(err, {});
            this.log(`[SyncRunner] Daemon cycle failed: ${err.message}`);
          },
        },
      );
    } finally {
      this.daemonController = null;
      this.log('[SyncRunner] Daemon mode stopped');
    }
  }

  private syncableCredentialsFilter() {
    return and(
      or(
        eq(auroraCredentials.syncStatus, 'pending'),
        eq(auroraCredentials.syncStatus, 'active'),
        eq(auroraCredentials.syncStatus, 'error'),
      ),
      isNotNull(auroraCredentials.encryptedUsername),
      isNotNull(auroraCredentials.encryptedPassword),
      isNotNull(auroraCredentials.auroraUserId),
      ne(auroraCredentials.boardType, 'kilter'),
    );
  }

  private async getActiveCredentials(): Promise<CredentialRecord[]> {
    const { db } = this.getClient();
    const credentials = await db.select().from(auroraCredentials).where(this.syncableCredentialsFilter());
    return credentials as CredentialRecord[];
  }

  private async getNextCredentialToSync(): Promise<CredentialRecord | null> {
    const { db } = this.getClient();
    const credentials = await db
      .select()
      .from(auroraCredentials)
      .where(this.syncableCredentialsFilter())
      .orderBy(sql`${auroraCredentials.lastSyncAt} ASC NULLS FIRST`)
      .limit(1);

    return credentials.length > 0 ? (credentials[0] as CredentialRecord) : null;
  }

  private async syncSingleCredential(cred: CredentialRecord): Promise<void> {
    if (!cred.encryptedUsername || !cred.encryptedPassword || !cred.auroraUserId) {
      throw new Error('Missing credentials or user ID');
    }

    const boardType = cred.boardType as AuroraBoardName;

    let username: string;
    let password: string;
    try {
      username = decrypt(cred.encryptedUsername);
      password = decrypt(cred.encryptedPassword);
    } catch (decryptError) {
      const errorMessage = `Decryption failed: ${this.formatErrorMessage(decryptError)}`;
      await this.updateCredentialStatus(cred.userId, cred.boardType, 'error', errorMessage);
      throw new Error(errorMessage);
    }

    this.log(`[SyncRunner] Getting fresh token for user ${cred.userId} (${boardType})...`);
    const auroraClient = new AuroraClimbingClient({ boardName: boardType });
    let token: string;

    try {
      const loginResponse = await auroraClient.signIn(username, password);
      if (!loginResponse.token) {
        throw new Error('Login succeeded but no token returned');
      }
      token = loginResponse.token;
    } catch (loginError) {
      if (isTransientAuroraError(loginError)) {
        this.log(
          `[SyncRunner] Transient Aurora login error for user ${cred.userId} (${boardType}); will retry later: ${(loginError as Error).message}`,
        );
        throw loginError;
      }

      const errorMessage = `Login failed: ${this.formatErrorMessage(loginError)}`;
      if (this.isInvalidCredentialError(loginError)) {
        const storedErrorMessage = await this.recordInvalidCredentialFailure(cred, errorMessage);
        throw new Error(storedErrorMessage);
      } else {
        await this.updateCredentialStatus(cred.userId, cred.boardType, 'error', errorMessage);
        throw new Error(errorMessage);
      }
    }

    await this.updateStoredToken(cred.userId, cred.boardType, token);

    const { client } = this.getClient();
    this.log(`[SyncRunner] Syncing user ${cred.userId} for ${boardType}...`);
    await syncUserData(client, boardType, token, cred.auroraUserId, cred.userId, undefined, this.log.bind(this));
    await this.updateCredentialStatus(cred.userId, cred.boardType, 'active', null, new Date(), {
      credentialFailureCount: 0,
      lastCredentialFailureAt: null,
    });

    // Piggyback shared sync onto user sync — the user's fresh token
    // authenticates the shared `/sync` request the same way the old Vercel
    // cron's *_SYNC_TOKEN env vars used to. Throttled per board so that N
    // consecutive user syncs for the same board don't fire N independent
    // shared-sync loops (and N copies of setter notifications for the same
    // pre-existing climbs). Failures here must not poison the user's
    // credential status, since the user-half already succeeded.
    await this.maybeRunSharedSync(boardType, token, cred.userId);
  }

  private async maybeRunSharedSync(boardType: AuroraBoardName, token: string, userId: string): Promise<void> {
    const cooldownMs = this.getSharedSyncCooldownMs();
    const lastRunAt = this.lastSharedSyncAt.get(boardType);
    const now = Date.now();

    if (lastRunAt !== undefined && now - lastRunAt < cooldownMs) {
      const remainingMs = cooldownMs - (now - lastRunAt);
      this.log(
        `[SyncRunner] Skipping shared sync for ${boardType} (last run ${Math.round(
          (now - lastRunAt) / 1000,
        )}s ago; cooldown ${Math.round(cooldownMs / 1000)}s, ${Math.round(remainingMs / 1000)}s remaining)`,
      );
      return;
    }

    // Stamp the timestamp before running so a concurrent caller (or the next
    // user-sync that lands while we're still working) doesn't also fire. Stamp
    // again on success/failure so partial work counts toward the cooldown
    // either way — a permanent failure shouldn't loop on every cycle.
    this.lastSharedSyncAt.set(boardType, now);

    const { client, db } = this.getClient();
    try {
      this.log(`[SyncRunner] Running shared sync for ${boardType} using ${userId}'s token...`);
      await syncSharedData(client, boardType, token, this.log.bind(this));
      if (this.isLocationBoard(boardType)) {
        await syncAuroraBoardLocations({ db, board: boardType, log: this.log.bind(this) });
      }
      this.lastSharedSyncAt.set(boardType, Date.now());
    } catch (sharedError) {
      this.lastSharedSyncAt.set(boardType, Date.now());
      const sharedErrorMessage = this.formatErrorMessage(sharedError);
      this.handleError(sharedError instanceof Error ? sharedError : new Error(sharedErrorMessage), {
        board: boardType,
        userId,
      });
      this.log(`[SyncRunner] Shared sync for ${boardType} failed (user sync was OK): ${sharedErrorMessage}`);
    }
  }

  async syncLocations(
    board: AuroraLocationBoardName | 'all',
  ): Promise<LocationSyncSummary | Record<AuroraLocationBoardName, LocationSyncSummary>> {
    const { db } = this.getClient();
    if (board === 'all') {
      return syncAllAuroraBoardLocations({ db, log: this.log.bind(this) });
    }
    return syncAuroraBoardLocations({ db, board, log: this.log.bind(this) });
  }

  private isLocationBoard(boardType: AuroraBoardName): boardType is AuroraLocationBoardName {
    return AURORA_LOCATION_BOARDS.includes(boardType as AuroraLocationBoardName);
  }

  private async updateCredentialStatus(
    userId: string,
    boardType: string,
    status: string,
    error: string | null,
    lastSyncAt?: Date,
    credentialFailureUpdate: CredentialFailureUpdate = {},
  ): Promise<void> {
    const { db } = this.getClient();
    const updateData: Record<string, unknown> = {
      syncStatus: status,
      syncError: error,
      updatedAt: new Date(),
    };

    if (lastSyncAt) {
      updateData.lastSyncAt = lastSyncAt;
    }

    if (credentialFailureUpdate.credentialFailureCount !== undefined) {
      updateData.credentialFailureCount = credentialFailureUpdate.credentialFailureCount;
    }

    if (credentialFailureUpdate.lastCredentialFailureAt !== undefined) {
      updateData.lastCredentialFailureAt = credentialFailureUpdate.lastCredentialFailureAt;
    }

    await db
      .update(auroraCredentials)
      .set(updateData)
      .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, boardType)));
  }

  private isInvalidCredentialError(error: unknown): boolean {
    return isAuroraRequestError(error) && error.code === 'invalid_credentials';
  }

  private async recordInvalidCredentialFailure(cred: CredentialRecord, errorMessage: string): Promise<string> {
    const credentialFailureCount = (cred.credentialFailureCount ?? 0) + 1;
    const expired = credentialFailureCount >= MAX_CREDENTIAL_FAILURES;
    const storedErrorMessage = expired
      ? `${errorMessage} (expired after ${MAX_CREDENTIAL_FAILURES} failed credential attempts; reconnect to resume sync)`
      : errorMessage;

    await this.updateCredentialStatus(
      cred.userId,
      cred.boardType,
      expired ? 'expired' : 'error',
      storedErrorMessage,
      undefined,
      {
        credentialFailureCount,
        lastCredentialFailureAt: new Date(),
      },
    );

    return storedErrorMessage;
  }

  private async updateStoredToken(userId: string, boardType: string, token: string): Promise<void> {
    const encryptedToken = encrypt(token);
    const { db } = this.getClient();
    await db
      .update(auroraCredentials)
      .set({
        auroraToken: encryptedToken,
        credentialFailureCount: 0,
        lastCredentialFailureAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, boardType)));
  }

  async close(): Promise<void> {
    this.daemonController?.abort();
    if (this.client) {
      try {
        await this.client.end();
      } finally {
        this.client = null;
        this.db = null;
      }
    }
  }

  private formatErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}

export default SyncRunner;
