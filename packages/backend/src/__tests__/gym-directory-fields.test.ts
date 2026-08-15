import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialGymQueries, GYM_BOARD_SUMMARY_ANGLES_PER_TYPE } from '../graphql/resolvers/social/gyms';

/**
 * Real-DB coverage for the three additions the public /gyms directory needs:
 * `SearchGymsInput.requireSlug`, `Gym.isClaimed`, and `Gym.boardSummaries`.
 *
 * Seeds via raw SQL and calls the resolvers directly against the per-worker test
 * DB, same shape as gym-write-access-and-claims.test.ts. Every assertion here is
 * made from an ANONYMOUS context, because signed-out viewers are the directory's
 * entire audience and a viewer-scoped field looks perfectly healthy in a
 * logged-in dev session while rendering nothing in production.
 */

// The location sync parks every gym it imports on this owner, so "claimed" means
// "owner is anyone else".
const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const REAL_OWNER = 'dir-real-owner';
const CLAIMANT = 'dir-claimant';

const ALL_USERS = [SYSTEM_OWNER, REAL_OWNER, CLAIMANT];

const anonCtx = (): ConnectionContext => ({ connectionId: 'conn-anon', isAuthenticated: false }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

const insertGym = async (opts: {
  ownerId: string;
  name: string;
  slug?: string | null;
  isPublic?: boolean;
  /** ISO string; pass the SAME value for several gyms to force a created_at tie. */
  createdAt?: string;
}): Promise<{ id: number; uuid: string }> => {
  const { ownerId, name, isPublic = true, createdAt } = opts;
  const uuid = uuidv4();
  const slug = opts.slug === undefined ? uuid : opts.slug;
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, is_public, created_at, updated_at)
    VALUES (${uuid}, ${name}, ${slug}, ${ownerId}, ${isPublic},
            ${createdAt ? sql`${createdAt}::timestamp` : sql`now()`}, now())
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid };
};

const insertBoard = async (opts: {
  gymId: number;
  boardType?: string;
  angle?: number;
  softDeleted?: boolean;
}): Promise<void> => {
  const { gymId, boardType = 'kilter', angle = 40, softDeleted = false } = opts;
  const uuid = uuidv4();
  await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, angle, gym_id, is_public, deleted_at, created_at, updated_at)
    VALUES (${uuid}, ${uuid}, ${REAL_OWNER}, ${boardType}, 1, 10, '1,2', 'Wall', ${angle}, ${gymId}, true,
            ${softDeleted ? sql`now()` : sql`NULL`}, now(), now())
  `);
};

const gymByUuid = async (gymUuid: string) => {
  const gym = await socialGymQueries.gym(null, { gymUuid }, anonCtx());
  expect(gym).not.toBeNull();
  return gym!;
};

const searchDirectory = (input: Record<string, unknown>) =>
  socialGymQueries.searchGyms(null, { input }, anonCtx()) as Promise<{
    gyms: Array<{ uuid: string; slug: string | null }>;
    totalCount: number;
    hasMore: boolean;
  }>;

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_members", "gym_follows", "gym_claims",
      "board_follows", "boardsesh_ticks", "user_boards", "gyms", "notifications"
    RESTART IDENTITY CASCADE
  `);
  await Promise.all(ALL_USERS.map(insertUser));
});

describe('searchGyms requireSlug', () => {
  it('excludes both NULL and empty-string slugs, and drops totalCount by exactly the excluded count', async () => {
    const withSlug = await insertGym({ ownerId: REAL_OWNER, name: 'Slugged Gym', slug: 'slugged-gym' });
    const nullSlug = await insertGym({ ownerId: REAL_OWNER, name: 'Null Slug Gym', slug: null });
    const emptySlug = await insertGym({ ownerId: REAL_OWNER, name: 'Empty Slug Gym', slug: '' });

    const unfiltered = await searchDirectory({ limit: 50 });
    expect(unfiltered.totalCount).toBe(3);
    expect(unfiltered.gyms.map((gym) => gym.uuid).sort()).toEqual(
      [withSlug.uuid, nullSlug.uuid, emptySlug.uuid].sort(),
    );

    const filtered = await searchDirectory({ limit: 50, requireSlug: true });
    expect(filtered.gyms.map((gym) => gym.uuid)).toEqual([withSlug.uuid]);
    // Two excluded rows, so totalCount must fall by exactly two — the count and
    // the rows are separate statements and only a paired assertion catches them
    // disagreeing.
    expect(filtered.totalCount).toBe(unfiltered.totalCount - 2);
    expect(filtered.hasMore).toBe(false);
  });

  it('keeps every gym when requireSlug is omitted', async () => {
    await insertGym({ ownerId: REAL_OWNER, name: 'Null Slug Gym', slug: null });
    await insertGym({ ownerId: REAL_OWNER, name: 'Slugged Gym', slug: 'slugged-gym' });

    const result = await searchDirectory({ limit: 50 });
    expect(result.totalCount).toBe(2);
    expect(result.gyms).toHaveLength(2);
  });

  it('keeps totalCount and the returned page consistent under paging', async () => {
    await insertGym({ ownerId: REAL_OWNER, name: 'No Slug A', slug: null });
    await insertGym({ ownerId: REAL_OWNER, name: 'No Slug B', slug: '' });
    for (let index = 0; index < 3; index++) {
      await insertGym({ ownerId: REAL_OWNER, name: `Slugged ${index}`, slug: `slugged-${index}` });
    }

    const firstPage = await searchDirectory({ limit: 2, offset: 0, requireSlug: true });
    expect(firstPage.totalCount).toBe(3);
    expect(firstPage.gyms).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await searchDirectory({ limit: 2, offset: 2, requireSlug: true });
    expect(secondPage.totalCount).toBe(3);
    expect(secondPage.gyms).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);
  });

  it('pages cleanly over gyms sharing one created_at — no duplicates, no skips', async () => {
    // A bulk sync import writes many rows with the same created_at. Ordering by
    // created_at alone leaves those rows unordered relative to each other, so
    // Postgres may return them in a different order per OFFSET page: one gym
    // appears twice and another never appears. `gyms.id` is the tiebreaker that
    // makes the sequence total.
    const sharedCreatedAt = '2026-01-01T00:00:00.000Z';
    for (let index = 0; index < 6; index++) {
      await insertGym({
        ownerId: REAL_OWNER,
        name: `Tied Gym ${index}`,
        slug: `tied-gym-${index}`,
        createdAt: sharedCreatedAt,
      });
    }

    const pagedUuids: string[] = [];
    for (let offset = 0; offset < 6; offset += 2) {
      const page = await searchDirectory({ limit: 2, offset, requireSlug: true });
      expect(page.totalCount).toBe(6);
      pagedUuids.push(...page.gyms.map((gym) => gym.uuid));
    }

    expect(pagedUuids).toHaveLength(6);
    expect(new Set(pagedUuids).size).toBe(6);

    // And the order is the same on a repeat walk — stable, not merely unique.
    const secondWalk: string[] = [];
    for (let offset = 0; offset < 6; offset += 2) {
      const page = await searchDirectory({ limit: 2, offset, requireSlug: true });
      secondWalk.push(...page.gyms.map((gym) => gym.uuid));
    }
    expect(secondWalk).toEqual(pagedUuids);
  });
});

describe('Gym.isClaimed', () => {
  it('is false for a system-owned gym and true once ownership moves to a person — anonymously, both times', async () => {
    const gym = await insertGym({ ownerId: SYSTEM_OWNER, name: 'Synced Gym' });

    const before = await gymByUuid(gym.uuid);
    expect(before.isClaimed).toBe(false);
    // The point of the field: canClaim is false here purely because the viewer is
    // signed out, so a card gated on it would show nothing to the SEO audience.
    expect(before.canClaim).toBe(false);

    await db.execute(sql`UPDATE gyms SET owner_id = ${CLAIMANT} WHERE id = ${gym.id}`);

    const after = await gymByUuid(gym.uuid);
    expect(after.isClaimed).toBe(true);
    expect(after.canClaim).toBe(false);
  });

  it('is true for a user-created gym from the start', async () => {
    const gym = await insertGym({ ownerId: REAL_OWNER, name: 'Owner Made Gym' });
    expect((await gymByUuid(gym.uuid)).isClaimed).toBe(true);
  });
});

describe('Gym.boardSummaries', () => {
  it('returns one entry per distinct type+angle while boardTypes collapses to the type', async () => {
    const gym = await insertGym({ ownerId: REAL_OWNER, name: 'Two Angle Gym' });
    await insertBoard({ gymId: gym.id, boardType: 'kilter', angle: 40 });
    await insertBoard({ gymId: gym.id, boardType: 'kilter', angle: 25 });

    const enriched = await gymByUuid(gym.uuid);
    expect(enriched.boardTypes).toEqual(['kilter']);
    expect(enriched.boardSummaries).toEqual([
      { boardType: 'kilter', angle: 25 },
      { boardType: 'kilter', angle: 40 },
    ]);
    expect(enriched.boardCount).toBe(2);
  });

  it('collapses two boards of the same type at the same angle into one summary', async () => {
    const gym = await insertGym({ ownerId: REAL_OWNER, name: 'Twin Board Gym' });
    await insertBoard({ gymId: gym.id, boardType: 'tension', angle: 40 });
    await insertBoard({ gymId: gym.id, boardType: 'tension', angle: 40 });

    const enriched = await gymByUuid(gym.uuid);
    expect(enriched.boardSummaries).toEqual([{ boardType: 'tension', angle: 40 }]);
    expect(enriched.boardCount).toBe(2);
  });

  it('orders deterministically by board type then angle', async () => {
    const gym = await insertGym({ ownerId: REAL_OWNER, name: 'Mixed Gym' });
    await insertBoard({ gymId: gym.id, boardType: 'tension', angle: 40 });
    await insertBoard({ gymId: gym.id, boardType: 'kilter', angle: 50 });
    await insertBoard({ gymId: gym.id, boardType: 'kilter', angle: 30 });

    const enriched = await gymByUuid(gym.uuid);
    expect(enriched.boardSummaries).toEqual([
      { boardType: 'kilter', angle: 30 },
      { boardType: 'kilter', angle: 50 },
      { boardType: 'tension', angle: 40 },
    ]);
    expect(enriched.boardTypes).toEqual(['kilter', 'tension']);
  });

  it('leaves soft-deleted boards out of both boardTypes and boardSummaries', async () => {
    const gym = await insertGym({ ownerId: REAL_OWNER, name: 'Retired Board Gym' });
    await insertBoard({ gymId: gym.id, boardType: 'kilter', angle: 40 });
    await insertBoard({ gymId: gym.id, boardType: 'moonboard', angle: 40, softDeleted: true });

    const enriched = await gymByUuid(gym.uuid);
    expect(enriched.boardTypes).toEqual(['kilter']);
    expect(enriched.boardSummaries).toEqual([{ boardType: 'kilter', angle: 40 }]);
    expect(enriched.boardCount).toBe(1);
  });

  it('returns an empty list, never null, for a gym with no boards', async () => {
    const gym = await insertGym({ ownerId: REAL_OWNER, name: 'Boardless Gym' });

    const enriched = await gymByUuid(gym.uuid);
    expect(enriched.boardSummaries).toEqual([]);
    expect(enriched.boardTypes).toEqual([]);
  });

  it('caps angles per board type while boardCount stays honest', async () => {
    const gym = await insertGym({ ownerId: REAL_OWNER, name: 'Board Farm' });
    const distinctAngleCount = GYM_BOARD_SUMMARY_ANGLES_PER_TYPE + 4;
    for (let index = 0; index < distinctAngleCount; index++) {
      await insertBoard({ gymId: gym.id, boardType: 'kilter', angle: 10 + index });
    }

    const enriched = await gymByUuid(gym.uuid);
    expect(enriched.boardSummaries).toHaveLength(GYM_BOARD_SUMMARY_ANGLES_PER_TYPE);
    // Ordered before capping, so the cut keeps the lowest angles rather than an
    // arbitrary subset Postgres happened to return.
    expect(enriched.boardSummaries[0]).toEqual({ boardType: 'kilter', angle: 10 });
    expect(enriched.boardCount).toBe(distinctAngleCount);
    expect(enriched.boardTypes).toEqual(['kilter']);
  });

  it('never drops a board type off the end of the cap, even behind a type with many angles', async () => {
    // The regression this guards: a flat cap over a list ordered
    // `board_type, angle` spends the whole budget on `kilter` and returns zero
    // moonboard summaries — so on /gyms/moonboard a gym matched BY the moonboard
    // filter renders with no MoonBoard chip. SEARCH_GYMS_DIRECTORY selects
    // boardSummaries and not boardTypes, so nothing else would cover for it.
    const gym = await insertGym({ ownerId: REAL_OWNER, name: 'Kilter Wall Plus One Moonboard' });
    for (let index = 0; index < GYM_BOARD_SUMMARY_ANGLES_PER_TYPE + 6; index++) {
      await insertBoard({ gymId: gym.id, boardType: 'kilter', angle: 10 + index });
    }
    await insertBoard({ gymId: gym.id, boardType: 'moonboard', angle: 40 });

    const enriched = await gymByUuid(gym.uuid);
    const summarisedTypes = [...new Set(enriched.boardSummaries.map((summary) => summary.boardType))];
    expect(summarisedTypes).toEqual(['kilter', 'moonboard']);
    expect(enriched.boardSummaries).toContainEqual({ boardType: 'moonboard', angle: 40 });
    // Every type in boardTypes has at least one chip — the invariant that makes
    // the facet pages safe.
    expect(summarisedTypes).toEqual(enriched.boardTypes);
    // ...and the per-type cap still bounds the kilter run.
    expect(enriched.boardSummaries.filter((summary) => summary.boardType === 'kilter')).toHaveLength(
      GYM_BOARD_SUMMARY_ANGLES_PER_TYPE,
    );
  });
});
