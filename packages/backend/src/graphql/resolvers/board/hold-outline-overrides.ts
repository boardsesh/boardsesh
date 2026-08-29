import { and, eq } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type {
  BoardHoldOutlines,
  BoardName,
  ConnectionContext,
  HoldOutlineOverride,
  PlacementOutline,
} from '@boardsesh/shared-schema';
import { loadBoardArtGeometry } from '@boardsesh/board-art-geometry';
import { pointInRing, roundRing } from '@boardsesh/board-art-geometry/ring';
import { getSetsForLayoutAndSize } from '@boardsesh/board-constants/product-sizes';
import { getBoardDetailsForBoard } from '@boardsesh/board-render';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { requireAdmin } from '../social/roles';
import {
  DeleteHoldOutlineOverrideInputSchema,
  HoldOutlineConfigInputSchema,
  UpsertHoldOutlineOverrideInputSchema,
} from '../../../validation/schemas';

/**
 * Admin editing of traced hold silhouettes.
 *
 * `@boardsesh/board-art-geometry` traces every hold from the board art and ships
 * the result as a frozen shard. The tracer gets most holds right; the ones it
 * doesn't are fixed here, as rows, rather than by regenerating and redeploying
 * the whole shard set. The query returns both sides so the editor can show the
 * traced shape next to the correction and offer a revert.
 *
 * Every operation — the read included — is admin-only and scoped to the board.
 * A board-scoped community admin can correct their own board's art and nobody
 * else's; a global admin can correct any. The read is gated too because there is
 * no product surface for it outside the editor, and an ungated one is a free
 * enumeration of the deployed shard set.
 */

/** Coordinate decimals stored, matching the shard's own `outlines` contract. */
const OUTLINE_DECIMALS = 4;

const HOLD_OUTLINES_QUERY_LIMIT = 60;
const HOLD_OUTLINE_MUTATION_LIMIT = 30;

/**
 * `extensions.code` values a rejection carries, so the editor can branch on the
 * outcome instead of scraping a message. Follows the convention #4515 set.
 */
export const HOLD_OUTLINE_CODES = {
  unknownPlacement: 'HOLD_OUTLINE_UNKNOWN_PLACEMENT',
  centreOutside: 'HOLD_OUTLINE_CENTRE_OUTSIDE',
} as const;

type HoldOutlineConfig = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
};

/**
 * Every placement id the board config carries.
 *
 * Set ids are deliberately not part of an override's key, so the membership test
 * runs against EVERY set of the layout and size — the same composite the shard
 * was traced on. An Aurora board assembles its `holdsData` from the set list it
 * is handed, so passing an empty one there would reject every placement; the
 * other two carry their own geometry and ignore the argument (MoonBoard's
 * `holdsData` is its full synthetic grid whatever is bolted on, and Woods keys
 * off size alone), which is why they also have no set lookup here.
 */
function placementIdsFor({ boardName, layoutId, sizeId }: HoldOutlineConfig): Set<number> {
  const setIds = getSetsForLayoutAndSize(boardName, layoutId, sizeId).map((set) => set.id);
  const details = getBoardDetailsForBoard({
    board_name: boardName,
    layout_id: layoutId,
    size_id: sizeId,
    set_ids: setIds,
  });
  return new Set((details.holdsData ?? []).map((hold) => hold.id));
}

/** The DB row shape the two write paths and the read path all return to GraphQL. */
type OverrideRow = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  placementId: number;
  outline: number[];
  note: string | null;
  authorId: string | null;
  updatedAt: Date;
};

function toGraphQLOverride(row: OverrideRow, authorDisplayName: string | null): HoldOutlineOverride {
  return {
    boardName: row.boardName,
    layoutId: row.layoutId,
    sizeId: row.sizeId,
    placementId: row.placementId,
    outline: row.outline,
    note: row.note,
    authorId: row.authorId,
    authorDisplayName,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Display label for the account behind an override: profile display name, then
 * account name. Null once the account is gone — `author_id` is `ON DELETE SET
 * NULL`, so a deleted editor leaves the correction standing and unattributed.
 */
async function loadAuthorDisplayName(authorId: string | null): Promise<string | null> {
  if (!authorId) return null;
  const [row] = await db
    .select({ name: dbSchema.users.name, displayName: dbSchema.userProfiles.displayName })
    .from(dbSchema.users)
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.users.id))
    .where(eq(dbSchema.users.id, authorId))
    .limit(1);
  return row ? (row.displayName ?? row.name ?? null) : null;
}

export const holdOutlineQueries = {
  holdOutlines: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<BoardHoldOutlines> => {
    const config = validateInput(HoldOutlineConfigInputSchema, input, 'input');
    await requireAdmin(ctx, config.boardName);
    await applyRateLimit(ctx, HOLD_OUTLINES_QUERY_LIMIT, 'holdOutlines');

    // Null is the normal answer for a config the tracer never covered (Woods
    // ships no shard at all): the editor draws against the ring fallback the
    // renderer would use, so an empty list is a starting point, not an error.
    const geometry = loadBoardArtGeometry({
      boardName: config.boardName,
      layoutId: config.layoutId,
      sizeId: config.sizeId,
    });
    const shardOutlines: PlacementOutline[] = Object.entries(geometry?.outlines ?? {})
      .map(([placementId, outline]) => ({ placementId: Number(placementId), outline }))
      .sort((left, right) => left.placementId - right.placementId);

    const rows = await db
      .select({
        boardName: dbSchema.holdOutlineOverrides.boardName,
        layoutId: dbSchema.holdOutlineOverrides.layoutId,
        sizeId: dbSchema.holdOutlineOverrides.sizeId,
        placementId: dbSchema.holdOutlineOverrides.placementId,
        outline: dbSchema.holdOutlineOverrides.outline,
        note: dbSchema.holdOutlineOverrides.note,
        authorId: dbSchema.holdOutlineOverrides.authorId,
        updatedAt: dbSchema.holdOutlineOverrides.updatedAt,
        authorName: dbSchema.users.name,
        authorDisplayName: dbSchema.userProfiles.displayName,
      })
      .from(dbSchema.holdOutlineOverrides)
      .leftJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.holdOutlineOverrides.authorId))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.userProfiles.userId, dbSchema.holdOutlineOverrides.authorId))
      .where(
        and(
          eq(dbSchema.holdOutlineOverrides.boardName, config.boardName),
          eq(dbSchema.holdOutlineOverrides.layoutId, config.layoutId),
          eq(dbSchema.holdOutlineOverrides.sizeId, config.sizeId),
        ),
      )
      .orderBy(dbSchema.holdOutlineOverrides.placementId);

    return {
      boardName: config.boardName,
      layoutId: config.layoutId,
      sizeId: config.sizeId,
      shardOutlines,
      overrides: rows.map((row) => toGraphQLOverride(row, row.authorDisplayName ?? row.authorName ?? null)),
    };
  },
};

export const holdOutlineMutations = {
  upsertHoldOutlineOverride: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<HoldOutlineOverride> => {
    const validated = validateInput(UpsertHoldOutlineOverrideInputSchema, input, 'input');
    await requireAdmin(ctx, validated.boardName);
    await applyRateLimit(ctx, HOLD_OUTLINE_MUTATION_LIMIT, 'upsertHoldOutlineOverride');
    const authorId = ctx.userId;
    if (!authorId) {
      throw new Error('Authentication required to perform this operation');
    }

    if (!placementIdsFor(validated).has(validated.placementId)) {
      throw new GraphQLError(`Placement ${validated.placementId} is not on this board config.`, {
        extensions: { code: HOLD_OUTLINE_CODES.unknownPlacement },
      });
    }

    // A silhouette contains the bolt it is drawn around. Rejecting a ring that
    // doesn't is the cheapest way to catch one drawn against the neighbouring
    // hold, which is exactly the tracer failure this editor exists to fix — and
    // the failure most likely to be repeated by hand. Marginally stricter than
    // the tracer itself, whose output misses its own centre on 5 of 15,501
    // shipped outlines (all hooks and slopers with a deeply concave underside);
    // a correction for one of those has to be drawn to include the bolt.
    const outline = roundRing(validated.outline, OUTLINE_DECIMALS);
    if (!pointInRing(outline, 0, 0)) {
      throw new GraphQLError('An outline has to enclose the hold it belongs to.', {
        extensions: { code: HOLD_OUTLINE_CODES.centreOutside },
      });
    }

    const [row] = await db
      .insert(dbSchema.holdOutlineOverrides)
      .values({
        boardName: validated.boardName,
        layoutId: validated.layoutId,
        sizeId: validated.sizeId,
        placementId: validated.placementId,
        outline,
        note: validated.note ?? null,
        authorId,
      })
      .onConflictDoUpdate({
        target: [
          dbSchema.holdOutlineOverrides.boardName,
          dbSchema.holdOutlineOverrides.layoutId,
          dbSchema.holdOutlineOverrides.sizeId,
          dbSchema.holdOutlineOverrides.placementId,
        ],
        set: {
          outline,
          note: validated.note ?? null,
          authorId,
          updatedAt: new Date(),
        },
      })
      .returning({
        boardName: dbSchema.holdOutlineOverrides.boardName,
        layoutId: dbSchema.holdOutlineOverrides.layoutId,
        sizeId: dbSchema.holdOutlineOverrides.sizeId,
        placementId: dbSchema.holdOutlineOverrides.placementId,
        outline: dbSchema.holdOutlineOverrides.outline,
        note: dbSchema.holdOutlineOverrides.note,
        authorId: dbSchema.holdOutlineOverrides.authorId,
        updatedAt: dbSchema.holdOutlineOverrides.updatedAt,
      });

    return toGraphQLOverride(row, await loadAuthorDisplayName(row.authorId));
  },

  deleteHoldOutlineOverride: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    const validated = validateInput(DeleteHoldOutlineOverrideInputSchema, input, 'input');
    await requireAdmin(ctx, validated.boardName);
    await applyRateLimit(ctx, HOLD_OUTLINE_MUTATION_LIMIT, 'deleteHoldOutlineOverride');

    const removed = await db
      .delete(dbSchema.holdOutlineOverrides)
      .where(
        and(
          eq(dbSchema.holdOutlineOverrides.boardName, validated.boardName),
          eq(dbSchema.holdOutlineOverrides.layoutId, validated.layoutId),
          eq(dbSchema.holdOutlineOverrides.sizeId, validated.sizeId),
          eq(dbSchema.holdOutlineOverrides.placementId, validated.placementId),
        ),
      )
      .returning({ id: dbSchema.holdOutlineOverrides.id });

    return removed.length > 0;
  },
};
