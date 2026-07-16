import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialGymDuplicateQueries, socialGymDuplicateMutations } from '../graphql/resolvers/social/gym-duplicates';

/**
 * Real-DB coverage for the /admin/gym-duplicates review queue: the admin gate,
 * the tiered candidate clustering, dismissal filtering, the orphan audit, and the
 * mergeGyms mutation (claims unique-pending conflict, kiosk slug-suffix warning,
 * moved counts, merged_into pointer, audit rows).
 *
 * Mirrors gym-write-access-and-claims.test.ts: seeds via raw SQL and calls the
 * resolvers directly against the per-worker test DB.
 */

const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const ADMIN = 'gd-admin';
const PLAIN_USER = 'gd-plain';
const GYM_OWNER = 'gd-gym-owner';
const CLAIMANT_BOTH = 'gd-claimant-both';
const CLAIMANT_DUP_ONLY = 'gd-claimant-dup';

const ALL_USERS = [SYSTEM_OWNER, ADMIN, PLAIN_USER, GYM_OWNER, CLAIMANT_BOTH, CLAIMANT_DUP_ONLY];

const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}`, isAuthenticated: true, userId }) as ConnectionContext;

const anonCtx = (): ConnectionContext => ({ connectionId: 'conn-anon', isAuthenticated: false }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

const insertAdminRole = (userId: string) =>
  db.execute(sql`
    INSERT INTO community_roles (user_id, role, board_type, created_at)
    VALUES (${userId}, 'admin', NULL, now())
  `);

const insertGym = async (opts: {
  ownerId: string;
  name: string;
  latitude: number;
  longitude: number;
  createdAt?: string;
  uuid?: string;
}): Promise<{ id: number; uuid: string }> => {
  const { ownerId, name, latitude, longitude, createdAt = '2026-01-01T00:00:00Z', uuid = uuidv4() } = opts;
  const result = await db.execute(sql`
    INSERT INTO gyms (uuid, name, slug, owner_id, latitude, longitude, is_public, created_at, updated_at)
    VALUES (${uuid}, ${name}, ${uuid}, ${ownerId}, ${latitude}, ${longitude}, true, ${createdAt}, ${createdAt})
    RETURNING id
  `);
  return { id: Number(Array.from(result as Iterable<{ id: number }>)[0].id), uuid };
};

const insertBoard = async (gymId: number, ownerId: string): Promise<void> => {
  const uuid = uuidv4();
  await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, gym_id, is_public, created_at, updated_at)
    VALUES (${uuid}, ${uuid}, ${ownerId}, 'kilter', 1, 10, '1,2', 'Wall', ${gymId}, true, now(), now())
  `);
};

const insertSource = (gymId: number, sourceKey: string) =>
  db.execute(sql`
    INSERT INTO location_sync_gym_sources (source_key, gym_id, created_at, updated_at)
    VALUES (${sourceKey}, ${gymId}, now(), now())
  `);

const insertKiosk = (gymId: number, slug: string, name: string) =>
  db.execute(sql`
    INSERT INTO gym_kiosks (uuid, gym_id, slug, name, created_at, updated_at)
    VALUES (${uuidv4()}, ${gymId}, ${slug}, ${name}, now(), now())
  `);

const insertClaim = (gymId: number, claimantUserId: string, status = 'pending') =>
  db.execute(sql`
    INSERT INTO gym_claims (gym_id, claimant_user_id, method, status, created_at, updated_at)
    VALUES (${gymId}, ${claimantUserId}, 'admin', ${status}, now(), now())
  `);

const insertGymMember = (gymId: number, userId: string, role: string) =>
  db.execute(sql`
    INSERT INTO gym_members (gym_id, user_id, role, created_at)
    VALUES (${gymId}, ${userId}, ${role}, now())
  `);

const gymRow = async (
  uuid: string,
): Promise<{ deleted_at: Date | null; merged_into_gym_id: number | null } | undefined> => {
  const result = await db.execute(sql`
    SELECT deleted_at, merged_into_gym_id FROM gyms WHERE uuid = ${uuid} LIMIT 1
  `);
  return Array.from(result as Iterable<{ deleted_at: Date | null; merged_into_gym_id: number | null }>)[0];
};

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_members", "gym_follows", "gym_claims", "gym_kiosks",
      "gym_merge_audit", "location_sync_gym_sources", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await Promise.all(ALL_USERS.map(insertUser));
  await insertAdminRole(ADMIN);
});

describe('admin gate', () => {
  it('rejects a non-admin and an anonymous caller on every duplicate resolver', async () => {
    for (const ctx of [authCtx(PLAIN_USER), anonCtx()]) {
      await expect(socialGymDuplicateQueries.duplicateGymClusters(null, { input: {} }, ctx)).rejects.toThrow();
      await expect(socialGymDuplicateQueries.orphanGyms(null, { input: {} }, ctx)).rejects.toThrow();
      await expect(
        socialGymDuplicateMutations.mergeGyms(
          null,
          { input: { canonicalGymUuid: uuidv4(), duplicateGymUuids: [uuidv4()] } },
          ctx,
        ),
      ).rejects.toThrow();
      await expect(
        socialGymDuplicateMutations.dismissGymCluster(
          null,
          { input: { gymUuids: [uuidv4(), uuidv4()], canonicalGymUuid: uuidv4() } },
          ctx,
        ),
      ).rejects.toThrow();
    }
  });
});

describe('duplicateGymClusters', () => {
  it('tiers a tight cluster A and a drifted cluster B, and prefers a user-owned survivor', async () => {
    // Tier A: two "Alpha Gym" rows ~11 m apart. The system-owned row is more
    // complete (a board), but the user-owned row must still be pre-selected.
    const alphaSystem = await insertGym({
      ownerId: SYSTEM_OWNER,
      name: 'Alpha Gym',
      latitude: 40.0,
      longitude: -105.0,
    });
    await insertBoard(alphaSystem.id, SYSTEM_OWNER);
    await insertSource(alphaSystem.id, 'kilter:alpha-1');
    const alphaUser = await insertGym({ ownerId: GYM_OWNER, name: 'Alpha Gym', latitude: 40.0001, longitude: -105.0 });

    // Tier B: two "Beta Gym" rows ~111 m apart.
    await insertGym({ ownerId: SYSTEM_OWNER, name: 'Beta Gym', latitude: 40.1, longitude: -105.0 });
    await insertGym({ ownerId: SYSTEM_OWNER, name: 'Beta Gym', latitude: 40.101, longitude: -105.0 });

    const result = await socialGymDuplicateQueries.duplicateGymClusters(null, { input: {} }, authCtx(ADMIN));
    expect(result.totalCount).toBe(2);

    const alphaCluster = result.clusters.find((c) => c.normalizedName === 'alpha gym')!;
    const betaCluster = result.clusters.find((c) => c.normalizedName === 'beta gym')!;
    expect(alphaCluster.tier).toBe('A');
    expect(betaCluster.tier).toBe('B');
    // Tier A sorts before tier B.
    expect(result.clusters[0].normalizedName).toBe('alpha gym');

    // The user-owned Alpha row is the suggested survivor despite being emptier.
    expect(alphaCluster.suggestedCanonicalGymUuid).toBe(alphaUser.uuid);
    const suggested = alphaCluster.members.find((m) => m.isSuggestedCanonical)!;
    expect(suggested.gymUuid).toBe(alphaUser.uuid);
    expect(suggested.ownerType).toBe('user');

    const systemMember = alphaCluster.members.find((m) => m.gymUuid === alphaSystem.uuid)!;
    expect(systemMember.ownerType).toBe('system');
    expect(systemMember.providerOrigins).toEqual(['kilter']);
    expect(systemMember.boardCount).toBe(1);
    expect(systemMember.distanceToCanonicalMeters).toBeGreaterThan(0);
  });

  it('marks a pending-claim member and excludes a dismissed cluster', async () => {
    const gymA = await insertGym({ ownerId: SYSTEM_OWNER, name: 'Claimed Gym', latitude: 41.0, longitude: -105.0 });
    const gymB = await insertGym({ ownerId: SYSTEM_OWNER, name: 'Claimed Gym', latitude: 41.0001, longitude: -105.0 });
    await insertClaim(gymA.id, CLAIMANT_DUP_ONLY, 'pending');

    const before = await socialGymDuplicateQueries.duplicateGymClusters(null, { input: {} }, authCtx(ADMIN));
    const cluster = before.clusters.find((c) => c.normalizedName === 'claimed gym')!;
    expect(cluster).toBeDefined();
    const claimedMember = cluster.members.find((m) => m.gymUuid === gymA.uuid)!;
    expect(claimedMember.claimStatus).toBe('pending');
    expect(claimedMember.claimCount).toBe(1);
    // A pending claim makes gymA the preferred survivor over the plain system row.
    expect(cluster.suggestedCanonicalGymUuid).toBe(gymA.uuid);

    await socialGymDuplicateMutations.dismissGymCluster(
      null,
      { input: { gymUuids: [gymA.uuid, gymB.uuid], canonicalGymUuid: gymA.uuid } },
      authCtx(ADMIN),
    );

    const after = await socialGymDuplicateQueries.duplicateGymClusters(null, { input: {} }, authCtx(ADMIN));
    expect(after.clusters.find((c) => c.normalizedName === 'claimed gym')).toBeUndefined();
    expect(after.totalCount).toBe(0);
  });
});

describe('mergeGyms', () => {
  it('re-points a duplicate, suffixes a colliding kiosk slug, resolves the claim conflict, and audits it', async () => {
    const canonical = await insertGym({
      ownerId: GYM_OWNER,
      name: 'Merge Gym',
      latitude: 42.0,
      longitude: -105.0,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const duplicate = await insertGym({
      ownerId: SYSTEM_OWNER,
      name: 'Merge Gym',
      latitude: 42.0001,
      longitude: -105.0,
      createdAt: '2026-01-02T00:00:00Z',
    });

    await insertBoard(duplicate.id, SYSTEM_OWNER);
    await insertKiosk(canonical.id, 'main-wall', 'Canonical Main');
    await insertKiosk(duplicate.id, 'main-wall', 'Duplicate Main');
    // Claimant with a pending claim on BOTH gyms (a mid-flight collision) plus one
    // claimant with a pending claim only on the duplicate.
    await insertClaim(canonical.id, CLAIMANT_BOTH, 'pending');
    await insertClaim(duplicate.id, CLAIMANT_BOTH, 'pending');
    await insertClaim(duplicate.id, CLAIMANT_DUP_ONLY, 'pending');
    // Member role precedence: PLAIN_USER is an editor on the canonical but only a
    // member on the twin (must not be demoted); CLAIMANT_DUP_ONLY is an editor
    // only on the twin (must arrive as editor).
    await insertGymMember(canonical.id, PLAIN_USER, 'editor');
    await insertGymMember(duplicate.id, PLAIN_USER, 'member');
    await insertGymMember(duplicate.id, CLAIMANT_DUP_ONLY, 'editor');

    const result = await socialGymDuplicateMutations.mergeGyms(
      null,
      { input: { canonicalGymUuid: canonical.uuid, duplicateGymUuids: [duplicate.uuid] } },
      authCtx(ADMIN),
    );

    expect(result.canonicalGymUuid).toBe(canonical.uuid);
    expect(result.results).toHaveLength(1);
    const merged = result.results[0];
    expect(merged.duplicateGymUuid).toBe(duplicate.uuid);
    expect(merged.counts.boards).toBe(1);
    expect(merged.counts.kiosks).toBe(1);
    // The duplicate's only-there claimant is promoted; the collision is expired.
    expect(merged.counts.claims).toBe(1);

    // Editor precedence held on both sides — no demotion to member.
    const roleRows = await db.execute(sql`
      SELECT user_id, role FROM gym_members WHERE gym_id = ${canonical.id} ORDER BY user_id
    `);
    const roleByUser = new Map(
      Array.from(roleRows as Iterable<{ user_id: string; role: string }>).map((row) => [row.user_id, row.role]),
    );
    expect(roleByUser.get(PLAIN_USER)).toBe('editor');
    expect(roleByUser.get(CLAIMANT_DUP_ONLY)).toBe('editor');

    // The colliding kiosk was re-slugged and reported.
    expect(merged.warnings).toHaveLength(1);
    expect(merged.warnings[0]).toMatchObject({ previousSlug: 'main-wall', newSlug: 'main-wall-2' });

    // The duplicate is soft-deleted and points at the survivor.
    const dupRow = await gymRow(duplicate.uuid);
    expect(dupRow?.deleted_at).not.toBeNull();
    expect(Number(dupRow?.merged_into_gym_id)).toBe(canonical.id);

    // Exactly one pending claim per claimant now sits on the canonical.
    const pending = await db.execute(sql`
      SELECT claimant_user_id FROM gym_claims WHERE gym_id = ${canonical.id} AND status = 'pending' ORDER BY claimant_user_id
    `);
    const pendingClaimants = Array.from(pending as Iterable<{ claimant_user_id: string }>).map(
      (row) => row.claimant_user_id,
    );
    expect(pendingClaimants).toEqual([CLAIMANT_BOTH, CLAIMANT_DUP_ONLY].sort());

    // The board moved onto the canonical.
    const boardCount = await db.execute(sql`
      SELECT count(*)::int AS count FROM user_boards WHERE gym_id = ${canonical.id}
    `);
    expect(Number(Array.from(boardCount as Iterable<{ count: number }>)[0].count)).toBe(1);

    // One 'merged' audit row was written for the duplicate, carrying the moved-row
    // ids (not just aggregate counts) so a bad merge can be reversed.
    const audit = await db.execute(sql`
      SELECT action, canonical_gym_id, duplicate_gym_id, moved_rows FROM gym_merge_audit WHERE action = 'merged'
    `);
    const auditRows = Array.from(
      audit as Iterable<{
        action: string;
        canonical_gym_id: number;
        duplicate_gym_id: number;
        moved_rows: { boardIds: number[] } | null;
      }>,
    );
    expect(auditRows).toHaveLength(1);
    expect(Number(auditRows[0].canonical_gym_id)).toBe(canonical.id);
    expect(Number(auditRows[0].duplicate_gym_id)).toBe(duplicate.id);
    expect(auditRows[0].moved_rows?.boardIds).toHaveLength(1);
  });

  it('rejects a canonical that is also listed as a duplicate', async () => {
    const gym = await insertGym({ ownerId: GYM_OWNER, name: 'Solo Gym', latitude: 43.0, longitude: -105.0 });
    await expect(
      socialGymDuplicateMutations.mergeGyms(
        null,
        { input: { canonicalGymUuid: gym.uuid, duplicateGymUuids: [gym.uuid] } },
        authCtx(ADMIN),
      ),
    ).rejects.toThrow();
  });

  it('rejects a SYSTEM canonical over a user-owned duplicate without the override, allows it with', async () => {
    // Admin inverted the pre-selection: SYSTEM row kept as survivor, user-owned
    // gym folded into it. Must be refused unless the override is explicit.
    const systemCanonical = await insertGym({
      ownerId: SYSTEM_OWNER,
      name: 'Invert Gym',
      latitude: 45.0,
      longitude: -105.0,
    });
    const userDuplicate = await insertGym({
      ownerId: GYM_OWNER,
      name: 'Invert Gym',
      latitude: 45.0001,
      longitude: -105.0,
    });

    await expect(
      socialGymDuplicateMutations.mergeGyms(
        null,
        { input: { canonicalGymUuid: systemCanonical.uuid, duplicateGymUuids: [userDuplicate.uuid] } },
        authCtx(ADMIN),
      ),
    ).rejects.toThrow(/override/i);

    // Same call with the explicit override succeeds.
    const result = await socialGymDuplicateMutations.mergeGyms(
      null,
      {
        input: {
          canonicalGymUuid: systemCanonical.uuid,
          duplicateGymUuids: [userDuplicate.uuid],
          allowSystemCanonicalOverride: true,
        },
      },
      authCtx(ADMIN),
    );
    expect(result.results).toHaveLength(1);
    const dupRow = await gymRow(userDuplicate.uuid);
    expect(Number(dupRow?.merged_into_gym_id)).toBe(systemCanonical.id);
  });
});

describe('orphanGyms', () => {
  it('lists alias-less system gyms and excludes gyms with a location-sync source', async () => {
    const orphan = await insertGym({ ownerId: SYSTEM_OWNER, name: 'Orphan Gym', latitude: 44.0, longitude: -105.0 });
    await insertBoard(orphan.id, SYSTEM_OWNER);
    const sourced = await insertGym({ ownerId: SYSTEM_OWNER, name: 'Sourced Gym', latitude: 44.1, longitude: -105.0 });
    await insertSource(sourced.id, 'tension:sourced-1');
    // A user-owned gym is never an orphan (orphans are system-owned).
    await insertGym({ ownerId: GYM_OWNER, name: 'User Gym', latitude: 44.2, longitude: -105.0 });

    const result = await socialGymDuplicateQueries.orphanGyms(null, { input: {} }, authCtx(ADMIN));
    expect(result.totalCount).toBe(1);
    expect(result.gyms).toHaveLength(1);
    expect(result.gyms[0].gymUuid).toBe(orphan.uuid);
    expect(result.gyms[0].boardCount).toBe(1);
  });
});
