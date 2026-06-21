import { and, count, eq, isNull } from 'drizzle-orm';
import { AuroraClimbingClient } from '@boardsesh/aurora-sync/api';
import { decrypt, encrypt } from '@boardsesh/crypto';
import { auroraCredentials, boardClimbs, boardseshTicks, userBoardMappings } from '@boardsesh/db/schema';
import { AURORA_BOARDS, type AuroraBoardName } from '@boardsesh/shared-schema';
import { KILTER_BOARD_TYPE, revokeRefreshToken } from '@boardsesh/kilter-sync/api';
import { db } from '../db/client';
import { logger } from '../utils/logger';

const KILTER_SYNC_ALLOWED_USER_IDS = process.env.KILTER_SYNC_ALLOWED_USER_IDS;
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

export function isKilterSyncAllowed(userId: string): boolean {
  if (!KILTER_SYNC_ALLOWED_USER_IDS) return false;

  return KILTER_SYNC_ALLOWED_USER_IDS.split(',')
    .map((allowedUserId) => allowedUserId.trim())
    .filter(Boolean)
    .includes(userId);
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

async function revokeKilterRefreshToken(userId: string): Promise<boolean> {
  const [credential] = await db
    .select({ encryptedRefreshToken: auroraCredentials.encryptedRefreshToken })
    .from(auroraCredentials)
    .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, KILTER_BOARD_TYPE)))
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
}

export async function deleteAuroraCredential(
  userId: string,
  boardType: AuroraBoardName,
): Promise<DeleteAuroraCredentialResult> {
  const localRevocationSucceeded = boardType === KILTER_BOARD_TYPE ? await revokeKilterRefreshToken(userId) : true;

  await db.transaction(async (tx) => {
    await tx
      .delete(auroraCredentials)
      .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, boardType)));
    await tx
      .delete(userBoardMappings)
      .where(and(eq(userBoardMappings.userId, userId), eq(userBoardMappings.boardType, boardType)));
  });

  if (!localRevocationSucceeded) {
    return { success: false, localCleared: true, reason: 'revocation_failed' };
  }

  return { success: true };
}
