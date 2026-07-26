import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';

import { db } from '../db/client';
import { auroraCredentials } from '@boardsesh/db/schema';
import { claimNextCredentialForSync } from '@boardsesh/db/queries';

// ---------------------------------------------------------------------------
// Credential selection + exponential backoff (real DB)
//
// Both sync runners (kilter-sync, aurora-sync) pick the next credential with the
// SAME shape: the syncable set (pending/active/error) filtered by
// credentialRetryReadySql() and ordered by the attempt clock
// (last_sync_attempt_at ASC NULLS FIRST). A bug here stalls ALL syncing — a
// perma-failing credential must not monopolise the single-user-per-cycle queue.
//
// These tests exercise the shared SQL predicate against a real Postgres (the
// JS mirror is unit-tested in packages/db credential-backoff.test.ts): a
// credential inside its consecutive-failure window is skipped, the oldest
// eligible healthy credential is picked instead, and the window releases once
// last_sync_attempt_at + backoff(n) has elapsed. Timestamps are seeded DB-side
// (now() - interval) so they line up with the predicate's own now().
// ---------------------------------------------------------------------------

// consecutive_failures → backoff window: base 2m · 2^(n-1), capped at 6h.
//   5 → 32m (test's "recently failed, still backing off")
//   9 → 6h  (test's "perma-failing, long window")
const USER_FAIL = 'sel-backoff-fail';
const USER_H1 = 'sel-backoff-h1';
const USER_H2 = 'sel-backoff-h2';
const ALL_USERS = [USER_FAIL, USER_H1, USER_H2];

async function insertUser(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

/** Seed a kilter credential with an explicit attempt clock + failure count. */
async function seedCredential(opts: {
  userId: string;
  syncStatus: 'pending' | 'active' | 'error' | 'expired' | 'disabled';
  consecutiveFailures: number;
  /** SQL expression for last_sync_attempt_at (e.g. sql`now() - interval '20 minutes'`, or sql`NULL`). */
  lastSyncAttemptAt: ReturnType<typeof sql>;
  /** Set NULL to model a dead pre-OAuth link (excluded by the runner's filter). */
  hasRefreshToken?: boolean;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO "aurora_credentials"
      (user_id, board_type, encrypted_refresh_token, sync_status, consecutive_failures, last_sync_attempt_at)
    VALUES (${opts.userId}, 'kilter', ${opts.hasRefreshToken === false ? null : 'enc-refresh'},
            ${opts.syncStatus}, ${opts.consecutiveFailures}, ${opts.lastSyncAttemptAt})
  `);
}

/**
 * Runs the REAL selection both runners run — claimNextCredentialForSync from
 * @boardsesh/db — instead of re-expressing the predicate here. Only the
 * board-specific eligibility filter is supplied, exactly as kilter-sync's
 * syncableCredentialsFilter() does; the fairness ordering and the backoff
 * predicate come from the shared helper. Rebuilding those in the test would
 * make it a tautology that stays green while the runner drifts.
 *
 * Note this now CLAIMS: the pick stamps last_sync_attempt_at as part of the
 * same transaction, which is what makes two instances take disjoint work.
 */
async function pickNextKilterCredential(): Promise<string | null> {
  const claimed = await claimNextCredentialForSync(db, {
    candidateFilter: and(
      eq(auroraCredentials.boardType, 'kilter'),
      isNotNull(auroraCredentials.encryptedRefreshToken),
      or(
        eq(auroraCredentials.syncStatus, 'pending'),
        eq(auroraCredentials.syncStatus, 'active'),
        eq(auroraCredentials.syncStatus, 'error'),
      ),
    ),
  });
  return claimed?.userId ?? null;
}

async function clearFixtures(): Promise<void> {
  await db.execute(sql`DELETE FROM "aurora_credentials" WHERE "user_id" IN (${USER_FAIL}, ${USER_H1}, ${USER_H2})`);
  await db.execute(sql`DELETE FROM "users" WHERE "id" IN (${USER_FAIL}, ${USER_H1}, ${USER_H2})`);
}

describe('credential selection + backoff (real DB)', () => {
  beforeEach(async () => {
    await clearFixtures();
    for (const id of ALL_USERS) await insertUser(id);
  });

  it('skips a credential still inside its backoff window and picks the oldest eligible one', async () => {
    // Failed 5× and attempted just now → inside its 32-minute window.
    await seedCredential({
      userId: USER_FAIL,
      syncStatus: 'error',
      consecutiveFailures: 5,
      lastSyncAttemptAt: sql`now()`,
    });
    await seedCredential({
      userId: USER_H1,
      syncStatus: 'active',
      consecutiveFailures: 0,
      lastSyncAttemptAt: sql`now() - interval '20 minutes'`,
    });
    await seedCredential({
      userId: USER_H2,
      syncStatus: 'active',
      consecutiveFailures: 0,
      lastSyncAttemptAt: sql`now() - interval '10 minutes'`,
    });

    // The failing credential's attempt clock is the newest, so without the
    // backoff predicate it would sort last but STILL be pickable; with it, it is
    // excluded entirely and the oldest healthy credential wins.
    expect(await pickNextKilterCredential()).toBe(USER_H1);
  });

  it('a perma-failing credential never starves the two healthy ones across cycles', async () => {
    // Failed 9× (6-hour window), attempted moments ago → excluded this cycle.
    await seedCredential({
      userId: USER_FAIL,
      syncStatus: 'error',
      consecutiveFailures: 9,
      lastSyncAttemptAt: sql`now() - interval '1 minute'`,
    });
    await seedCredential({
      userId: USER_H1,
      syncStatus: 'active',
      consecutiveFailures: 0,
      lastSyncAttemptAt: sql`now() - interval '20 minutes'`,
    });
    await seedCredential({
      userId: USER_H2,
      syncStatus: 'active',
      consecutiveFailures: 0,
      lastSyncAttemptAt: sql`now() - interval '10 minutes'`,
    });

    // Cycle 1: oldest healthy (H1). Mark it attempted-now, as a successful cycle would.
    const first = await pickNextKilterCredential();
    expect(first).toBe(USER_H1);
    await db.execute(
      sql`UPDATE "aurora_credentials" SET last_sync_attempt_at = now() WHERE user_id = ${USER_H1} AND board_type = 'kilter'`,
    );

    // Cycle 2: the other healthy (H2) — the failing credential is still boxed out.
    const second = await pickNextKilterCredential();
    expect(second).toBe(USER_H2);
    expect(second).not.toBe(USER_FAIL);
  });

  it('re-admits a failing credential once its backoff window has elapsed', async () => {
    // Failed 5× (32-minute window) but last attempted 40 minutes ago → eligible
    // again, and now the oldest, so it is the one picked. Proves the failure is
    // transient-with-backoff, never a permanent exclusion.
    await seedCredential({
      userId: USER_FAIL,
      syncStatus: 'error',
      consecutiveFailures: 5,
      lastSyncAttemptAt: sql`now() - interval '40 minutes'`,
    });
    await seedCredential({
      userId: USER_H1,
      syncStatus: 'active',
      consecutiveFailures: 0,
      lastSyncAttemptAt: sql`now() - interval '10 minutes'`,
    });

    expect(await pickNextKilterCredential()).toBe(USER_FAIL);
  });

  it('treats a zero-failure credential with a recent attempt clock as retry-ready (SQL/JS parity)', async () => {
    // consecutive_failures = 0 but attempted seconds ago. The JS mirror
    // (isCredentialInBackoff) returns not-in-backoff for zero failures, and the
    // SQL predicate must agree. Without the GREATEST(n-1, 0) guard on the
    // exponent, power(2, -1) = 0.5 would fabricate a ~1-minute window here and
    // wrongly exclude a healthy credential that just happens to carry an attempt
    // timestamp (a data inconsistency, but the two paths must not diverge).
    await seedCredential({
      userId: USER_H1,
      syncStatus: 'active',
      consecutiveFailures: 0,
      lastSyncAttemptAt: sql`now()`,
    });

    expect(await pickNextKilterCredential()).toBe(USER_H1);
  });

  it('sorts a never-attempted credential first (NULLS FIRST)', async () => {
    await seedCredential({
      userId: USER_H1,
      syncStatus: 'pending',
      consecutiveFailures: 0,
      lastSyncAttemptAt: sql`NULL`,
    });
    await seedCredential({
      userId: USER_H2,
      syncStatus: 'active',
      consecutiveFailures: 0,
      lastSyncAttemptAt: sql`now() - interval '10 minutes'`,
    });

    expect(await pickNextKilterCredential()).toBe(USER_H1);
  });

  it('excludes a dead pre-OAuth link (no refresh token) even when it sorts first', async () => {
    // NULL refresh token + never attempted → would sort first, but the runner's
    // isNotNull(encrypted_refresh_token) filter keeps it out of selection.
    await seedCredential({
      userId: USER_FAIL,
      syncStatus: 'error',
      consecutiveFailures: 0,
      lastSyncAttemptAt: sql`NULL`,
      hasRefreshToken: false,
    });
    await seedCredential({
      userId: USER_H1,
      syncStatus: 'active',
      consecutiveFailures: 0,
      lastSyncAttemptAt: sql`now() - interval '10 minutes'`,
    });

    const picked = await pickNextKilterCredential();
    expect(picked).toBe(USER_H1);
    expect(picked).not.toBe(USER_FAIL);
  });
});
