import { NextResponse } from 'next/server';
import { getDb } from '@/app/lib/db/db';
import { eq, and, or, isNotNull, asc } from 'drizzle-orm';
import { decrypt, encrypt } from '@boardsesh/crypto';
import * as schema from '@/app/lib/db/schema';
import { KilterClient, syncKilterUserData } from '@boardsesh/kilter-sync';
import { getPool } from '@/app/lib/db/db';
import { drizzle } from 'drizzle-orm/neon-serverless';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;

interface SyncResult {
  userId: string;
  error?: string;
}

/**
 * GET /api/internal/kilter-sync-cron
 *
 * Syncs ONE Kilter user per invocation using the new Kilter OAuth2 API.
 * Picks the credential with the oldest lastSyncAt.
 */
export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    if (process.env.VERCEL_ENV !== 'development' && authHeader !== `Bearer ${CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const pool = getPool();

    // Get ONE Kilter credential to sync
    let credentials;
    {
      const client = await pool.connect();
      try {
        const db = drizzle(client);
        credentials = await db
          .select()
          .from(schema.auroraCredentials)
          .where(
            and(
              eq(schema.auroraCredentials.boardType, 'kilter'),
              or(
                eq(schema.auroraCredentials.syncStatus, 'active'),
                eq(schema.auroraCredentials.syncStatus, 'error'),
              ),
              isNotNull(schema.auroraCredentials.encryptedUsername),
              isNotNull(schema.auroraCredentials.encryptedPassword),
            ),
          )
          .orderBy(asc(schema.auroraCredentials.lastSyncAt))
          .limit(1);
      } finally {
        client.release();
      }
    }

    if (credentials.length === 0) {
      console.log('[Kilter Sync Cron] No Kilter users to sync');
      return NextResponse.json({
        success: true,
        results: { total: 0, successful: 0, failed: 0, errors: [] },
        timestamp: new Date().toISOString(),
      });
    }

    const cred = credentials[0];
    console.log(`[Kilter Sync Cron] Syncing user ${cred.userId}`);

    const results = {
      total: 1,
      successful: 0,
      failed: 0,
      errors: [] as SyncResult[],
    };

    try {
      if (!cred.encryptedUsername || !cred.encryptedPassword) {
        throw new Error('Missing encrypted credentials');
      }

      const username = decrypt(cred.encryptedUsername);
      const password = decrypt(cred.encryptedPassword);

      // Authenticate with new Kilter OAuth2
      console.log(`[Kilter Sync Cron] Authenticating via Kilter OAuth2...`);
      const kilterClient = new KilterClient();
      const loginResult = await kilterClient.signIn(username, password);

      // Store the fresh token
      const encryptedToken = encrypt(loginResult.accessToken);
      const db = getDb();
      await db
        .update(schema.auroraCredentials)
        .set({ auroraToken: encryptedToken, updatedAt: new Date() })
        .where(
          and(
            eq(schema.auroraCredentials.userId, cred.userId),
            eq(schema.auroraCredentials.boardType, 'kilter'),
          ),
        );

      // If we don't have a numeric user ID yet, we need the sync to discover it.
      // The sync stream will return user data that includes the numeric ID.
      const auroraUserId = cred.auroraUserId || 0;

      console.log(`[Kilter Sync Cron] Syncing data for user ${cred.userId} (aurora ID: ${auroraUserId})...`);

      await syncKilterUserData(pool, loginResult.accessToken, auroraUserId, cred.userId);

      // Update last sync time on success
      {
        const updateClient = await pool.connect();
        try {
          const updateDb = drizzle(updateClient);
          await updateDb
            .update(schema.auroraCredentials)
            .set({
              lastSyncAt: new Date(),
              syncStatus: 'active',
              syncError: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.auroraCredentials.userId, cred.userId),
                eq(schema.auroraCredentials.boardType, 'kilter'),
              ),
            );
        } finally {
          updateClient.release();
        }
      }

      results.successful++;
      console.log(`[Kilter Sync Cron] Successfully synced user ${cred.userId}`);
    } catch (error) {
      results.failed++;
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      results.errors.push({ userId: cred.userId, error: errorMsg });

      // Update sync status to error
      const updateClient = await pool.connect();
      try {
        const updateDb = drizzle(updateClient);
        await updateDb
          .update(schema.auroraCredentials)
          .set({
            syncStatus: 'error',
            syncError: errorMsg,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.auroraCredentials.userId, cred.userId),
              eq(schema.auroraCredentials.boardType, 'kilter'),
            ),
          );
      } catch (updateError) {
        console.error(`[Kilter Sync Cron] Failed to update error status:`, updateError);
      } finally {
        updateClient.release();
      }

      console.error(`[Kilter Sync Cron] Failed to sync user ${cred.userId}:`, errorMsg);
    }

    return NextResponse.json({
      success: true,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Kilter Sync Cron] Cron job failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
