/**
 * The hold-outline override resolvers: who may reach them, what shapes they
 * accept, and what a round trip stores.
 *
 * The authorization matrix is the point of most of this file. Unlike the gym
 * handover (global admins only), these operations are BOARD-SCOPED: a community
 * admin scoped to Kilter corrects Kilter's art and nothing else, and a global
 * admin corrects everything. The read is gated too, so a non-admin cannot
 * enumerate the deployed shard set.
 */

import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import {
  HOLD_OUTLINE_CODES,
  holdOutlineMutations,
  holdOutlineQueries,
} from '../graphql/resolvers/board/hold-outline-overrides';
import { resetAllRateLimits } from '../utils/rate-limiter';

const GLOBAL_ADMIN = 'hoo-global-admin';
const KILTER_ADMIN = 'hoo-kilter-admin';
const PLAIN_USER = 'hoo-plain-user';

/** Kilter Original 12x12 — a real config with a shipped geometry shard. */
const KILTER_CONFIG = { boardName: 'kilter', layoutId: 1, sizeId: 10 } as const;
/** A real Kilter placement on that config, so the membership check passes. */
const KILTER_PLACEMENT = 1073;
/** Tension Spray Original 12x12 — the other side of the board-scope matrix. */
const TENSION_CONFIG = { boardName: 'tension', layoutId: 10, sizeId: 10 } as const;
const TENSION_PLACEMENT = 304;

/** A unit square around the placement centre: valid, and easy to reason about. */
const SQUARE_RING = [-1, -1, 1, -1, 1, 1, -1, 1];

const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}`, isAuthenticated: true, userId }) as ConnectionContext;
const anonCtx = (): ConnectionContext => ({ connectionId: 'conn-anon', isAuthenticated: false }) as ConnectionContext;

async function insertUser(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

type StoredOverride = { placement_id: number; outline: number[]; note: string | null; author_id: string | null };

async function storedOverrides(): Promise<StoredOverride[]> {
  const result = await db.execute(sql`
    SELECT placement_id, outline, note, author_id
      FROM hold_outline_overrides
     ORDER BY board_name, layout_id, size_id, placement_id
  `);
  return Array.from(result as Iterable<StoredOverride>);
}

beforeEach(async () => {
  resetAllRateLimits();
  await db.execute(sql`TRUNCATE TABLE hold_outline_overrides, community_roles RESTART IDENTITY CASCADE`);
  await Promise.all([GLOBAL_ADMIN, KILTER_ADMIN, PLAIN_USER].map(insertUser));
  await db.execute(sql`
    INSERT INTO community_roles (user_id, role, board_type, created_at)
    VALUES
      (${GLOBAL_ADMIN}, 'admin', NULL, now()),
      (${KILTER_ADMIN}, 'admin', 'kilter', now())
  `);
});

/** Every operation, so an authorization test can sweep all three at once. */
type BoardConfig = { boardName: string; layoutId: number; sizeId: number };

async function callAll(config: BoardConfig, placementId: number, ctx: ConnectionContext): Promise<unknown[]> {
  return Promise.all([
    holdOutlineQueries.holdOutlines(null, { input: { ...config } }, ctx),
    holdOutlineMutations.upsertHoldOutlineOverride(
      null,
      { input: { ...config, placementId, outline: SQUARE_RING } },
      ctx,
    ),
    holdOutlineMutations.deleteHoldOutlineOverride(null, { input: { ...config, placementId } }, ctx),
  ]);
}

describe('hold outline override authorization', () => {
  it('rejects anonymous and non-admin callers on the query and both mutations', async () => {
    for (const ctx of [anonCtx(), authCtx(PLAIN_USER)]) {
      await expect(holdOutlineQueries.holdOutlines(null, { input: { ...KILTER_CONFIG } }, ctx)).rejects.toThrow(
        /(admin role|authentication) required/i,
      );
      await expect(
        holdOutlineMutations.upsertHoldOutlineOverride(
          null,
          { input: { ...KILTER_CONFIG, placementId: KILTER_PLACEMENT, outline: SQUARE_RING } },
          ctx,
        ),
      ).rejects.toThrow(/(admin role|authentication) required/i);
      await expect(
        holdOutlineMutations.deleteHoldOutlineOverride(
          null,
          { input: { ...KILTER_CONFIG, placementId: KILTER_PLACEMENT } },
          ctx,
        ),
      ).rejects.toThrow(/(admin role|authentication) required/i);
    }

    expect(await storedOverrides()).toHaveLength(0);
  });

  it('lets a board-scoped admin reach their own board only', async () => {
    await expect(callAll(KILTER_CONFIG, KILTER_PLACEMENT, authCtx(KILTER_ADMIN))).resolves.toHaveLength(3);

    // Same role row, different board: the scope is the whole point of it.
    await expect(
      holdOutlineQueries.holdOutlines(null, { input: { ...TENSION_CONFIG } }, authCtx(KILTER_ADMIN)),
    ).rejects.toThrow(/admin role required/i);
    await expect(
      holdOutlineMutations.upsertHoldOutlineOverride(
        null,
        { input: { ...TENSION_CONFIG, placementId: TENSION_PLACEMENT, outline: SQUARE_RING } },
        authCtx(KILTER_ADMIN),
      ),
    ).rejects.toThrow(/admin role required/i);
    await expect(
      holdOutlineMutations.deleteHoldOutlineOverride(
        null,
        { input: { ...TENSION_CONFIG, placementId: TENSION_PLACEMENT } },
        authCtx(KILTER_ADMIN),
      ),
    ).rejects.toThrow(/admin role required/i);
  });

  it('lets a global admin reach every board', async () => {
    await expect(callAll(KILTER_CONFIG, KILTER_PLACEMENT, authCtx(GLOBAL_ADMIN))).resolves.toHaveLength(3);
    await expect(callAll(TENSION_CONFIG, TENSION_PLACEMENT, authCtx(GLOBAL_ADMIN))).resolves.toHaveLength(3);
  });
});

describe('upsertHoldOutlineOverride validation', () => {
  const upsert = (outline: number[], placementId = KILTER_PLACEMENT) =>
    holdOutlineMutations.upsertHoldOutlineOverride(
      null,
      { input: { ...KILTER_CONFIG, placementId, outline } },
      authCtx(GLOBAL_ADMIN),
    );

  it('rejects an odd-length ring', async () => {
    await expect(upsert([-1, -1, 1, -1, 1, 1, 0])).rejects.toThrow(/Invalid input/);
    expect(await storedOverrides()).toHaveLength(0);
  });

  it('rejects a ring with fewer than three points', async () => {
    await expect(upsert([-1, -1, 1, 1])).rejects.toThrow(/Invalid input/);
  });

  it('rejects NaN and Infinity coordinates', async () => {
    await expect(upsert([-1, -1, 1, -1, Number.NaN, 1])).rejects.toThrow(/Invalid input/);
    await expect(upsert([-1, -1, 1, -1, Number.POSITIVE_INFINITY, 1])).rejects.toThrow(/Invalid input/);
  });

  it('rejects a coordinate outside the four-radius bound', async () => {
    await expect(upsert([-1, -1, 1, -1, 4.5, 1])).rejects.toThrow(/Invalid input/);
    await expect(upsert([-1, -1, 1, -1, -4.5, 1])).rejects.toThrow(/Invalid input/);
  });

  it('rejects a ring that does not enclose the placement centre', async () => {
    // Shape-valid, and drawn entirely off to one side — the signature of an
    // outline traced or drawn against the neighbouring hold.
    await expect(upsert([1, 1, 2, 1, 2, 2])).rejects.toMatchObject({
      extensions: { code: HOLD_OUTLINE_CODES.centreOutside },
    });
    expect(await storedOverrides()).toHaveLength(0);
  });

  it('rejects a placement that is not on the board config', async () => {
    await expect(upsert(SQUARE_RING, 999_999)).rejects.toMatchObject({
      extensions: { code: HOLD_OUTLINE_CODES.unknownPlacement },
    });
    expect(await storedOverrides()).toHaveLength(0);
  });

  it('rejects an unknown board name before it reaches the role check', async () => {
    await expect(
      holdOutlineMutations.upsertHoldOutlineOverride(
        null,
        { input: { boardName: 'notaboard', layoutId: 1, sizeId: 10, placementId: 1, outline: SQUARE_RING } },
        authCtx(GLOBAL_ADMIN),
      ),
    ).rejects.toThrow(/Invalid input/);
  });
});

describe('hold outline override round trip', () => {
  it('stores, reads back, replaces, and deletes an override', async () => {
    const created = await holdOutlineMutations.upsertHoldOutlineOverride(
      null,
      {
        input: {
          ...KILTER_CONFIG,
          placementId: KILTER_PLACEMENT,
          outline: SQUARE_RING,
          note: 'The tracer swallowed the left lobe.',
        },
      },
      authCtx(GLOBAL_ADMIN),
    );

    expect(created).toMatchObject({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      placementId: KILTER_PLACEMENT,
      outline: SQUARE_RING,
      note: 'The tracer swallowed the left lobe.',
      authorId: GLOBAL_ADMIN,
      authorDisplayName: `User ${GLOBAL_ADMIN}`,
    });
    expect(new Date(created.updatedAt).getTime()).toBeGreaterThan(0);

    const read = await holdOutlineQueries.holdOutlines(null, { input: { ...KILTER_CONFIG } }, authCtx(GLOBAL_ADMIN));
    expect(read).toMatchObject({ boardName: 'kilter', layoutId: 1, sizeId: 10 });
    expect(read.overrides).toHaveLength(1);
    expect(read.overrides[0]).toMatchObject({ placementId: KILTER_PLACEMENT, outline: SQUARE_RING });

    // The deployed shard is served alongside the override, not merged into it,
    // so the editor can show both and offer a revert.
    expect(read.shardOutlines.length).toBeGreaterThan(400);
    const shardEntry = read.shardOutlines.find((entry) => entry.placementId === KILTER_PLACEMENT);
    expect(shardEntry?.outline.length).toBeGreaterThanOrEqual(6);
    expect(shardEntry?.outline).not.toEqual(SQUARE_RING);

    // Second write to the same placement replaces the first — latest wins, one
    // row, no history.
    const wider = [-1.5, -1.5, 1.5, -1.5, 1.5, 1.5, -1.5, 1.5];
    const replaced = await holdOutlineMutations.upsertHoldOutlineOverride(
      null,
      { input: { ...KILTER_CONFIG, placementId: KILTER_PLACEMENT, outline: wider } },
      authCtx(KILTER_ADMIN),
    );
    expect(replaced.outline).toEqual(wider);
    expect(replaced.authorId).toBe(KILTER_ADMIN);
    // An omitted note clears the previous one rather than leaving a stale reason
    // attached to a different shape.
    expect(replaced.note).toBeNull();
    expect(await storedOverrides()).toEqual([
      { placement_id: KILTER_PLACEMENT, outline: wider, note: null, author_id: KILTER_ADMIN },
    ]);

    await expect(
      holdOutlineMutations.deleteHoldOutlineOverride(
        null,
        { input: { ...KILTER_CONFIG, placementId: KILTER_PLACEMENT } },
        authCtx(GLOBAL_ADMIN),
      ),
    ).resolves.toBe(true);
    expect(await storedOverrides()).toHaveLength(0);
  });

  it('reports false when there is nothing to delete', async () => {
    await expect(
      holdOutlineMutations.deleteHoldOutlineOverride(
        null,
        { input: { ...KILTER_CONFIG, placementId: KILTER_PLACEMENT } },
        authCtx(GLOBAL_ADMIN),
      ),
    ).resolves.toBe(false);
  });

  it('rounds coordinates to the shard contract of four decimals before storing', async () => {
    const created = await holdOutlineMutations.upsertHoldOutlineOverride(
      null,
      {
        input: {
          ...KILTER_CONFIG,
          placementId: KILTER_PLACEMENT,
          outline: [-1.000012, -1.00009, 1.123456, -1, 1, 1.98765, -1, 1],
        },
      },
      authCtx(GLOBAL_ADMIN),
    );

    const rounded = [-1, -1.0001, 1.1235, -1, 1, 1.9877, -1, 1];
    expect(created.outline).toEqual(rounded);
    expect((await storedOverrides())[0].outline).toEqual(rounded);
  });

  it("keeps one board config's overrides out of another config's read", async () => {
    await holdOutlineMutations.upsertHoldOutlineOverride(
      null,
      { input: { ...KILTER_CONFIG, placementId: KILTER_PLACEMENT, outline: SQUARE_RING } },
      authCtx(GLOBAL_ADMIN),
    );
    await holdOutlineMutations.upsertHoldOutlineOverride(
      null,
      { input: { ...TENSION_CONFIG, placementId: TENSION_PLACEMENT, outline: SQUARE_RING } },
      authCtx(GLOBAL_ADMIN),
    );

    const kilter = await holdOutlineQueries.holdOutlines(null, { input: { ...KILTER_CONFIG } }, authCtx(GLOBAL_ADMIN));
    expect(kilter.overrides.map((entry) => entry.placementId)).toEqual([KILTER_PLACEMENT]);

    const tension = await holdOutlineQueries.holdOutlines(
      null,
      { input: { ...TENSION_CONFIG } },
      authCtx(GLOBAL_ADMIN),
    );
    expect(tension.overrides.map((entry) => entry.placementId)).toEqual([TENSION_PLACEMENT]);
    expect(tension.boardName).toBe('tension');
  });
});
