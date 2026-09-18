import { and, count, eq, isNull, ne, sql } from 'drizzle-orm';
import { AuroraClimbingClient, assertAuroraBoardName } from '@boardsesh/aurora-sync/api';
import { decrypt, encrypt } from '@boardsesh/crypto';
import { auroraCredentials, boardClimbs, boardseshTicks, userBoardMappings } from '@boardsesh/db/schema';
import { AURORA_BOARDS, type AuroraBoardName } from '@boardsesh/shared-schema';
import {
  KILTER_BOARD_TYPE,
  KilterApiError,
  passwordGrant,
  revokeRefreshToken,
  verifyKeycloakToken,
} from '@boardsesh/kilter-sync/api';
import { db } from '../db/client';
import { logger } from '../utils/logger';

const KILTER_OAUTH_CLIENT_ID = process.env.KILTER_OAUTH_CLIENT_ID;
const KILTER_OAUTH_CLIENT_SECRET = process.env.KILTER_OAUTH_CLIENT_SECRET;

export type AuroraCredentialStatus = {
  boardType: string;
  auroraUsername: string;
  auroraUserId: number | null;
  lastSyncAt: string | null;
  syncStatus: string;
  syncError: string | null;
  createdAt: string;
};

export type UnsyncedCounts = Record<
  string,
  {
    ascents: number;
    climbs: number;
  }
>;

export type DeleteAuroraCredentialResult =
  | { success: true }
  | { success: false; localCleared: true; reason: 'revocation_failed' };

export function isAuroraBoardType(value: string | null | undefined): value is AuroraBoardName {
  return !!value && (AURORA_BOARDS as readonly string[]).includes(value);
}

// Stable machine code carried by every duplicate-link surface (REST 409,
// GraphQL extension, mobile/web clients) so clients localise off the code
// rather than the plain-English message.
export const DUPLICATE_BOARD_LINK_CODE = 'account_already_linked';

/**
 * Thrown when the upstream board account being linked is already claimed by a
 * DIFFERENT Boardsesh user. The same upstream identity must map to at most one
 * ACTIVE Boardsesh owner: owner resolution downstream is LIMIT-1 / global, so a
 * second claimant's synced ticks would land on the first user. An expired /
 * abandoned prior claim does NOT block a genuine re-owner — only a live one.
 */
export class DuplicateBoardLinkError extends Error {
  readonly code = DUPLICATE_BOARD_LINK_CODE;

  constructor(message = 'This board account is already linked to another Boardsesh member.') {
    super(message);
    this.name = 'DuplicateBoardLinkError';
  }
}

// The transaction handle drizzle hands the `db.transaction` callback. Derived so
// the guard helpers can run on the same tx as the write (consistent read) without
// an `any`.
type CredentialTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Advisory-lock namespace for the duplicate board-account-link guards —
 * `0x4c494e4b` is ASCII "LINK". Two-int form per the repo convention
 * (`CLIMB_DUPLICATE_LOCK_NAMESPACE` in climb-similarity.ts,
 * `PUSH_TOKEN_LOCK_NAMESPACE` in push-tokens.ts) so this lock space can't
 * collide with other advisory-lock callers on the same cluster.
 *
 * Why a lock at all: the guards below are SELECT-then-write, which is TOCTOU —
 * two users linking the same upstream account concurrently can both read "no
 * conflicting owner" before either INSERT commits, and both links land. A
 * `SELECT ... FOR UPDATE` can't close that window because in the racing case
 * there is no row to lock yet. A transaction-scoped advisory lock keyed on the
 * upstream identity serializes both writers deterministically: the second
 * blocks until the first commits, then (READ COMMITTED) its conflict SELECT
 * sees the freshly committed claim and rejects. Auto-released at
 * COMMIT/ROLLBACK; server-wide, so it covers all backend instances on one DB.
 *
 * End-state: a DB-level UNIQUE on the upstream identity —
 * (board_type, aurora_user_id) on aurora_credentials and
 * (board_type, board_user_id_text) on user_board_mappings — replaces this lock
 * entirely. That constraint canNOT be added yet: prod carries one known
 * duplicate pair (issue #3541) that would fail the migration. Once #3541's
 * pair is manually resolved, add the partial unique indexes and delete this
 * lock.
 */
const BOARD_LINK_LOCK_NAMESPACE = 0x4c494e4b;

/** Serialize concurrent link attempts for one upstream account (see namespace doc). */
async function acquireBoardLinkLock(tx: CredentialTransaction, boardType: string, upstreamId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${BOARD_LINK_LOCK_NAMESPACE}, hashtext(${`${boardType}|${upstreamId}`}))`,
  );
}

/**
 * Reject an Aurora-family link when another Boardsesh user already holds this
 * upstream account (`board_type` + numeric `aurora_user_id`). An 'expired' claim
 * is skipped — the syncable set is positive (pending/active/error), matching the
 * sync runners' selection filter — so an abandoned link can't permanently block
 * the account's genuine owner.
 */
async function assertNoConflictingAuroraOwner(
  tx: CredentialTransaction,
  input: { userId: string; boardType: string; auroraUserId: number | null | undefined },
): Promise<void> {
  // No upstream id means no account identity to collide on — nothing to block.
  if (input.auroraUserId == null) return;
  // Take the per-upstream-account lock BEFORE the conflict read, so two
  // concurrent linkers of the same account run check-then-write serially.
  await acquireBoardLinkLock(tx, input.boardType, String(input.auroraUserId));
  const conflicting = await tx
    .select({ userId: auroraCredentials.userId })
    .from(auroraCredentials)
    .where(
      and(
        eq(auroraCredentials.boardType, input.boardType),
        eq(auroraCredentials.auroraUserId, input.auroraUserId),
        ne(auroraCredentials.userId, input.userId),
        ne(auroraCredentials.syncStatus, 'expired'),
      ),
    )
    .limit(1);

  if (conflicting.length > 0) {
    throw new DuplicateBoardLinkError();
  }
}

/**
 * Reject a Kilter link when another Boardsesh user already holds this Keycloak
 * `sub` (stored on `user_board_mappings.board_user_id_text`). The mapping match
 * is the core guard; the left-join to `aurora_credentials` mirrors the Aurora
 * rule so an 'expired' prior claim doesn't block a re-owner. A mapping row with
 * NO corresponding credentials row (left-join `sync_status` IS NULL) is an
 * ORPHAN — e.g. the credentials row was deleted manually but the mapping
 * lingered — and is treated as NON-blocking so the account stays claimable:
 * `sync_status <> 'expired'` is NULL for an orphan, which drops it from the
 * conflict set. Only a live claim (pending/active/error) actually blocks.
 */
async function assertNoConflictingKilterOwner(
  tx: CredentialTransaction,
  input: { userId: string; kilterUserId: string },
): Promise<void> {
  // Same TOCTOU serialization as the Aurora guard (see BOARD_LINK_LOCK_NAMESPACE).
  await acquireBoardLinkLock(tx, KILTER_BOARD_TYPE, input.kilterUserId);
  const conflicting = await tx
    .select({ userId: userBoardMappings.userId })
    .from(userBoardMappings)
    .leftJoin(
      auroraCredentials,
      and(
        eq(auroraCredentials.userId, userBoardMappings.userId),
        eq(auroraCredentials.boardType, userBoardMappings.boardType),
      ),
    )
    .where(
      and(
        eq(userBoardMappings.boardType, KILTER_BOARD_TYPE),
        eq(userBoardMappings.boardUserIdText, input.kilterUserId),
        ne(userBoardMappings.userId, input.userId),
        // NULL (orphan mapping, no credentials row) and 'expired' both drop out:
        // `<> 'expired'` is NULL for an orphan and FALSE for expired.
        ne(auroraCredentials.syncStatus, 'expired'),
      ),
    )
    .limit(1);

  if (conflicting.length > 0) {
    throw new DuplicateBoardLinkError();
  }
}

function decryptUsername(boardType: string, encryptedUsername: string | null, mappingUsername?: string | null): string {
  if (!encryptedUsername) return mappingUsername ?? '';

  try {
    return decrypt(encryptedUsername);
  } catch (error) {
    logger.warn(`[AuroraCredentials] Failed to decrypt username for ${boardType}:`, error);
    return mappingUsername ?? '';
  }
}

function auroraBoardSortIndex(boardType: string): number {
  const boardIndex = (AURORA_BOARDS as readonly string[]).indexOf(boardType);
  return boardIndex === -1 ? AURORA_BOARDS.length : boardIndex;
}

export async function getAuroraCredentialStatuses(userId: string): Promise<AuroraCredentialStatus[]> {
  const [credentials, mappings] = await Promise.all([
    db
      .select({
        boardType: auroraCredentials.boardType,
        encryptedUsername: auroraCredentials.encryptedUsername,
        auroraUserId: auroraCredentials.auroraUserId,
        lastSyncAt: auroraCredentials.lastSyncAt,
        syncStatus: auroraCredentials.syncStatus,
        syncError: auroraCredentials.syncError,
        createdAt: auroraCredentials.createdAt,
        boardUsername: userBoardMappings.boardUsername,
      })
      .from(auroraCredentials)
      .leftJoin(
        userBoardMappings,
        and(
          eq(userBoardMappings.userId, auroraCredentials.userId),
          eq(userBoardMappings.boardType, auroraCredentials.boardType),
        ),
      )
      .where(eq(auroraCredentials.userId, userId)),
    db
      .select({
        boardType: userBoardMappings.boardType,
        boardUserId: userBoardMappings.boardUserId,
        boardUsername: userBoardMappings.boardUsername,
        linkedAt: userBoardMappings.linkedAt,
      })
      .from(userBoardMappings)
      .where(eq(userBoardMappings.userId, userId)),
  ]);

  const statusesByBoard = new Map<string, AuroraCredentialStatus>();

  for (const credential of credentials) {
    statusesByBoard.set(credential.boardType, {
      boardType: credential.boardType,
      auroraUsername: decryptUsername(
        credential.boardType,
        credential.encryptedUsername,
        credential.boardUsername ?? undefined,
      ),
      auroraUserId: credential.auroraUserId,
      lastSyncAt: credential.lastSyncAt?.toISOString() ?? null,
      syncStatus: credential.syncStatus,
      syncError: credential.syncError,
      createdAt: credential.createdAt.toISOString(),
    });
  }

  for (const mapping of mappings) {
    if (statusesByBoard.has(mapping.boardType)) continue;

    statusesByBoard.set(mapping.boardType, {
      boardType: mapping.boardType,
      auroraUsername: mapping.boardUsername ?? '',
      auroraUserId: mapping.boardUserId,
      lastSyncAt: null,
      syncStatus: 'linked',
      syncError: null,
      createdAt: mapping.linkedAt.toISOString(),
    });
  }

  return [...statusesByBoard.values()].sort(
    (left, right) => auroraBoardSortIndex(left.boardType) - auroraBoardSortIndex(right.boardType),
  );
}

export async function getAuroraUnsyncedCounts(userId: string): Promise<UnsyncedCounts> {
  const credentials = await db
    .select({
      boardType: auroraCredentials.boardType,
      auroraUserId: auroraCredentials.auroraUserId,
    })
    .from(auroraCredentials)
    .where(eq(auroraCredentials.userId, userId));

  const unsyncedCounts: UnsyncedCounts = {};

  for (const credential of credentials) {
    if (!credential.auroraUserId) continue;

    const [ascentResult] = await db
      .select({ count: count() })
      .from(boardseshTicks)
      .where(
        and(
          eq(boardseshTicks.userId, userId),
          eq(boardseshTicks.boardType, credential.boardType),
          isNull(boardseshTicks.auroraId),
        ),
      );

    const [climbResult] = await db
      .select({ count: count() })
      .from(boardClimbs)
      .where(
        and(
          eq(boardClimbs.boardType, credential.boardType),
          eq(boardClimbs.setterId, credential.auroraUserId),
          eq(boardClimbs.synced, false),
        ),
      );

    unsyncedCounts[credential.boardType] = {
      ascents: ascentResult?.count ?? 0,
      climbs: climbResult?.count ?? 0,
    };
  }

  return unsyncedCounts;
}

export async function saveAuroraCredential(input: {
  userId: string;
  boardType: AuroraBoardName;
  username: string;
  password: string;
}): Promise<AuroraCredentialStatus> {
  // Before ANY network call. `assertAuroraBoardName` lives next to `HOST_BASES`
  // in @boardsesh/aurora-sync, so the GraphQL edge and the sync runner share one
  // definition. Belt to `AuroraBoardNameSchema`'s braces: the schema stops a bad
  // value at the edge, this stops one that reaches the service another way.
  assertAuroraBoardName(input.boardType);

  if (input.boardType === KILTER_BOARD_TYPE) {
    throw new Error('Kilter accounts use OAuth');
  }

  const auroraClient = new AuroraClimbingClient({ boardName: input.boardType });
  const loginResponse = await auroraClient.signIn(input.username, input.password);

  if (!loginResponse.token || !loginResponse.user_id) {
    throw new Error('Invalid login response from Aurora');
  }

  const now = new Date();
  const encryptedUsername = encrypt(input.username);
  const encryptedPassword = encrypt(input.password);
  const encryptedToken = encrypt(loginResponse.token);

  await db.transaction(async (tx) => {
    // Block the link if another Boardsesh user already actively owns this upstream
    // account. Runs before either the INSERT or UPDATE branch below.
    await assertNoConflictingAuroraOwner(tx, {
      userId: input.userId,
      boardType: input.boardType,
      auroraUserId: loginResponse.user_id,
    });

    const existingCredential = await tx
      .select({ id: auroraCredentials.id })
      .from(auroraCredentials)
      .where(and(eq(auroraCredentials.userId, input.userId), eq(auroraCredentials.boardType, input.boardType)))
      .limit(1);

    if (existingCredential.length > 0) {
      await tx
        .update(auroraCredentials)
        .set({
          encryptedUsername,
          encryptedPassword,
          encryptedRefreshToken: null,
          auroraUserId: loginResponse.user_id,
          auroraToken: encryptedToken,
          lastSyncAt: null,
          syncStatus: 'pending',
          syncError: null,
          credentialFailureCount: 0,
          lastCredentialFailureAt: null,
          // Re-linking is a fresh start: clear the backoff scheduler fields too,
          // otherwise a previously-failing credential stays boxed out of
          // selection (consecutive_failures + last_sync_attempt_at drive the
          // backoff window) for up to 6h after the user reconnects — i.e.
          // reconnecting wouldn't actually resume sync.
          consecutiveFailures: 0,
          lastSyncAttemptAt: null,
          lastSyncError: null,
          updatedAt: now,
        })
        .where(and(eq(auroraCredentials.userId, input.userId), eq(auroraCredentials.boardType, input.boardType)));
    } else {
      await tx.insert(auroraCredentials).values({
        userId: input.userId,
        boardType: input.boardType,
        encryptedUsername,
        encryptedPassword,
        auroraUserId: loginResponse.user_id,
        auroraToken: encryptedToken,
        lastSyncAt: null,
        syncStatus: 'pending',
        syncError: null,
        credentialFailureCount: 0,
        lastCredentialFailureAt: null,
      });
    }

    const existingMapping = await tx
      .select({ id: userBoardMappings.id })
      .from(userBoardMappings)
      .where(and(eq(userBoardMappings.userId, input.userId), eq(userBoardMappings.boardType, input.boardType)))
      .limit(1);

    if (existingMapping.length > 0) {
      await tx
        .update(userBoardMappings)
        .set({
          boardUserId: loginResponse.user_id,
          boardUserIdText: null,
          boardUsername: input.username,
          linkedAt: now,
        })
        .where(and(eq(userBoardMappings.userId, input.userId), eq(userBoardMappings.boardType, input.boardType)));
    } else {
      await tx.insert(userBoardMappings).values({
        userId: input.userId,
        boardType: input.boardType,
        boardUserId: loginResponse.user_id,
        boardUsername: input.username,
      });
    }
  });

  return {
    boardType: input.boardType,
    auroraUsername: input.username,
    auroraUserId: loginResponse.user_id,
    lastSyncAt: null,
    syncStatus: 'pending',
    syncError: null,
    createdAt: now.toISOString(),
  };
}

async function revokeKilterRefreshToken(userId: string, credentialDb: Pick<typeof db, 'select'>): Promise<boolean> {
  const [credential] = await credentialDb
    .select({ encryptedRefreshToken: auroraCredentials.encryptedRefreshToken })
    .from(auroraCredentials)
    .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, KILTER_BOARD_TYPE)))
    .for('update')
    .limit(1);

  if (!credential?.encryptedRefreshToken || !KILTER_OAUTH_CLIENT_ID) return true;

  let revocationFailed = false;
  try {
    const refreshToken = decrypt(credential.encryptedRefreshToken);
    await revokeRefreshToken(
      refreshToken,
      {
        clientId: KILTER_OAUTH_CLIENT_ID,
        clientSecret: KILTER_OAUTH_CLIENT_SECRET,
      },
      {
        onError: (error) => {
          revocationFailed = true;
          logger.warn('[AuroraCredentials] Kilter refresh token revocation failed:', error);
        },
      },
    );
  } catch (error) {
    revocationFailed = true;
    logger.warn('[AuroraCredentials] Failed to decrypt or revoke Kilter refresh token:', error);
  }

  return !revocationFailed;
}

export async function saveKilterCredential(input: {
  userId: string;
  refreshToken: string;
  kilterUserId: string;
  username?: string;
}): Promise<void> {
  const now = new Date();
  const encryptedRefreshToken = encrypt(input.refreshToken);

  await db.transaction(async (tx) => {
    // Block the link if another Boardsesh user already actively owns this Kilter
    // account. Runs before either the INSERT or UPDATE branch below.
    await assertNoConflictingKilterOwner(tx, { userId: input.userId, kilterUserId: input.kilterUserId });

    const existingCredential = await tx
      .select({ id: auroraCredentials.id })
      .from(auroraCredentials)
      .where(and(eq(auroraCredentials.userId, input.userId), eq(auroraCredentials.boardType, KILTER_BOARD_TYPE)))
      .limit(1);

    if (existingCredential.length > 0) {
      await tx
        .update(auroraCredentials)
        .set({
          encryptedUsername: null,
          encryptedPassword: null,
          encryptedRefreshToken,
          auroraUserId: null,
          auroraToken: null,
          syncStatus: 'pending',
          syncError: null,
          credentialFailureCount: 0,
          lastCredentialFailureAt: null,
          // Re-linking is a fresh start: clear the backoff scheduler fields too
          // (see saveAuroraCredential) so a previously-failing Kilter credential
          // is immediately selectable again instead of staying inside its
          // backoff window after the user reconnects.
          consecutiveFailures: 0,
          lastSyncAttemptAt: null,
          lastSyncError: null,
          updatedAt: now,
        })
        .where(and(eq(auroraCredentials.userId, input.userId), eq(auroraCredentials.boardType, KILTER_BOARD_TYPE)));
    } else {
      await tx.insert(auroraCredentials).values({
        userId: input.userId,
        boardType: KILTER_BOARD_TYPE,
        encryptedRefreshToken,
        syncStatus: 'pending',
        credentialFailureCount: 0,
        lastCredentialFailureAt: null,
      });
    }

    const existingMapping = await tx
      .select({ id: userBoardMappings.id })
      .from(userBoardMappings)
      .where(and(eq(userBoardMappings.userId, input.userId), eq(userBoardMappings.boardType, KILTER_BOARD_TYPE)))
      .limit(1);

    if (existingMapping.length > 0) {
      await tx
        .update(userBoardMappings)
        .set({
          boardUserId: null,
          boardUserIdText: input.kilterUserId,
          boardUsername: input.username ?? null,
          linkedAt: now,
        })
        .where(and(eq(userBoardMappings.userId, input.userId), eq(userBoardMappings.boardType, KILTER_BOARD_TYPE)));
    } else {
      await tx.insert(userBoardMappings).values({
        userId: input.userId,
        boardType: KILTER_BOARD_TYPE,
        boardUserIdText: input.kilterUserId,
        boardUsername: input.username ?? null,
      });
    }
  });
  await notifyKilterCredentialChange();
}

/**
 * Link a Kilter account from a username + password using Keycloak's
 * Resource-Owner-Password-Credentials grant. This is the path we use because
 * Kilter hasn't registered an OAuth client / redirect URI for us — ROPC rides
 * on the same public `kilter` client the catalog sync already uses, so it needs
 * no Kilter-side registration. We mint a refresh token and hand it to the same
 * `saveKilterCredential` the OAuth callback uses; the password itself is never
 * stored.
 */
export async function saveKilterCredentialViaPassword(input: {
  userId: string;
  username: string;
  password: string;
}): Promise<void> {
  if (!KILTER_OAUTH_CLIENT_ID) {
    throw new KilterApiError('invalid_client', 'Kilter OAuth client is not configured');
  }

  const client = {
    clientId: KILTER_OAUTH_CLIENT_ID,
    ...(KILTER_OAUTH_CLIENT_SECRET ? { clientSecret: KILTER_OAUTH_CLIENT_SECRET } : {}),
  };

  const tokens = await passwordGrant({ username: input.username, password: input.password, client });

  if (!tokens.refresh_token) {
    // `offline_access` is requested, so a missing refresh token means the realm
    // didn't grant one — treat it as a credential/realm failure, not a success.
    throw new KilterApiError('invalid_grant', 'Kilter did not return a refresh token');
  }

  // Resolve the Keycloak user UUID (`sub`). Unlike the browser flow there's no
  // nonce/redirect binding to lean on, and some realm configs emit an id_token
  // whose `aud` is an array or omits the client — so we verify signature + iss
  // (host-allowlisted) + exp only, without `expectedAudience`. The access token
  // is a signed JWT from the same realm and is the fallback if no id_token came
  // back.
  const tokenToVerify = tokens.id_token ?? tokens.access_token;
  const { sub, preferredUsername } = await verifyKeycloakToken(tokenToVerify);

  await saveKilterCredential({
    userId: input.userId,
    refreshToken: tokens.refresh_token,
    kilterUserId: sub,
    username: preferredUsername ?? input.username,
  });
}

export async function deleteAuroraCredential(
  userId: string,
  boardType: AuroraBoardName,
): Promise<DeleteAuroraCredentialResult> {
  const localRevocationSucceeded = await db.transaction(async (tx) => {
    const revoked = boardType === KILTER_BOARD_TYPE ? await revokeKilterRefreshToken(userId, tx) : true;
    await tx
      .delete(auroraCredentials)
      .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, boardType)));
    await tx
      .delete(userBoardMappings)
      .where(and(eq(userBoardMappings.userId, userId), eq(userBoardMappings.boardType, boardType)));
    return revoked;
  });
  if (boardType === KILTER_BOARD_TYPE) await notifyKilterCredentialChange();

  if (!localRevocationSucceeded) {
    return { success: false, localCleared: true, reason: 'revocation_failed' };
  }

  return { success: true };
}

async function notifyKilterCredentialChange(): Promise<void> {
  if (process.env.KILTER_LIVE_SYNC_ENABLED !== '1') return;
  try {
    const { kilterLiveSync } = await import('./kilter-live-sync');
    await kilterLiveSync.credentialsChanged();
  } catch {
    logger.warn('[KilterLive] Credential change notification failed');
  }
}
