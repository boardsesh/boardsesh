import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { and, eq, sql } from 'drizzle-orm';

// Encryption secret for encrypt()/decrypt() used inside the save services.
process.env.AURORA_CREDENTIALS_SECRET = process.env.AURORA_CREDENTIALS_SECRET ?? 'test-aurora-secret';

// saveAuroraCredential calls AuroraClimbingClient.signIn (network). Stub it so
// the upstream user_id is deterministic; the duplicate-link guard is exercised
// against the real per-worker test DB. saveKilterCredential does no network I/O.
const signInMock = vi.fn();

vi.mock('@boardsesh/aurora-sync/api', async (importOriginal) => ({
  // `assertAuroraBoardName` comes through from the real module rather than being
  // restated here: it is the guard that stops a non-Aurora board type reaching
  // `HOST_BASES`, and a hand-written copy in a mock would drift from it silently.
  ...(await importOriginal<typeof import('@boardsesh/aurora-sync/api')>()),
  AuroraClimbingClient: class {
    signIn = signInMock;
  },
  isAuroraRequestError: () => false,
}));

import { db } from '../db/client';
import { auroraCredentials, userBoardMappings } from '@boardsesh/db/schema';
import { DuplicateBoardLinkError, saveAuroraCredential, saveKilterCredential } from '../services/aurora-credentials';

const USER_A = 'dup-link-user-a';
const USER_B = 'dup-link-user-b';
const TENSION_UPSTREAM_ID = 987654;
const KILTER_SUB = 'dup-link-kilter-sub-uuid';

async function insertUser(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function clearFixtures(): Promise<void> {
  await db.execute(sql`DELETE FROM "aurora_credentials" WHERE "user_id" IN (${USER_A}, ${USER_B})`);
  await db.execute(sql`DELETE FROM "user_board_mappings" WHERE "user_id" IN (${USER_A}, ${USER_B})`);
  await db.execute(sql`DELETE FROM "users" WHERE "id" IN (${USER_A}, ${USER_B})`);
}

function auroraRows(userId: string, boardType: string) {
  return db
    .select()
    .from(auroraCredentials)
    .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, boardType)));
}

function mappingRows(userId: string, boardType: string) {
  return db
    .select()
    .from(userBoardMappings)
    .where(and(eq(userBoardMappings.userId, userId), eq(userBoardMappings.boardType, boardType)));
}

describe('duplicate upstream account link guard', () => {
  beforeEach(async () => {
    signInMock.mockReset();
    signInMock.mockResolvedValue({ token: 'aurora-token', user_id: TENSION_UPSTREAM_ID });
    await clearFixtures();
    await insertUser(USER_A);
    await insertUser(USER_B);
  });

  describe('Aurora (saveAuroraCredential)', () => {
    it('rejects a second user linking the same upstream account and writes nothing', async () => {
      await saveAuroraCredential({ userId: USER_A, boardType: 'tension', username: 'climber-a', password: 'pw' });

      const error = await saveAuroraCredential({
        userId: USER_B,
        boardType: 'tension',
        username: 'climber-b',
        password: 'pw',
      }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(DuplicateBoardLinkError);
      expect((error as DuplicateBoardLinkError).code).toBe('account_already_linked');

      expect(await auroraRows(USER_B, 'tension')).toHaveLength(0);
      expect(await mappingRows(USER_B, 'tension')).toHaveLength(0);
      // User A's claim is untouched.
      expect(await auroraRows(USER_A, 'tension')).toHaveLength(1);
    });

    it('allows the same user to re-link their own account (update path)', async () => {
      await saveAuroraCredential({ userId: USER_A, boardType: 'tension', username: 'climber-a', password: 'pw1' });

      await expect(
        saveAuroraCredential({ userId: USER_A, boardType: 'tension', username: 'climber-a', password: 'pw2' }),
      ).resolves.toMatchObject({ boardType: 'tension', auroraUserId: TENSION_UPSTREAM_ID });

      expect(await auroraRows(USER_A, 'tension')).toHaveLength(1);
    });

    it('does not block a new owner when the prior claim is expired', async () => {
      await saveAuroraCredential({ userId: USER_A, boardType: 'tension', username: 'climber-a', password: 'pw' });
      await db
        .update(auroraCredentials)
        .set({ syncStatus: 'expired' })
        .where(and(eq(auroraCredentials.userId, USER_A), eq(auroraCredentials.boardType, 'tension')));

      await expect(
        saveAuroraCredential({ userId: USER_B, boardType: 'tension', username: 'climber-b', password: 'pw' }),
      ).resolves.toMatchObject({ auroraUserId: TENSION_UPSTREAM_ID });

      expect(await mappingRows(USER_B, 'tension')).toHaveLength(1);
    });

    it('resets the backoff scheduler fields when a previously-failing credential is re-linked', async () => {
      await saveAuroraCredential({ userId: USER_A, boardType: 'tension', username: 'climber-a', password: 'pw1' });
      // Model a run of failures that boxed the credential out of selection.
      await db
        .update(auroraCredentials)
        .set({ consecutiveFailures: 9, lastSyncError: 'boom', lastSyncAttemptAt: new Date(), syncStatus: 'error' })
        .where(and(eq(auroraCredentials.userId, USER_A), eq(auroraCredentials.boardType, 'tension')));

      await saveAuroraCredential({ userId: USER_A, boardType: 'tension', username: 'climber-a', password: 'pw2' });

      const [row] = await auroraRows(USER_A, 'tension');
      // Re-linking must clear the backoff clock so the reconnected account is
      // immediately selectable — not stuck inside a 6-hour window.
      expect(row.consecutiveFailures).toBe(0);
      expect(row.lastSyncError).toBeNull();
      expect(row.lastSyncAttemptAt).toBeNull();
      expect(row.syncStatus).toBe('pending');
    });
  });

  describe('Kilter (saveKilterCredential)', () => {
    it('rejects a second user linking the same Kilter sub and writes nothing', async () => {
      await saveKilterCredential({
        userId: USER_A,
        refreshToken: 'refresh-a',
        kilterUserId: KILTER_SUB,
        username: 'a',
      });

      const error = await saveKilterCredential({
        userId: USER_B,
        refreshToken: 'refresh-b',
        kilterUserId: KILTER_SUB,
        username: 'b',
      }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(DuplicateBoardLinkError);
      expect((error as DuplicateBoardLinkError).code).toBe('account_already_linked');

      expect(await mappingRows(USER_B, 'kilter')).toHaveLength(0);
      expect(await auroraRows(USER_B, 'kilter')).toHaveLength(0);
    });

    it('allows the same user to re-link their own Kilter account (update path)', async () => {
      await saveKilterCredential({ userId: USER_A, refreshToken: 'refresh-1', kilterUserId: KILTER_SUB });

      await expect(
        saveKilterCredential({ userId: USER_A, refreshToken: 'refresh-2', kilterUserId: KILTER_SUB }),
      ).resolves.toBeUndefined();

      expect(await mappingRows(USER_A, 'kilter')).toHaveLength(1);
    });

    it('does not block a new owner when the prior Kilter claim is expired', async () => {
      await saveKilterCredential({ userId: USER_A, refreshToken: 'refresh-1', kilterUserId: KILTER_SUB });
      await db
        .update(auroraCredentials)
        .set({ syncStatus: 'expired' })
        .where(and(eq(auroraCredentials.userId, USER_A), eq(auroraCredentials.boardType, 'kilter')));

      await expect(
        saveKilterCredential({ userId: USER_B, refreshToken: 'refresh-2', kilterUserId: KILTER_SUB }),
      ).resolves.toBeUndefined();

      expect(await mappingRows(USER_B, 'kilter')).toHaveLength(1);
    });

    it('does not block a new owner when the prior mapping is orphaned (no credentials row)', async () => {
      // A mapping row lingers for the sub but the credentials row was deleted
      // (manual cleanup, partial state). The left-join sync_status is NULL —
      // treated as NON-blocking so the account stays claimable.
      await db.insert(userBoardMappings).values({
        userId: USER_A,
        boardType: 'kilter',
        boardUserIdText: KILTER_SUB,
        boardUsername: 'orphan-a',
      });

      await expect(
        saveKilterCredential({ userId: USER_B, refreshToken: 'refresh-b', kilterUserId: KILTER_SUB, username: 'b' }),
      ).resolves.toBeUndefined();

      expect(await mappingRows(USER_B, 'kilter')).toHaveLength(1);
    });

    it('resets the backoff scheduler fields when a previously-failing Kilter credential is re-linked', async () => {
      await saveKilterCredential({ userId: USER_A, refreshToken: 'refresh-1', kilterUserId: KILTER_SUB });
      await db
        .update(auroraCredentials)
        .set({ consecutiveFailures: 5, lastSyncError: 'boom', lastSyncAttemptAt: new Date(), syncStatus: 'error' })
        .where(and(eq(auroraCredentials.userId, USER_A), eq(auroraCredentials.boardType, 'kilter')));

      await saveKilterCredential({ userId: USER_A, refreshToken: 'refresh-2', kilterUserId: KILTER_SUB });

      const [row] = await auroraRows(USER_A, 'kilter');
      expect(row.consecutiveFailures).toBe(0);
      expect(row.lastSyncError).toBeNull();
      expect(row.lastSyncAttemptAt).toBeNull();
      expect(row.syncStatus).toBe('pending');
    });
  });

  // The check-then-write guard is TOCTOU by nature: without serialization, two
  // transactions racing on the same upstream account can both read "no
  // conflicting owner" before either commits, and both links land. The
  // pg_advisory_xact_lock taken at the top of each guard (keyed on the
  // upstream identity) makes the sequence linear, so exactly one of two
  // PARALLEL linkers must win — the loser blocks on the lock, then sees the
  // winner's committed claim. These run both saves concurrently on separate
  // pool connections (backend pool max is 10) against the real DB.
  describe('concurrent linkers (TOCTOU serialization via advisory lock)', () => {
    it('exactly one of two parallel Aurora links for the same upstream account wins', async () => {
      const outcomes = await Promise.allSettled([
        saveAuroraCredential({ userId: USER_A, boardType: 'tension', username: 'climber-a', password: 'pw' }),
        saveAuroraCredential({ userId: USER_B, boardType: 'tension', username: 'climber-b', password: 'pw' }),
      ]);

      const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(DuplicateBoardLinkError);

      // Exactly one credential row claims the upstream account — never both.
      const claims = await db
        .select({ userId: auroraCredentials.userId })
        .from(auroraCredentials)
        .where(
          and(eq(auroraCredentials.boardType, 'tension'), eq(auroraCredentials.auroraUserId, TENSION_UPSTREAM_ID)),
        );
      expect(claims).toHaveLength(1);
    });

    it('exactly one of two parallel Kilter links for the same sub wins', async () => {
      const outcomes = await Promise.allSettled([
        saveKilterCredential({ userId: USER_A, refreshToken: 'refresh-a', kilterUserId: KILTER_SUB, username: 'a' }),
        saveKilterCredential({ userId: USER_B, refreshToken: 'refresh-b', kilterUserId: KILTER_SUB, username: 'b' }),
      ]);

      const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(DuplicateBoardLinkError);

      // Exactly one mapping row claims the Keycloak sub — never both.
      const claims = await db
        .select({ userId: userBoardMappings.userId })
        .from(userBoardMappings)
        .where(and(eq(userBoardMappings.boardType, 'kilter'), eq(userBoardMappings.boardUserIdText, KILTER_SUB)));
      expect(claims).toHaveLength(1);
    });
  });
});
