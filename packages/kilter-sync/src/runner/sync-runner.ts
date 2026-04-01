/**
 * Kilter sync runner — authenticates via OAuth2 and syncs user data
 * from the new Kilter API (portal.kiltergrips.com).
 *
 * Only processes credentials where boardType = 'kilter'.
 */

import { neon, neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle as drizzleHttp } from 'drizzle-orm/neon-http';
import { eq, and, or, isNotNull, sql } from 'drizzle-orm';
import ws from 'ws';

import { auroraCredentials } from '@boardsesh/db/schema/auth';
import { syncKilterUserData } from '../sync/user-sync';
import { KilterClient } from '../api/kilter-client';
import { decrypt, encrypt } from '@boardsesh/crypto';
import type { KilterSyncRunnerConfig, KilterSyncSummary, KilterCredentialRecord } from './types';

neonConfig.webSocketConstructor = ws;

function createFreshPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }
  return new Pool({
    connectionString,
    connectionTimeoutMillis: 30000,
    idleTimeoutMillis: 30000,
    max: 5,
  });
}

function createHttpDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }
  const sqlClient = neon(connectionString);
  return drizzleHttp({ client: sqlClient });
}

export class KilterSyncRunner {
  private config: KilterSyncRunnerConfig;

  constructor(config: KilterSyncRunnerConfig = {}) {
    this.config = config;
  }

  private log(message: string): void {
    if (this.config.onLog) {
      this.config.onLog(message);
    } else {
      console.log(message);
    }
  }

  private handleError(error: Error, context: { userId?: string }): void {
    if (this.config.onError) {
      this.config.onError(error, context);
    } else {
      console.error(`[KilterSyncRunner] Error:`, error, context);
    }
  }

  /**
   * Sync the next Kilter user that needs syncing (oldest lastSyncAt first).
   */
  async syncNextUser(): Promise<KilterSyncSummary> {
    const results: KilterSyncSummary = {
      total: 1,
      successful: 0,
      failed: 0,
      errors: [],
    };

    const cred = await this.getNextCredentialToSync();

    if (!cred) {
      this.log(`[KilterSyncRunner] No Kilter users to sync`);
      results.total = 0;
      return results;
    }

    this.log(`[KilterSyncRunner] Syncing user: ${cred.userId}`);

    try {
      await this.syncSingleCredential(cred);
      results.successful++;
      this.log(`[KilterSyncRunner] Successfully synced user ${cred.userId}`);
    } catch (error) {
      results.failed++;
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      results.errors.push({ userId: cred.userId, error: errorMsg });
      this.handleError(error instanceof Error ? error : new Error(errorMsg), { userId: cred.userId });
      this.log(`[KilterSyncRunner] Failed to sync user ${cred.userId}: ${errorMsg}`);
    }

    return results;
  }

  /**
   * Sync a specific user by NextAuth userId.
   */
  async syncUser(userId: string): Promise<void> {
    const db = createHttpDb();
    const credentials = await db
      .select()
      .from(auroraCredentials)
      .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, 'kilter')))
      .limit(1);

    if (credentials.length === 0) {
      throw new Error(`No Kilter credentials found for user ${userId}`);
    }

    await this.syncSingleCredential(credentials[0] as KilterCredentialRecord);
  }

  private async getNextCredentialToSync(): Promise<KilterCredentialRecord | null> {
    const db = createHttpDb();
    const credentials = await db
      .select()
      .from(auroraCredentials)
      .where(
        and(
          eq(auroraCredentials.boardType, 'kilter'),
          or(eq(auroraCredentials.syncStatus, 'active'), eq(auroraCredentials.syncStatus, 'error')),
          isNotNull(auroraCredentials.encryptedUsername),
          isNotNull(auroraCredentials.encryptedPassword),
          isNotNull(auroraCredentials.auroraUserId),
        ),
      )
      .orderBy(sql`${auroraCredentials.lastSyncAt} ASC NULLS FIRST`)
      .limit(1);

    return credentials.length > 0 ? (credentials[0] as KilterCredentialRecord) : null;
  }

  private async syncSingleCredential(cred: KilterCredentialRecord): Promise<void> {
    if (!cred.encryptedUsername || !cred.encryptedPassword) {
      throw new Error('Missing credentials');
    }

    let username: string;
    let password: string;
    try {
      username = decrypt(cred.encryptedUsername);
      password = decrypt(cred.encryptedPassword);
    } catch (decryptError) {
      await this.updateCredentialStatus(cred.userId, 'error', `Decryption failed: ${decryptError}`);
      throw new Error(`Failed to decrypt credentials: ${decryptError}`);
    }

    // Authenticate with new Kilter OAuth2
    this.log(`[KilterSyncRunner] Authenticating user ${cred.userId} via Kilter OAuth2...`);
    const kilterClient = new KilterClient();
    let accessToken: string;

    try {
      const loginResult = await kilterClient.signIn(username, password);
      accessToken = loginResult.accessToken;
    } catch (loginError) {
      await this.updateCredentialStatus(cred.userId, 'error', `Login failed: ${loginError}`);
      throw new Error(`Kilter OAuth2 login failed: ${loginError}`);
    }

    // Store the new token
    await this.updateStoredToken(cred.userId, accessToken);

    // Sync user data
    const pool = createFreshPool();
    try {
      const auroraUserId = cred.auroraUserId || 0;
      this.log(`[KilterSyncRunner] Syncing data for user ${cred.userId} (aurora ID: ${auroraUserId})...`);
      const syncResult = await syncKilterUserData(
        pool,
        accessToken,
        auroraUserId,
        cred.userId,
        undefined,
        this.log.bind(this),
      );

      // Back-populate the numeric user ID if we discovered it
      if (syncResult.discoveredAuroraUserId && syncResult.discoveredAuroraUserId !== auroraUserId) {
        this.log(`[KilterSyncRunner] Back-populating auroraUserId: ${syncResult.discoveredAuroraUserId}`);
        await this.updateAuroraUserId(cred.userId, syncResult.discoveredAuroraUserId);
      }

      await this.updateCredentialStatus(cred.userId, 'active', null, new Date());
    } finally {
      await pool.end();
    }
  }

  private async updateCredentialStatus(
    userId: string,
    status: string,
    error: string | null,
    lastSyncAt?: Date,
  ): Promise<void> {
    const db = createHttpDb();
    const updateData: Record<string, unknown> = {
      syncStatus: status,
      syncError: error,
      updatedAt: new Date(),
    };
    if (lastSyncAt) {
      updateData.lastSyncAt = lastSyncAt;
    }

    await db
      .update(auroraCredentials)
      .set(updateData)
      .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, 'kilter')));
  }

  private async updateAuroraUserId(userId: string, auroraUserId: number): Promise<void> {
    const db = createHttpDb();
    await db
      .update(auroraCredentials)
      .set({ auroraUserId, updatedAt: new Date() })
      .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, 'kilter')));
  }

  private async updateStoredToken(userId: string, token: string): Promise<void> {
    const encryptedToken = encrypt(token);
    const db = createHttpDb();
    await db
      .update(auroraCredentials)
      .set({ auroraToken: encryptedToken, updatedAt: new Date() })
      .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, 'kilter')));
  }

  async close(): Promise<void> {
    // No-op — pools are created and closed per operation
  }
}

export default KilterSyncRunner;
