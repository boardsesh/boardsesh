import { and, eq } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type {
  BoardHoldOutlines,
  BoardName,
  ConnectionContext,
  HoldOutlineKind,
  HoldOutlineOverride,
  PlacementOutline,
} from '@boardsesh/shared-schema';
import { loadBoardArtGeometry } from '@boardsesh/board-art-geometry';
import {
  CENTRE_TOLERANCE_RADII,
  MIN_RING_NUMBERS,
  closeRing,
  distanceToRing,
  pointInRing,
  roundRing,
} from '@boardsesh/board-art-geometry/ring';
import { getSetsForLayoutAndSize } from '@boardsesh/board-constants/product-sizes';
import { getBoardDetailsForBoard } from '@boardsesh/board-render';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';
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
  unknownConfig: 'HOLD_OUTLINE_UNKNOWN_CONFIG',
  unknownPlacement: 'HOLD_OUTLINE_UNKNOWN_PLACEMENT',
  centreOutside: 'HOLD_OUTLINE_CENTRE_OUTSIDE',
  degenerateRing: 'HOLD_OUTLINE_DEGENERATE_RING',
} as const;

/**
 * Stored `kind` values as GraphQL sends and receives them. The column is
 * snake_case (`hold_outline_kind`), the wire is SCREAMING_CASE.
 */
const WIRE_NAME_BY_HOLD_OUTLINE_KIND = {
  silhouette: 'SILHOUETTE',
  led_inner: 'LED_INNER',
} as const satisfies Record<StoredHoldOutlineKind, HoldOutlineKind>;

/** The `kind` values the column accepts, mirroring `holdOutlineKindEnum`. */
type StoredHoldOutlineKind = (typeof dbSchema.holdOutlineKindEnum.enumValues)[number];

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
  try {
    const setIds = getSetsForLayoutAndSize(boardName, layoutId, sizeId).map((set) => set.id);
    const details = getBoardDetailsForBoard({
      board_name: boardName,
      layout_id: layoutId,
      size_id: sizeId,
      set_ids: setIds,
    });
    return new Set((details.holdsData ?? []).map((hold) => hold.id));
  } catch {
    // `getBoardDetails` throws for a layout/size the catalogue does not have, and
    // its message enumerates every available size. Left raw that is a 500 on a
    // typo, and an information leak the matching QUERY does not have — that one
    // just returns an empty shard list. Same class of answer, same shape of
    // error.
    throw new GraphQLError(`No board config ${boardName} layout ${layoutId} size ${sizeId}.`, {
      extensions: { code: HOLD_OUTLINE_CODES.unknownConfig },
    });
  }
}

/**
 * The board name as the caller sent it, unvalidated, for the authorization
 * check that has to run BEFORE validation.
 *
 * `requireAdmin` is board-scoped, so it needs a board name — but running the
 * Zod schema first to get one means an unauthenticated caller learns which board
 * names exist from the enum error. Reading the raw field is safe: it only ever
 * reaches `hasAdmin`, where it is compared against the caller's own role rows.
 * An unknown string matches no board-scoped row, so it cannot grant anything;
 * a global admin (`board_type IS NULL`) passes either way and is then held to
 * the schema like everyone else.
 */
function rawBoardName(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const { boardName } = input as { boardName?: unknown };
  return typeof boardName === 'string' ? boardName : undefined;
}

/**
 * Is a stored ring structurally sound enough to hand to a client?
 *
 * Writes already enforce the full contract, so this only fires on a row that
 * reached the column another way — a hand-run UPDATE, a restore from an older
 * shape, a bad migration. jsonb will hold any of those happily, and a renderer
 * fed an odd-length or NaN-bearing ring draws garbage rather than failing, so
 * the read path drops the row instead of passing it on.
 *
 * Deliberately looser than the write gate: structure only, no coordinate bound
 * and no length ceiling. Those are policy and can be retuned; a row stored under
 * an older policy is stale, not corrupt, and should still render.
 */
function isRenderableStoredRing(outline: unknown): outline is number[] {
  return (
    Array.isArray(outline) &&
    outline.length >= MIN_RING_NUMBERS &&
    outline.length % 2 === 0 &&
    outline.every((value) => typeof value === 'number' && Number.isFinite(value))
  );
}

/** The DB row shape the two write paths and the read path all return to GraphQL. */
type OverrideRow = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  placementId: number;
  kind: StoredHoldOutlineKind;
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
    kind: WIRE_NAME_BY_HOLD_OUTLINE_KIND[row.kind],
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
    // Authorization first, validation second: an unauthenticated caller must not
    // be able to read the board-name enum out of a validation error.
    await requireAdmin(ctx, rawBoardName(input));
    await applyRateLimit(ctx, HOLD_OUTLINES_QUERY_LIMIT, 'holdOutlines');
    const config = validateInput(HoldOutlineConfigInputSchema, input, 'input');

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
        kind: dbSchema.holdOutlineOverrides.kind,
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
      .orderBy(dbSchema.holdOutlineOverrides.placementId, dbSchema.holdOutlineOverrides.kind);

    // A row that is not structurally a ring is dropped rather than handed on:
    // the editor would draw garbage from it and could not tell that it had. Not
    // reachable through this API — writes enforce the full contract — so a hit
    // means the column was written some other way, which is worth a log line.
    const renderable = rows.filter((row) => {
      if (isRenderableStoredRing(row.outline)) return true;
      logger.warn('[holdOutlines] dropping a stored override whose outline is not a ring', {
        boardName: row.boardName,
        layoutId: row.layoutId,
        sizeId: row.sizeId,
        placementId: row.placementId,
        kind: row.kind,
      });
      return false;
    });

    return {
      boardName: config.boardName,
      layoutId: config.layoutId,
      sizeId: config.sizeId,
      shardOutlines,
      overrides: renderable.map((row) => toGraphQLOverride(row, row.authorDisplayName ?? row.authorName ?? null)),
    };
  },
};

export const holdOutlineMutations = {
  upsertHoldOutlineOverride: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<HoldOutlineOverride> => {
    // Authorization first, validation second — see the query above.
    await requireAdmin(ctx, rawBoardName(input));
    await applyRateLimit(ctx, HOLD_OUTLINE_MUTATION_LIMIT, 'upsertHoldOutlineOverride');
    const validated = validateInput(UpsertHoldOutlineOverrideInputSchema, input, 'input');
    // `requireAdmin` runs `requireAuthenticated` first, so reaching here means
    // `ctx.userId` is set; the non-null assertion is the guarantee, not a guess.
    const authorId = ctx.userId!;

    if (!placementIdsFor(validated).has(validated.placementId)) {
      throw new GraphQLError(`Placement ${validated.placementId} is not on this board config.`, {
        extensions: { code: HOLD_OUTLINE_CODES.unknownPlacement },
      });
    }

    // Round first, close second. Rounding can newly equate the last point with
    // the first, so closing before it would leave the duplicate behind — and a
    // stored ring is implicitly closed, so a repeated final point is a
    // zero-length edge every consumer then has to skip.
    const outline = closeRing(roundRing(validated.outline, OUTLINE_DECIMALS));
    if (outline.length < MIN_RING_NUMBERS) {
      throw new GraphQLError(`An outline needs at least ${MIN_RING_NUMBERS / 2} distinct points.`, {
        extensions: { code: HOLD_OUTLINE_CODES.degenerateRing },
      });
    }

    // A ring drawn for a hold covers that hold's bolt. Checking it is the
    // cheapest way to catch one drawn around the NEIGHBOURING hold, which is
    // both the tracer failure this editor exists to fix and the one most likely
    // to be repeated by hand.
    //
    // "Covers" rather than "contains", because a strict containment test would
    // make exactly the holds most in need of correction un-correctable: a
    // handful of shipped outlines on kilter/1-28 — hooks and slopers whose bolt
    // sits under a deeply concave underside — do not contain their own centre,
    // all by a small fraction of a radius. A wrong-hold ring sits ~2 radii away,
    // so the tolerance admits the first and still rejects the second by a wide
    // margin. Both kinds are held to it: a LED_INNER ring is the plate boundary
    // around the same bolt.
    if (!pointInRing(outline, 0, 0) && distanceToRing(outline, 0, 0) > CENTRE_TOLERANCE_RADII) {
      throw new GraphQLError('An outline has to cover the hold it belongs to.', {
        extensions: { code: HOLD_OUTLINE_CODES.centreOutside },
      });
    }

    // An editor that clears the field sends '', which is not a reason — store the
    // absence rather than an empty string nothing can render. The schema has
    // already trimmed it, so `||` is doing the whole job here.
    const note = validated.note || null;

    const [row] = await db
      .insert(dbSchema.holdOutlineOverrides)
      .values({
        boardName: validated.boardName,
        layoutId: validated.layoutId,
        sizeId: validated.sizeId,
        placementId: validated.placementId,
        kind: validated.kind,
        outline,
        note,
        authorId,
      })
      .onConflictDoUpdate({
        target: [
          dbSchema.holdOutlineOverrides.boardName,
          dbSchema.holdOutlineOverrides.layoutId,
          dbSchema.holdOutlineOverrides.sizeId,
          dbSchema.holdOutlineOverrides.placementId,
          dbSchema.holdOutlineOverrides.kind,
        ],
        set: {
          outline,
          note,
          authorId,
          updatedAt: new Date(),
        },
      })
      .returning({
        boardName: dbSchema.holdOutlineOverrides.boardName,
        layoutId: dbSchema.holdOutlineOverrides.layoutId,
        sizeId: dbSchema.holdOutlineOverrides.sizeId,
        placementId: dbSchema.holdOutlineOverrides.placementId,
        kind: dbSchema.holdOutlineOverrides.kind,
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
    // Authorization first, validation second — see the query above.
    await requireAdmin(ctx, rawBoardName(input));
    await applyRateLimit(ctx, HOLD_OUTLINE_MUTATION_LIMIT, 'deleteHoldOutlineOverride');
    const validated = validateInput(DeleteHoldOutlineOverrideInputSchema, input, 'input');

    const removed = await db
      .delete(dbSchema.holdOutlineOverrides)
      .where(
        and(
          eq(dbSchema.holdOutlineOverrides.boardName, validated.boardName),
          eq(dbSchema.holdOutlineOverrides.layoutId, validated.layoutId),
          eq(dbSchema.holdOutlineOverrides.sizeId, validated.sizeId),
          eq(dbSchema.holdOutlineOverrides.placementId, validated.placementId),
          // Kind-scoped: dropping a hold's LED-plate annotation must not take
          // its corrected silhouette with it.
          eq(dbSchema.holdOutlineOverrides.kind, validated.kind),
        ),
      )
      .returning({ id: dbSchema.holdOutlineOverrides.id });

    return removed.length > 0;
  },
};
