import { v4 as uuidv4 } from 'uuid';
import { eq, and, or, isNull, asc, like, count, inArray } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { MAX_KIOSKS_PER_GYM, emptyKioskLayout, parseKioskLayoutLenient, type KioskLayout } from '@boardsesh/kiosk';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import {
  CreateGymKioskInputSchema,
  UpdateGymKioskInputSchema,
  KioskHeartbeatInputSchema,
  UUIDSchema,
} from '../../../validation/schemas';
import { isUniqueViolation } from '../../../utils/postgres-errors';
import {
  recordKioskHeartbeat,
  readKioskLastSeen,
  isKioskExistenceCached,
  cacheKioskExistence,
} from '../../../services/kiosk-heartbeat';
import { enrichGym, requireGymEditAccess, userCanEditGym, resolveCanonicalGymBySlug } from './gyms';
import { enrichBoards } from './boards';

type GymRow = typeof dbSchema.gyms.$inferSelect;
type KioskRow = typeof dbSchema.gymKiosks.$inferSelect;

// Rate limits (requests/minute). Reads are generous because a kiosk TV polls its
// config and the public read is shared with embeds; writes sit behind gym-edit
// access and the 10-kiosks-per-gym cap, so a higher-than-createGym ceiling is
// safe and lets the manage UI save a layout repeatedly while configuring.
const RATE_LIMIT_GYM_KIOSK = 120;
const RATE_LIMIT_GYM_KIOSKS = 60;
const RATE_LIMIT_CREATE_GYM_KIOSK = 60;
const RATE_LIMIT_UPDATE_GYM_KIOSK = 60;
const RATE_LIMIT_DELETE_GYM_KIOSK = 60;
// Heartbeats are unauthenticated (TVs aren't logged in), so this bucket is
// keyed per client IP since issue #2863 (in-memory; see applyRateLimit) —
// every screen behind one gym's NAT now shares it. A live TV checks in once
// per config-poll cycle (~5 min), so 60/min still leaves generous headroom for
// a whole gym's worth of screens. This is a best-effort throttle: it reins in a
// well-behaved client, not a determined one — a caller reaching the origin
// directly can still forge its IP headers. Since the write only stamps an
// ephemeral, non-sensitive timestamp, a loose ceiling here is acceptable.
const RATE_LIMIT_KIOSK_HEARTBEAT = 60;

// Same slug shape gymBySlug accepts — a public URL segment.
const GYM_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// Kiosk slug lookup guard (mirrors KioskSlugSchema, kept lenient on read so an
// odd stored/legacy slug still matches rather than 500s).
const KIOSK_SLUG_LOOKUP_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Derive a slug base from a kiosk name: lowercase, non-alphanumeric runs → single
 * hyphens, trimmed, capped short enough to leave room for a uniqueness suffix.
 * Falls back to `kiosk` when the name has too few usable characters (the write
 * schema floors slugs at 3 chars).
 */
function deriveKioskSlugBase(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    // The slice can cut right after a hyphen (e.g. a 49-char word + space +
    // more), leaving a trailing hyphen that KioskSlugSchema and the lookup
    // pattern reject — the kiosk would be unfetchable by slug. Re-trim.
    .replace(/^-+|-+$/g, '');
  return base.length >= 3 ? base : 'kiosk';
}

/**
 * Derive a slug that's unique among the gym's live kiosks. Mirrors
 * generateUniqueGymSlug: one query for the base + numeric-suffix variants, then
 * pick the first free suffix in memory (no sequential DB probing). The partial
 * unique index is still the source of truth — an explicit-slug create races
 * through the resolver's unique-violation catch instead.
 */
async function deriveUniqueKioskSlug(gymId: number, name: string): Promise<string> {
  const base = deriveKioskSlugBase(name);
  const existing = await db
    .select({ slug: dbSchema.gymKiosks.slug })
    .from(dbSchema.gymKiosks)
    .where(
      and(
        eq(dbSchema.gymKiosks.gymId, gymId),
        isNull(dbSchema.gymKiosks.deletedAt),
        or(eq(dbSchema.gymKiosks.slug, base), like(dbSchema.gymKiosks.slug, `${base}-%`)),
      ),
    );
  const taken = new Set(existing.map((row) => row.slug));

  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix <= 100; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${uuidv4().slice(0, 8)}`;
}

type ResolvedKioskBoard = {
  boardId: number;
  boardUuid: string;
  slug: string;
  name: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

type EnrichedGym = Awaited<ReturnType<typeof enrichGym>>;

/**
 * Build the public GymKiosk payload: the leniently-parsed layout, the resolved
 * slot boards (in slot order, dead/hidden slots dropped), and the branding-
 * carrying gym (`enrichedGym` — enriched ONCE by the caller, since the manage
 * list shares one gym across all its kiosks).
 *
 * Board visibility follows the viewer's GYM-level access, matching the SDL
 * docstring ("for a viewer without gym-edit access non-public boards are
 * filtered out"):
 *  - `viewerCanEditGym` (owner, gym admin/editor, or covering community
 *    admin/leader — the same set that passes the kiosk write gate): every
 *    alive, gym-linked slot board is included, private ones too, so the manage
 *    UI never shows a placeholder for a board the editor just placed. Their
 *    `boardId` is exposed directly — gym edit access is at least as strong a
 *    trust signal as the per-board gate.
 *  - everyone else: a slot board is included only when its presence-channel id
 *    is exposable via the shared `UserBoard.boardId` gate in enrichBoards
 *    (public, or the viewer can edit that board). GymKioskBoard's boardId is
 *    non-null, so a filtered board is omitted rather than shown with a null id
 *    (the private board stays in `layout`, off `boards`, and the kiosk client
 *    degrades the preset).
 */
async function resolveKioskView(
  kiosk: KioskRow,
  enrichedGym: EnrichedGym,
  viewerId: string | undefined,
  viewerCanEditGym: boolean,
) {
  const parsed = parseKioskLayoutLenient(kiosk.layout);
  const slotUuids = parsed.layout.boards.map((slot) => slot.boardUuid);

  const boards: ResolvedKioskBoard[] = [];

  if (slotUuids.length > 0) {
    const rows = await db
      .select()
      .from(dbSchema.userBoards)
      .where(
        and(
          eq(dbSchema.userBoards.gymId, kiosk.gymId),
          inArray(dbSchema.userBoards.uuid, slotUuids),
          isNull(dbSchema.userBoards.deletedAt),
        ),
      );

    const visibleByUuid = new Map<string, ResolvedKioskBoard>();
    if (viewerCanEditGym) {
      // Gym editors see every alive, gym-linked slot board (private included).
      for (const row of rows) {
        visibleByUuid.set(row.uuid, {
          boardId: row.id,
          boardUuid: row.uuid,
          slug: row.slug,
          name: row.name,
          boardType: row.boardType,
          layoutId: Number(row.layoutId),
          sizeId: Number(row.sizeId),
          setIds: row.setIds,
          angle: Number(row.angle),
        });
      }
    } else {
      const enriched = await enrichBoards(
        rows.map((board) => ({ board })),
        viewerId,
      );
      for (const board of enriched) {
        if (board.boardId == null) continue;
        visibleByUuid.set(board.uuid, {
          boardId: board.boardId,
          boardUuid: board.uuid,
          slug: board.slug,
          name: board.name,
          boardType: board.boardType,
          layoutId: board.layoutId,
          sizeId: board.sizeId,
          setIds: board.setIds,
          angle: board.angle,
        });
      }
    }

    for (const slot of parsed.layout.boards) {
      const board = visibleByUuid.get(slot.boardUuid);
      if (board) boards.push(board);
    }
  }

  return {
    uuid: kiosk.uuid,
    slug: kiosk.slug,
    name: kiosk.name,
    // Return the leniently-parsed layout, never the raw stored jsonb: a corrupt
    // or future-version row surfaces as an empty layout, never an error.
    layout: parsed.layout,
    // Enriched once by the caller (the manage list shares one gym across all
    // its kiosks — enriching per kiosk would fan the same queries out N times).
    gym: enrichedGym,
    boards,
    createdAt: kiosk.createdAt.toISOString(),
    updatedAt: kiosk.updatedAt.toISOString(),
  };
}

/**
 * Load a live kiosk plus its (live) gym for a write op. A kiosk whose gym was
 * soft-deleted is treated as gone. NOT_FOUND is used uniformly so a caller can't
 * probe which kiosks exist.
 */
async function loadKioskForWrite(kioskUuid: string): Promise<{ kiosk: KioskRow; gym: GymRow }> {
  const [kiosk] = await db
    .select()
    .from(dbSchema.gymKiosks)
    .where(and(eq(dbSchema.gymKiosks.uuid, kioskUuid), isNull(dbSchema.gymKiosks.deletedAt)))
    .limit(1);
  if (!kiosk) {
    throw new GraphQLError('Kiosk not found', { extensions: { code: 'NOT_FOUND' } });
  }

  const [gym] = await db
    .select()
    .from(dbSchema.gyms)
    .where(and(eq(dbSchema.gyms.id, kiosk.gymId), isNull(dbSchema.gyms.deletedAt)))
    .limit(1);
  if (!gym) {
    throw new GraphQLError('Kiosk not found', { extensions: { code: 'NOT_FOUND' } });
  }

  return { kiosk, gym };
}

/**
 * Cheap "does this live kiosk belong to this gym?" check for the public
 * heartbeat path. Tries the Redis existence cache first (heartbeats are hot),
 * falls back to one indexed join, and caches a positive result. Both UUIDs must
 * match — nothing from the unauthenticated input is trusted beyond this lookup.
 */
async function kioskExistsForGym(kioskUuid: string, gymUuid: string): Promise<boolean> {
  if (await isKioskExistenceCached(gymUuid, kioskUuid)) return true;

  const [row] = await db
    .select({ id: dbSchema.gymKiosks.id })
    .from(dbSchema.gymKiosks)
    .innerJoin(dbSchema.gyms, eq(dbSchema.gymKiosks.gymId, dbSchema.gyms.id))
    .where(
      and(
        eq(dbSchema.gymKiosks.uuid, kioskUuid),
        isNull(dbSchema.gymKiosks.deletedAt),
        eq(dbSchema.gyms.uuid, gymUuid),
        isNull(dbSchema.gyms.deletedAt),
      ),
    )
    .limit(1);

  if (!row) return false;
  await cacheKioskExistence(gymUuid, kioskUuid);
  return true;
}

/** Verify every board referenced by a layout is alive and linked to this gym. */
async function assertLayoutBoardsInGym(gymId: number, layout: KioskLayout): Promise<void> {
  const referenced = new Set<string>(layout.boards.map((slot) => slot.boardUuid));
  // The strict schema already forces a single-board leaderboard to be one of the
  // slot boards, but re-collect it so the gym-link check covers it explicitly.
  if (layout.leaderboard?.boardUuid) {
    referenced.add(layout.leaderboard.boardUuid);
  }
  if (referenced.size === 0) return;

  const aliveRows = await db
    .select({ uuid: dbSchema.userBoards.uuid })
    .from(dbSchema.userBoards)
    .where(
      and(
        eq(dbSchema.userBoards.gymId, gymId),
        inArray(dbSchema.userBoards.uuid, [...referenced]),
        isNull(dbSchema.userBoards.deletedAt),
      ),
    );
  const alive = new Set(aliveRows.map((row) => row.uuid));
  const missing = [...referenced].filter((uuid) => !alive.has(uuid));
  if (missing.length > 0) {
    throw new GraphQLError(`Layout references board(s) not linked to this gym: ${missing.join(', ')}`, {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
}

// ============================================
// Queries
// ============================================

export const socialGymKioskQueries = {
  gymKiosk: async (
    _: unknown,
    { gymSlug, kioskSlug }: { gymSlug: string; kioskSlug?: string | null },
    ctx: ConnectionContext,
  ) => {
    await applyRateLimit(ctx, RATE_LIMIT_GYM_KIOSK, 'gymKiosk');

    if (!gymSlug || gymSlug.length > 120 || !GYM_SLUG_PATTERN.test(gymSlug)) {
      return null;
    }

    // A merged twin's slug resolves to the canonical survivor; the enriched
    // payload carries the survivor's slug so the kiosk page can redirect a
    // printed QR's old URL onto the canonical one instead of 404ing the TV.
    const gym = await resolveCanonicalGymBySlug(gymSlug);
    if (!gym) return null;

    const viewerId = ctx.isAuthenticated ? ctx.userId : undefined;
    // Gym-level edit access drives both the private-gym visibility rule and the
    // slot-board visibility inside resolveKioskView.
    const viewerCanEdit = viewerId ? await userCanEditGym(gym, viewerId) : false;

    // Private gym: visible only to a viewer who can edit it; everyone else gets
    // null (indistinguishable from a missing gym/kiosk).
    if (!gym.isPublic && !viewerCanEdit) {
      return null;
    }

    const conditions = [eq(dbSchema.gymKiosks.gymId, gym.id), isNull(dbSchema.gymKiosks.deletedAt)];
    if (kioskSlug != null) {
      if (kioskSlug.length > 60 || !KIOSK_SLUG_LOOKUP_PATTERN.test(kioskSlug)) {
        return null;
      }
      conditions.push(eq(dbSchema.gymKiosks.slug, kioskSlug));
    }

    // Named slug → that kiosk; no slug → the oldest live kiosk as the default
    // (id tiebreak keeps same-millisecond rows deterministic).
    const [kiosk] = await db
      .select()
      .from(dbSchema.gymKiosks)
      .where(and(...conditions))
      .orderBy(asc(dbSchema.gymKiosks.createdAt), asc(dbSchema.gymKiosks.id))
      .limit(1);
    if (!kiosk) return null;

    return resolveKioskView(kiosk, await enrichGym(gym, viewerId), viewerId, viewerCanEdit);
  },

  gymKiosks: async (_: unknown, { gymUuid }: { gymUuid: string }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, RATE_LIMIT_GYM_KIOSKS, 'gymKiosks');
    validateInput(UUIDSchema, gymUuid, 'gymUuid');
    const userId = ctx.userId!;

    const gym = await requireGymEditAccess(gymUuid, userId);

    const kiosks = await db
      .select()
      .from(dbSchema.gymKiosks)
      .where(and(eq(dbSchema.gymKiosks.gymId, gym.id), isNull(dbSchema.gymKiosks.deletedAt)))
      .orderBy(asc(dbSchema.gymKiosks.createdAt), asc(dbSchema.gymKiosks.id));

    // The viewer just passed requireGymEditAccess, so they're a gym editor.
    // Every kiosk shares this one gym — enrich it once, not once per kiosk.
    const enrichedGym = await enrichGym(gym, userId);
    const resolved = await Promise.all(kiosks.map((kiosk) => resolveKioskView(kiosk, enrichedGym, userId, true)));

    // Attach ephemeral liveness from Redis in one batch MGET. A missing signal
    // reads as null ("No signal yet") — never an error and never proof a TV is
    // down (see services/kiosk-heartbeat.ts). Only this edit-guarded query
    // exposes liveness; the public `gymKiosk` read leaves lastSeenAt null.
    const lastSeenByUuid = await readKioskLastSeen(
      gym.uuid,
      resolved.map((kiosk) => kiosk.uuid),
    );
    return resolved.map((kiosk) => ({ ...kiosk, lastSeenAt: lastSeenByUuid.get(kiosk.uuid) ?? null }));
  },
};

// ============================================
// Mutations
// ============================================

export const socialGymKioskMutations = {
  createGymKiosk: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, RATE_LIMIT_CREATE_GYM_KIOSK, 'createGymKiosk');
    const validated = validateInput(CreateGymKioskInputSchema, input, 'input');
    const userId = ctx.userId!;

    const gym = await requireGymEditAccess(validated.gymUuid, userId);

    // Slug derivation stays outside the transaction: it's advisory (the partial
    // unique index is the real guard; a race lands in the catch below).
    const slug = validated.slug ?? (await deriveUniqueKioskSlug(gym.id, validated.name));

    let created: KioskRow;
    try {
      created = await db.transaction(async (tx) => {
        // Serialize concurrent creates for the same gym: lock the gym row so
        // the count-then-insert below can't race — without this, two calls one
        // below MAX_KIOSKS_PER_GYM could both pass the check and leave the gym
        // over the cap (the only DB invariant is the slug index).
        await tx.select({ id: dbSchema.gyms.id }).from(dbSchema.gyms).where(eq(dbSchema.gyms.id, gym.id)).for('update');

        // Enforce the per-gym kiosk cap (live kiosks only; a soft-deleted row
        // frees its slot).
        const [countRow] = await tx
          .select({ value: count() })
          .from(dbSchema.gymKiosks)
          .where(and(eq(dbSchema.gymKiosks.gymId, gym.id), isNull(dbSchema.gymKiosks.deletedAt)));
        if (Number(countRow?.value ?? 0) >= MAX_KIOSKS_PER_GYM) {
          throw new GraphQLError(`A gym can have at most ${MAX_KIOSKS_PER_GYM} kiosks`, {
            extensions: { code: 'BAD_USER_INPUT' },
          });
        }

        const [row] = await tx
          .insert(dbSchema.gymKiosks)
          .values({
            uuid: uuidv4(),
            gymId: gym.id,
            slug,
            name: validated.name,
            // A fresh kiosk starts empty; boards are assigned via updateGymKiosk.
            layout: emptyKioskLayout(),
          })
          .returning();
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'gym_kiosks_unique_gym_slug')) {
        throw new GraphQLError('A kiosk with that slug already exists in this gym', {
          extensions: { code: 'KIOSK_SLUG_ALREADY_EXISTS' },
        });
      }
      throw error;
    }

    // The viewer just passed requireGymEditAccess, so they're a gym editor.
    return resolveKioskView(created, await enrichGym(gym, userId), userId, true);
  },

  updateGymKiosk: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, RATE_LIMIT_UPDATE_GYM_KIOSK, 'updateGymKiosk');
    // `layout`, when present, is strict-validated here (KioskLayoutSchema); the
    // parsed output — unknown keys stripped at every level — is what we persist.
    const validated = validateInput(UpdateGymKioskInputSchema, input, 'input');
    const userId = ctx.userId!;

    const { kiosk, gym } = await loadKioskForWrite(validated.kioskUuid);
    // Authorization failures are masked as the same NOT_FOUND the load path
    // throws, so an authenticated prober can't tell a kiosk they may not edit
    // apart from one that doesn't exist. userCanEditGym covers exactly the
    // requireGymEditAccess set (owner, gym admin/editor, covering community
    // admin/leader) without the distinguishable "Not authorized" error.
    if (!(await userCanEditGym(gym, userId))) {
      throw new GraphQLError('Kiosk not found', { extensions: { code: 'NOT_FOUND' } });
    }

    // Typed against the table's insert shape so a key typo is a compile error
    // instead of a silently ignored column.
    const updateValues: Partial<typeof dbSchema.gymKiosks.$inferInsert> = { updatedAt: new Date() };
    if (validated.name !== undefined) updateValues.name = validated.name;
    if (validated.slug !== undefined) updateValues.slug = validated.slug;

    if (validated.layout !== undefined) {
      await assertLayoutBoardsInGym(kiosk.gymId, validated.layout);
      // Backend is the layout schema authority: persist the schema-parsed output.
      updateValues.layout = validated.layout;
    }

    let updated: KioskRow;
    try {
      [updated] = await db
        .update(dbSchema.gymKiosks)
        .set(updateValues)
        .where(eq(dbSchema.gymKiosks.id, kiosk.id))
        .returning();
    } catch (error) {
      if (isUniqueViolation(error, 'gym_kiosks_unique_gym_slug')) {
        throw new GraphQLError('A kiosk with that slug already exists in this gym', {
          extensions: { code: 'KIOSK_SLUG_ALREADY_EXISTS' },
        });
      }
      throw error;
    }

    // The viewer just passed the gym-edit gate above, so they're a gym editor.
    return resolveKioskView(updated, await enrichGym(gym, userId), userId, true);
  },

  deleteGymKiosk: async (
    _: unknown,
    { kioskUuid }: { kioskUuid: string },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, RATE_LIMIT_DELETE_GYM_KIOSK, 'deleteGymKiosk');
    validateInput(UUIDSchema, kioskUuid, 'kioskUuid');
    const userId = ctx.userId!;

    const { kiosk, gym } = await loadKioskForWrite(kioskUuid);
    // Same NOT_FOUND mask as updateGymKiosk: no existence oracle for
    // authenticated probers.
    if (!(await userCanEditGym(gym, userId))) {
      throw new GraphQLError('Kiosk not found', { extensions: { code: 'NOT_FOUND' } });
    }

    await db.update(dbSchema.gymKiosks).set({ deletedAt: new Date() }).where(eq(dbSchema.gymKiosks.id, kiosk.id));

    return true;
  },

  /**
   * Public, UNAUTHENTICATED kiosk check-in. Called by the kiosk TV pages on load
   * and on their config-poll cadence. Rate-limited per client IP, validates the
   * (kiosk, gym) pair against a live kiosk, then records an ephemeral last-seen
   * timestamp in Redis. Returns false — never an error — when the pair doesn't
   * resolve, so a TV showing a since-deleted kiosk just stops being counted
   * live instead of surfacing a fault.
   */
  kioskHeartbeat: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    await applyRateLimit(ctx, RATE_LIMIT_KIOSK_HEARTBEAT, 'kioskHeartbeat');
    const validated = validateInput(KioskHeartbeatInputSchema, input, 'input');

    if (!(await kioskExistsForGym(validated.kioskUuid, validated.gymUuid))) {
      return false;
    }

    const viewport =
      validated.viewportWidth != null && validated.viewportHeight != null
        ? `${validated.viewportWidth}x${validated.viewportHeight}`
        : null;

    await recordKioskHeartbeat({
      gymUuid: validated.gymUuid,
      kioskUuid: validated.kioskUuid,
      viewport,
    });

    return true;
  },
};
