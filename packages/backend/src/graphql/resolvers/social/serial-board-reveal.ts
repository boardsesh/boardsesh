import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { SerialBoardRequestCard } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';
import { claimSerialReveals } from '../../../utils/serial-reveal-budget';
import { homeWallCondition } from './home-wall';

/** The owner `getResourcePrivacy` reads as Public whatever the board's booleans say. */
const SYSTEM_OWNER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Request cards for private home boards a signed-in climber heard over
 * Bluetooth and cannot open (`observedBoardSerialMatches`). A card says whose
 * board it is so the climber can ask to climb on it (`requestResourceAccess`),
 * and nothing that finds the board again: never its location (whatever its
 * location audience), slug, stored serial, presence ids or counts, and never
 * the owner's id. The rules are in docs/product/privacy.md ("What a serial
 * tells a climber nearby").
 *
 * A board gets a card only when all of these hold:
 * - its effective audience is Followers or Invite-only. Only me stays a stub,
 *   and so does Unlisted: an Unlisted board's uuid is its link
 *   (`resourceAccess`), so a card would hand the board, and a Public location,
 *   to anyone in range;
 * - it is a live home wall: not deleted or merged away, not a spray wall, not
 *   at someone else's gym or a public listed gym (`homeWallCondition`, the same
 *   rule as Friends' boards);
 * - the viewer is not its owner and holds no revoked grant on it: someone the
 *   owner removed learns nothing new;
 * - the viewer's hourly budget of distinct boards named this way has room
 *   (`claimSerialReveals`). Over it, the board stays an anonymous stub, so the
 *   scan keeps working.
 *
 * `hiddenBoardUuids` are boards the caller already found the viewer cannot
 * read without a link. Returns a card per named board, keyed by uuid.
 */
export async function serialBoardRequestCards(
  viewerId: string,
  hiddenBoardUuids: readonly string[],
): Promise<Map<string, SerialBoardRequestCard>> {
  const cards = new Map<string, SerialBoardRequestCard>();
  if (hiddenBoardUuids.length === 0) return cards;
  const boards = dbSchema.userBoards;
  const effectiveAudience = sql<string>`COALESCE(${dbSchema.resourcePrivacy.audience},
    CASE WHEN ${boards.ownerId} = ${SYSTEM_OWNER_ID} THEN 'public'
      WHEN ${boards.isUnlisted} THEN 'unlisted' WHEN ${boards.isPublic} THEN 'public' ELSE 'only_me' END)`;
  const rows = await db
    .select({
      uuid: boards.uuid,
      name: boards.name,
      boardType: boards.boardType,
      layoutId: boards.layoutId,
      sizeId: boards.sizeId,
      setIds: boards.setIds,
      angle: boards.angle,
      ownerDisplayName: sql<string | null>`COALESCE(${dbSchema.userProfiles.displayName}, ${dbSchema.users.name})`,
      ownerAvatarUrl: sql<string | null>`COALESCE(${dbSchema.userProfiles.avatarUrl}, ${dbSchema.users.image})`,
      requested: sql<boolean>`EXISTS (SELECT 1 FROM resource_grants reveal_request
        WHERE reveal_request.kind = 'board' AND reveal_request.resource_id = ${boards.uuid}
          AND reveal_request.user_id = ${viewerId} AND reveal_request.status = 'pending')`,
    })
    .from(boards)
    .innerJoin(dbSchema.users, eq(dbSchema.users.id, boards.ownerId))
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, boards.ownerId))
    .leftJoin(
      dbSchema.resourcePrivacy,
      and(eq(dbSchema.resourcePrivacy.kind, 'board'), eq(dbSchema.resourcePrivacy.resourceId, boards.uuid)),
    )
    .where(
      and(
        inArray(boards.uuid, [...new Set(hiddenBoardUuids)]),
        isNull(boards.deletedAt),
        isNull(boards.mergedIntoBoardUuid),
        ne(boards.boardType, 'spray'),
        ne(boards.ownerId, viewerId),
        homeWallCondition(boards.gymId, boards.ownerId),
        sql`${effectiveAudience} IN ('followers', 'invite_only')`,
        sql`NOT EXISTS (SELECT 1 FROM resource_grants reveal_revoked
          WHERE reveal_revoked.kind = 'board' AND reveal_revoked.resource_id = ${boards.uuid}
            AND reveal_revoked.user_id = ${viewerId} AND reveal_revoked.status = 'revoked')`,
      ),
    )
    .orderBy(boards.id);
  if (rows.length === 0) return cards;

  const named = await claimSerialReveals(
    viewerId,
    rows.map((row) => row.uuid),
  );
  for (const row of rows) {
    if (!named.has(row.uuid)) continue;
    cards.set(row.uuid, {
      requested: row.requested,
      ownerDisplayName: row.ownerDisplayName,
      ownerAvatarUrl: row.ownerAvatarUrl,
      preview: {
        uuid: row.uuid,
        name: row.name,
        boardType: row.boardType,
        layoutId: Number(row.layoutId),
        sizeId: Number(row.sizeId),
        setIds: row.setIds,
        angle: Number(row.angle),
      },
    });
  }
  // For abuse review: who was named how many owners, never which serials or boards.
  logger.info('[serial-reveal] request cards', {
    userId: viewerId,
    revealed: cards.size,
    heldBack: rows.length - cards.size,
  });
  return cards;
}
