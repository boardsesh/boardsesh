import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';

import { db } from '../db/client';
import { auroraCredentials } from '@boardsesh/db/schema';
import {
  CREDENTIAL_MIN_RECLAIM_GAP_MS,
  claimNextCredentialForSync,
  credentialRetryReadySql,
} from '@boardsesh/db/queries';

// ---------------------------------------------------------------------------
// Credential claiming under two concurrent daemon instances (real DB) — #3539
//
// Both runners used to pick the next credential with a bare
// `SELECT ... ORDER BY last_sync_attempt_at ASC NULLS FIRST LIMIT 1`. Nothing
// stopped two overlapping instances (every Railway rolling deploy has two) from
// answering that identically: the same user got logged into Aurora and synced
// twice, and both copies then piggybacked the same board-wide sync.
//
// claimNextCredentialForSync locks the chosen row with FOR UPDATE SKIP LOCKED
// and stamps the attempt clock before committing, so a concurrent claimer skips
// straight past the locked row instead of duplicating it — or gets nothing and
// idles for a cycle when there is no other work.
//
// These tests interleave for real. Rather than racing two promises and hoping
// the timing lands (a race that passes by luck is worse than no test), instance
// A's transaction is opened by hand and deliberately parked mid-claim, so
// instance B provably runs while A holds the row lock.
//
// #3987 added the reclaim-gap cases. SKIP LOCKED only skips a row whose lock is
// currently held; if A commits between B's snapshot and B's lock attempt, the
// lock is gone and Postgres runs an EvalPlanQual recheck of the WHERE quals
// (never the ORDER BY) against the new row version. So the claim has to
// FALSIFY a qual, not merely re-sort the row — CREDENTIAL_MIN_RECLAIM_GAP_MS is
// that qual, and "a just-claimed credential is not claimable" below is what
// pins it down deterministically. The parallel-claims test stays as a companion
// but can only ever sample the interleaving, not force it.
// ---------------------------------------------------------------------------

const USER_A = 'claim-skip-a';
const USER_B = 'claim-skip-b';
const ALL_USERS = [USER_A, USER_B];

/** kilter-sync's syncableCredentialsFilter, minus the shared ordering/backoff. */
const KILTER_CANDIDATES = and(
  eq(auroraCredentials.boardType, 'kilter'),
  isNotNull(auroraCredentials.encryptedRefreshToken),
  or(
    eq(auroraCredentials.syncStatus, 'pending'),
    eq(auroraCredentials.syncStatus, 'active'),
    eq(auroraCredentials.syncStatus, 'error'),
  ),
);

async function insertUser(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function seedCredential(userId: string, lastSyncAttemptAt: ReturnType<typeof sql>): Promise<void> {
  await db.execute(sql`
    INSERT INTO "aurora_credentials"
      (user_id, board_type, encrypted_refresh_token, sync_status, consecutive_failures, last_sync_attempt_at)
    VALUES (${userId}, 'kilter', 'enc-refresh', 'active', 0, ${lastSyncAttemptAt})
  `);
}

async function readAttemptClock(userId: string): Promise<Date | null> {
  const rows = await db
    .select({ lastSyncAttemptAt: auroraCredentials.lastSyncAttemptAt })
    .from(auroraCredentials)
    .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, 'kilter')));
  return rows[0]?.lastSyncAttemptAt ?? null;
}

async function clearFixtures(): Promise<void> {
  await db.execute(sql`DELETE FROM "aurora_credentials" WHERE "user_id" IN (${USER_A}, ${USER_B})`);
  await db.execute(sql`DELETE FROM "users" WHERE "id" IN (${USER_A}, ${USER_B})`);
}

/**
 * Hold the best candidate's row lock open on a separate connection, exactly the
 * way a mid-claim instance does, and hand back a release function. Resolves
 * only once the lock is actually held, so the caller can't run early.
 */
function parkClaimHoldingRowLock(): Promise<{ lockedUserId: string | null; release: () => void }> {
  return new Promise((resolveOuter, rejectOuter) => {
    let release!: () => void;
    const parked = new Promise<void>((resolveInner) => {
      release = resolveInner;
    });

    void db
      .transaction(async (tx) => {
        const rows = await tx
          .select({ userId: auroraCredentials.userId })
          .from(auroraCredentials)
          .where(and(KILTER_CANDIDATES, credentialRetryReadySql()))
          .orderBy(sql`${auroraCredentials.lastSyncAttemptAt} ASC NULLS FIRST`)
          .limit(1)
          .for('update', { skipLocked: true });

        resolveOuter({ lockedUserId: rows[0]?.userId ?? null, release });
        // Keep the transaction — and therefore the row lock — open until the
        // test says otherwise.
        await parked;
      })
      .catch(rejectOuter);
  });
}

describe('credential claim under concurrent daemon instances (real DB)', () => {
  const parked: Array<() => void> = [];

  beforeEach(async () => {
    await clearFixtures();
    for (const id of ALL_USERS) await insertUser(id);
  });

  afterEach(async () => {
    // Always let parked transactions finish, or the pool leaks a connection
    // into the next test.
    for (const release of parked.splice(0)) release();
    await clearFixtures();
  });

  it('a second instance skips the row the first is claiming and takes the next one', async () => {
    // A is the oldest attempt, so it is what both instances would pick.
    await seedCredential(USER_A, sql`now() - interval '30 minutes'`);
    await seedCredential(USER_B, sql`now() - interval '10 minutes'`);

    const first = await parkClaimHoldingRowLock();
    parked.push(first.release);
    expect(first.lockedUserId).toBe(USER_A);

    // Instance B runs the real claim while A still holds A's row lock. It must
    // return the OTHER credential, and must not block waiting on the lock.
    const second = await claimNextCredentialForSync(db, { candidateFilter: KILTER_CANDIDATES });
    expect(second?.userId).toBe(USER_B);

    first.release();
  });

  it('a second instance gets nothing (and idles) when the only credential is being claimed', async () => {
    await seedCredential(USER_A, sql`now() - interval '30 minutes'`);

    const first = await parkClaimHoldingRowLock();
    parked.push(first.release);
    expect(first.lockedUserId).toBe(USER_A);

    // No second candidate to fall through to: the loser must get null rather
    // than block on the lock or throw. Idling one cycle is the correct outcome.
    const second = await claimNextCredentialForSync(db, { candidateFilter: KILTER_CANDIDATES });
    expect(second).toBeNull();

    first.release();
  });

  it('claiming stamps the attempt clock so the credential rotates to the back', async () => {
    await seedCredential(USER_A, sql`now() - interval '30 minutes'`);
    await seedCredential(USER_B, sql`now() - interval '10 minutes'`);

    const before = await readAttemptClock(USER_A);
    expect(before).not.toBeNull();

    const claimed = await claimNextCredentialForSync(db, { candidateFilter: KILTER_CANDIDATES });
    expect(claimed?.userId).toBe(USER_A);

    // Stamped in the same transaction as the lock — this is what makes the row
    // unattractive to the other instance rather than merely locked.
    const after = await readAttemptClock(USER_A);
    expect(after).not.toBeNull();
    expect(after!.getTime()).toBeGreaterThan(before!.getTime());
    // And the returned row carries the post-claim value, not the stale read.
    expect(claimed?.lastSyncAttemptAt?.getTime()).toBeGreaterThan(before!.getTime());

    // The next claim therefore picks the other credential, not the same one.
    const next = await claimNextCredentialForSync(db, { candidateFilter: KILTER_CANDIDATES });
    expect(next?.userId).toBe(USER_B);
  });

  it('a just-claimed credential is not claimable again inside the reclaim gap', async () => {
    // The state a losing claimer sees during an EvalPlanQual recheck: the row is
    // committed, unlocked, healthy (consecutive_failures = 0, so the backoff
    // predicate short-circuits to TRUE) and freshly stamped. Only the reclaim
    // gap rejects it. Without that qual this claim hands back USER_A — the
    // double-hand the flake in #3987 caught.
    await seedCredential(USER_A, sql`now()`);

    expect(await claimNextCredentialForSync(db, { candidateFilter: KILTER_CANDIDATES })).toBeNull();
  });

  it('re-admits a credential once the reclaim gap has elapsed', async () => {
    // Same row, stamped further back than the gap: the gap is a few seconds of
    // race protection, not a throttle that parks work.
    const staleSeconds = Math.round(CREDENTIAL_MIN_RECLAIM_GAP_MS / 1000) * 2;
    await seedCredential(USER_A, sql`now() - make_interval(secs => ${staleSeconds})`);

    const claimed = await claimNextCredentialForSync(db, { candidateFilter: KILTER_CANDIDATES });
    expect(claimed?.userId).toBe(USER_A);
  });

  it('two parallel claims never return the same credential', async () => {
    // Genuine race on separate pool connections, as a companion to the
    // deterministic cases above. One pass samples one interleaving, so run a
    // batch: the double-hand needs the loser's lock attempt to land just after
    // the winner's commit, which no single pass can force.
    for (let attempt = 0; attempt < 20; attempt++) {
      await clearFixtures();
      for (const id of ALL_USERS) await insertUser(id);
      await seedCredential(USER_A, sql`now() - interval '30 minutes'`);
      await seedCredential(USER_B, sql`now() - interval '10 minutes'`);

      const [first, second] = await Promise.all([
        claimNextCredentialForSync(db, { candidateFilter: KILTER_CANDIDATES }),
        claimNextCredentialForSync(db, { candidateFilter: KILTER_CANDIDATES }),
      ]);

      // Either claimer may legitimately come back empty (it lost the row and
      // there was nothing left to fall through to). Only two claims of the SAME
      // row is a bug, so name both rows in the message — a bare set-size
      // assertion can't tell a double-hand from a null.
      const claimReport = `attempt ${attempt}: first=${first?.userId ?? 'null'} second=${second?.userId ?? 'null'}`;
      if (first && second) {
        expect(first.userId, `double-claimed credential — ${claimReport}`).not.toBe(second.userId);
      }
    }
  });
});
