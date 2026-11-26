import { and, eq, exists, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { SerialBoardRequestCard } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';
import { claimSerialReveals } from '../../../utils/serial-reveal-budget';
import { friendsBoardListingConditions } from './friends-board-listing';

/** The owner `getResourcePrivacy` reads as Public whatever the board's booleans say. */
const SYSTEM_OWNER_ID = '00000000-0000-0000-0000-000000000000';

/** A new account is named no one's board: no throwaway accounts walking a street. */
const MIN_ACCOUNT_AGE_DAYS = 7;

/**
 * Request cards for private home boards a signed-in climber heard over
 * Bluetooth and cannot open (`observedBoardSerialMatches`). A card says whose
 * board it is so the climber can ask to climb on it (`requestResourceAccess`),
 * and nothing that finds the board again: never its free-text name (it can
 * name a place), location (whatever its location audience), slug, stored
 * serial, presence ids or counts, and never the owner's id. The rules are in
 * docs/product/privacy.md ("What a serial tells a climber nearby").
 *
 * A board gets a card only when all of these hold:
 * - the board is in the viewer's Friends' boards (`friendsBoardListingConditions`):
 *   above all, the owner and the viewer follow each other. A one-way follow,
 *   either way, unlocks no card, so a stranger in range learns nothing;
 * - it is Invite-only (and so opted in to Show to friends). A friend can always
 *   open a Followers board, and a board they can open never gets a card. Only
 *   me stays a stub, and so does Unlisted: an Unlisted board's uuid is its link
 *   (`resourceAccess`). With the privacy controls off nothing is listed
 *   unreadable, so there are no cards;
 * - the viewer's account is at least 7 days old and has a verified email;
 * - the viewer's caps of distinct boards named this way have room
 *   (`claimSerialReveals`: 10 an hour, 15 a UTC day, 40 in 30 days, none while
 *   Redis is unavailable).
 *
 * Anything else stays an anonymous stub, never an error, so the scan keeps
 * working. `hiddenBoardUuids` are boards the caller already found the viewer
 * cannot read without a link. Returns a card per named board, keyed by uuid.
 */
export async function serialBoardRequestCards(
  viewerId: string,
  hiddenBoardUuids: readonly string[],
): Promise<Map<string, SerialBoardRequestCard>> {
  const cards = new Map<string, SerialBoardRequestCard>();
  if (hiddenBoardUuids.length === 0) return cards;
  const boards = dbSchema.userBoards;
  const grants = dbSchema.resourceGrants;
  // The owner's row is already joined as `users`; the viewer needs its own alias.
  const viewer = alias(dbSchema.users, 'reveal_viewer');
  const pendingRequest = db
    .select({ one: sql`1` })
    .from(grants)
    .where(
      and(
        eq(grants.kind, 'board'),
        eq(grants.resourceId, boards.uuid),
        eq(grants.userId, viewerId),
        eq(grants.status, 'pending'),
      ),
    );
  const eligibleViewer = db
    .select({ one: sql`1` })
    .from(viewer)
    .where(
      and(
        eq(viewer.id, viewerId),
        isNotNull(viewer.emailVerified),
        // The interval arithmetic is the one piece the query builder can't express.
        lte(viewer.createdAt, sql`now() - ${`${MIN_ACCOUNT_AGE_DAYS} days`}::interval`),
      ),
    );
  const rows = await db
    .select({
      uuid: boards.uuid,
      boardType: boards.boardType,
      layoutId: boards.layoutId,
      sizeId: boards.sizeId,
      setIds: boards.setIds,
      angle: boards.angle,
      ownerDisplayName: sql<string | null>`COALESCE(${dbSchema.userProfiles.displayName}, ${dbSchema.users.name})`,
      ownerAvatarUrl: sql<string | null>`COALESCE(${dbSchema.userProfiles.avatarUrl}, ${dbSchema.users.image})`,
      requested: exists(pendingRequest).mapWith(Boolean),
    })
    .from(boards)
    .innerJoin(dbSchema.users, eq(dbSchema.users.id, boards.ownerId))
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, boards.ownerId))
    // Invite-only exists only as an override row, never as a legacy board flag.
    .innerJoin(
      dbSchema.resourcePrivacy,
      and(eq(dbSchema.resourcePrivacy.kind, 'board'), eq(dbSchema.resourcePrivacy.resourceId, boards.uuid)),
    )
    .where(
      and(
        inArray(boards.uuid, [...new Set(hiddenBoardUuids)]),
        ...friendsBoardListingConditions(viewerId),
        eq(dbSchema.resourcePrivacy.audience, 'invite_only'),
        ne(boards.ownerId, SYSTEM_OWNER_ID),
        exists(eligibleViewer),
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
        // The board type, as on the stub: a board's own name can name a place.
        name: row.boardType,
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
