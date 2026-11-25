import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import type { DbTransaction } from '../db/after-commit';
import { socialGymMutations } from '../graphql/resolvers/social/gyms';
import { MAX_AUTO_MINTED_GYMS_PER_OWNER, type SimilarGymResult } from '../graphql/resolvers/social/gym-matching';
import {
  blockingSimilarGyms,
  GYM_CREATE_NAME_LOCK_NAMESPACE,
  GYM_CREATE_OWNER_LOCK_NAMESPACE,
} from '../graphql/resolvers/social/gym-create-guards';
import { MAX_ACKNOWLEDGED_GYM_UUIDS } from '../validation/schemas';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * Real-DB coverage for createGym's duplicate refusal and owner cap.
 *
 * Every create runs findSimilarGymCandidates as the caller. Absent (or
 * REJECT_IF_FOUND) refuses on any match with GYM_SIMILAR_EXISTS, carrying the
 * matches in the SimilarGym shape; CONFIRMED_SEPARATE passes only once every
 * current match is acknowledged. The create also stops at the 25-gym cap with
 * GYM_LIMIT_REACHED. The matching tiers themselves are covered in
 * find-similar-gyms-and-auto-gym.test.ts; this file pins what createGym does
 * with them.
 */

const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const CLIMBER = 'cgd-climber';
const OTHER = 'cgd-other';
const ALL_USERS = [SYSTEM_OWNER, CLIMBER, OTHER];

// Latitude offsets from the base point (111_320 m per degree of latitude).
const BASE = { latitude: 47.0, longitude: 8.0 };
const LAT_60M = 47.0 + 0.00054;
const LAT_2KM = 47.0 + 0.018;
const LAT_20KM = 47.0 + 0.18;

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;

const insertUser = (id: string) =>
  db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);

const insertGym = async (opts: {
  ownerId?: string;
  name: string;
  latitude?: number | null;
  longitude?: number | null;
  isPublic?: boolean;
  isListed?: boolean;
}): Promise<{ id: number; uuid: string }> => {
  const { ownerId = SYSTEM_OWNER, name, latitude = null, longitude = null, isPublic = true, isListed = true } = opts;
  const uuid = uuidv4();
  const [row] = await db
    .insert(dbSchema.gyms)
    .values({ uuid, slug: uuid, name, ownerId, latitude, longitude, isPublic, isListed })
    .returning({ id: dbSchema.gyms.id });
  return { id: row.id, uuid };
};

const liveGymsOwnedBy = async (ownerId: string): Promise<number> => {
  const [row] = await db
    .select({ total: count() })
    .from(dbSchema.gyms)
    .where(and(eq(dbSchema.gyms.ownerId, ownerId), isNull(dbSchema.gyms.deletedAt)));
  return row.total;
};

type CreatedGym = { uuid: string; name: string; slug: string | null };

const createGym = (input: Record<string, unknown>, userId: string = CLIMBER) =>
  socialGymMutations.createGym(null, { input }, authCtx(userId)) as Promise<CreatedGym>;

type SimilarGymsRefusal = { code: string; candidates: SimilarGymResult[] };

/** The GYM_SIMILAR_EXISTS extensions, or null when the create went through. Any other failure rethrows. */
async function captureSimilarGyms(promise: Promise<unknown>): Promise<SimilarGymsRefusal | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    const extensions = (error as { extensions?: Record<string, unknown> }).extensions;
    if (extensions?.code === 'GYM_SIMILAR_EXISTS') return extensions as SimilarGymsRefusal;
    throw error;
  }
}

const candidateUuids = (refusal: SimilarGymsRefusal | null) => refusal?.candidates.map((gym) => gym.uuid) ?? null;

const insertCappedGyms = async (ownerId: string, howMany: number) => {
  for (let index = 0; index < howMany; index++) {
    await insertGym({ ownerId, name: `Capped Gym ${index}` });
  }
};

// ---- Forcing an interleaving ----
//
// A held transaction takes a lock (and writes a competing row) and stays open.
// The create under test then queues behind it, which `waitUntilQueued` sees in
// pg_locks, and only then does the holder commit. Without the lock under test
// the create never queues, so `waitUntilQueued` fails with "finished before it
// queued", and its read would miss the uncommitted competitor anyway.

const openHolders: Array<() => Promise<void>> = [];

/** Runs `work` in a transaction left open until the returned commit runs. */
async function holdTransaction(work: (transaction: DbTransaction) => Promise<void>): Promise<() => Promise<void>> {
  let releaseHolder: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const finished = db.transaction(async (transaction) => {
    await work(transaction);
    markReady();
    await released;
  });
  await Promise.race([ready, finished]);
  const commit = async () => {
    releaseHolder();
    await finished;
  };
  openHolders.push(commit);
  return commit;
}

/** Resolves once `waiters` sessions in this database wait on a lock of `lockType`; throws if `operation` settles first. */
async function waitUntilQueued(operation: Promise<unknown>, lockType: 'advisory' | 'transactionid', waiters = 1) {
  let settled = false;
  operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (settled) throw new Error('The create finished before it queued behind the held lock');
    const result = await db.execute(sql`
      SELECT count(*)::int AS waiting FROM pg_locks
      WHERE locktype = ${lockType} AND NOT granted
        AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname = current_database())
    `);
    const [{ waiting }] = Array.from(result as Iterable<{ waiting: number }>);
    if (waiting >= waiters) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The create never queued behind the held lock');
}

const takeNameLock = (transaction: DbTransaction, normalizedName: string) =>
  transaction.execute(
    sql`SELECT pg_advisory_xact_lock(${GYM_CREATE_NAME_LOCK_NAMESPACE}::int, hashtext(${normalizedName}))`,
  );

const takeOwnerLock = (transaction: DbTransaction, ownerId: string) =>
  transaction.execute(sql`SELECT pg_advisory_xact_lock(${GYM_CREATE_OWNER_LOCK_NAMESPACE}::int, hashtext(${ownerId}))`);

const errorCode = (reason: unknown) => (reason as { extensions?: { code?: string } }).extensions?.code;

// The test schema (schema-sql.ts) declares `gyms` without production's partial
// unique slug index (migration 0054), so on the test DB two live gyms can share
// a slug and createGym's slug retry has nothing to catch. This file adds the
// index, under its production name, and drops it again only if it added it.
let addedSlugIndex = false;

beforeAll(async () => {
  const existing = await db.execute(sql`SELECT 1 FROM pg_indexes WHERE indexname = 'gyms_unique_slug'`);
  if (Array.from(existing as Iterable<unknown>).length > 0) return;
  // Earlier files may have left gyms behind, duplicate slugs included.
  await db.execute(sql`TRUNCATE TABLE "gyms" RESTART IDENTITY CASCADE`);
  await db.execute(
    sql`CREATE UNIQUE INDEX "gyms_unique_slug" ON "gyms" USING btree ("slug") WHERE "gyms"."deleted_at" IS NULL`,
  );
  addedSlugIndex = true;
});

afterAll(async () => {
  if (addedSlugIndex) await db.execute(sql`DROP INDEX IF EXISTS "gyms_unique_slug"`);
});

beforeEach(async () => {
  resetAllRateLimits();
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_members", "gym_follows", "gym_claims", "gym_owner_reassignments",
      "location_sync_gym_sources", "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await Promise.all(ALL_USERS.map(insertUser));
});

afterEach(async () => {
  // A test that failed mid-way must not leave a transaction holding locks.
  await Promise.allSettled(openHolders.splice(0).map((commit) => commit()));
});

describe('createGym duplicate refusal', () => {
  it('refuses with the similar gyms in the SimilarGym shape when the check is absent', async () => {
    const listed = await insertGym({ name: 'Bahnhof Bloc', latitude: LAT_2KM, longitude: BASE.longitude });

    const refusal = await captureSimilarGyms(
      createGym({ name: 'Bahnhof Bloc', latitude: BASE.latitude, longitude: BASE.longitude }),
    );

    expect(refusal).toEqual({
      code: 'GYM_SIMILAR_EXISTS',
      candidates: [
        {
          uuid: listed.uuid,
          slug: listed.uuid,
          name: 'Bahnhof Bloc',
          address: null,
          website: null,
          distanceMeters: expect.any(Number),
          ownerType: 'SYSTEM',
          isClaimable: true,
          canClaimByDomain: false,
          providerOrigins: [],
        },
      ],
    });
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(0);
  });

  it('refuses under an explicit REJECT_IF_FOUND even with acknowledged gyms', async () => {
    const listed = await insertGym({ name: 'Random Wall', latitude: LAT_60M, longitude: BASE.longitude });

    const refusal = await captureSimilarGyms(
      createGym({
        name: 'Totally Different',
        latitude: BASE.latitude,
        longitude: BASE.longitude,
        duplicateCheck: { mode: 'REJECT_IF_FOUND', acknowledgedGymUuids: [listed.uuid] },
      }),
    );

    // Any name within 150 m counts.
    expect(candidateUuids(refusal)).toEqual([listed.uuid]);
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(0);
  });

  it('creates once every similar gym is acknowledged as separate', async () => {
    const near = await insertGym({ name: 'Random Wall', latitude: LAT_60M, longitude: BASE.longitude });
    const sameName = await insertGym({ name: 'Bahnhof Bloc', latitude: LAT_2KM, longitude: BASE.longitude });

    const created = await createGym({
      name: 'Bahnhof Bloc',
      latitude: BASE.latitude,
      longitude: BASE.longitude,
      duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: [sameName.uuid, near.uuid] },
    });

    expect(created.name).toBe('Bahnhof Bloc');
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(1);
  });

  it('refuses again with only the gyms a partial confirmation left out', async () => {
    const near = await insertGym({ name: 'Random Wall', latitude: LAT_60M, longitude: BASE.longitude });
    const sameName = await insertGym({ name: 'Bahnhof Bloc', latitude: LAT_2KM, longitude: BASE.longitude });

    const refusal = await captureSimilarGyms(
      createGym({
        name: 'Bahnhof Bloc',
        latitude: BASE.latitude,
        longitude: BASE.longitude,
        duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: [near.uuid] },
      }),
    );

    expect(candidateUuids(refusal)).toEqual([sameName.uuid]);
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(0);
  });

  it('treats a confirmation with no acknowledged gyms as a refusal when any exist', async () => {
    const listed = await insertGym({ name: 'Bahnhof Bloc' });

    for (const acknowledgedGymUuids of [undefined, [], [uuidv4()]]) {
      const refusal = await captureSimilarGyms(
        createGym({ name: 'Bahnhof Bloc', duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids } }),
      );
      expect(candidateUuids(refusal)).toEqual([listed.uuid]);
    }
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(0);
  });

  it('creates without a check field when nothing similar is listed', async () => {
    await insertGym({ name: 'Bahnhof Bloc', latitude: LAT_20KM, longitude: BASE.longitude });

    const created = await createGym({ name: 'Kletterhalle Nord', latitude: BASE.latitude, longitude: BASE.longitude });

    expect(created.name).toBe('Kletterhalle Nord');
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(1);
  });

  it('matches on name alone when no coordinates are sent, wherever the listing is', async () => {
    const exact = await insertGym({ name: 'Bahnhof Bloc', latitude: LAT_20KM, longitude: BASE.longitude });
    const substring = await insertGym({ name: 'Bahnhof Bloc Annex' });
    await insertGym({ name: 'Unrelated Gym', latitude: BASE.latitude, longitude: BASE.longitude });

    const refusal = await captureSimilarGyms(createGym({ name: 'Bahnhof Bloc' }));

    // Exact name first, then the substring match; the unrelated gym at the
    // base point never counts without coordinates to measure from.
    expect(candidateUuids(refusal)).toEqual([exact.uuid, substring.uuid]);
    expect(refusal?.candidates.every((gym) => gym.distanceMeters === null)).toBe(true);
  });

  it("never refuses over another climber's private or unlisted gym", async () => {
    await insertGym({ ownerId: OTHER, name: 'Bahnhof Bloc', isPublic: false });
    await insertGym({ ownerId: OTHER, name: 'Bahnhof Bloc', isListed: false });

    const created = await createGym({ name: 'Bahnhof Bloc' });

    expect(created.name).toBe('Bahnhof Bloc');
  });

  it("refuses over the caller's own private gym", async () => {
    const own = await insertGym({ ownerId: CLIMBER, name: 'Garage Wall', isPublic: false });

    const refusal = await captureSimilarGyms(createGym({ name: 'Garage Wall' }));

    expect(candidateUuids(refusal)).toEqual([own.uuid]);
    expect(refusal?.candidates[0]).toMatchObject({ ownerType: 'USER', isClaimable: false });
  });

  it('names at most five gyms a refusal, and the next ones once those are acknowledged', async () => {
    const listed: string[] = [];
    for (let index = 0; index < 7; index++) {
      const gym = await insertGym({
        name: `Wall ${index}`,
        latitude: BASE.latitude + index * 0.0001, // ~11 m apart, all within 150 m
        longitude: BASE.longitude,
      });
      listed.push(gym.uuid);
    }

    const first = await captureSimilarGyms(
      createGym({ name: 'Kletterhalle Nord', latitude: BASE.latitude, longitude: BASE.longitude }),
    );
    expect(candidateUuids(first)).toEqual(listed.slice(0, 5));

    const second = await captureSimilarGyms(
      createGym({
        name: 'Kletterhalle Nord',
        latitude: BASE.latitude,
        longitude: BASE.longitude,
        duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: listed.slice(0, 5) },
      }),
    );
    expect(candidateUuids(second)).toEqual(listed.slice(5));

    await createGym({
      name: 'Kletterhalle Nord',
      latitude: BASE.latitude,
      longitude: BASE.longitude,
      duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: listed },
    });
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(1);
  });

  it('lets only one of two simultaneous creates of the same gym by one climber through', async () => {
    const results = await Promise.allSettled([
      createGym({ name: 'Bahnhof Bloc', latitude: BASE.latitude, longitude: BASE.longitude }),
      createGym({ name: 'Bahnhof Bloc', latitude: BASE.latitude, longitude: BASE.longitude }),
    ]);

    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as { extensions?: { code?: string } }).extensions?.code).toBe('GYM_SIMILAR_EXISTS');
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(1);
  });

  it('waits on the name lock, so a climber adding the same name just after another is refused', async () => {
    const competitorUuid = uuidv4();
    const commitCompetitor = await holdTransaction(async (transaction) => {
      await takeNameLock(transaction, 'bahnhof bloc');
      await transaction.insert(dbSchema.gyms).values({
        uuid: competitorUuid,
        slug: competitorUuid,
        name: 'Bahnhof Bloc',
        ownerId: OTHER,
        latitude: BASE.latitude,
        longitude: BASE.longitude,
      });
    });

    // Another owner, so only the name lock can make this create wait.
    const creating = createGym({ name: '  bahnhof   bloc ', latitude: LAT_60M, longitude: BASE.longitude });
    await waitUntilQueued(creating, 'advisory');
    await commitCompetitor();

    expect(candidateUuids(await captureSimilarGyms(creating))).toEqual([competitorUuid]);
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(0);
  });

  it('retries once with the next slug when a concurrent create takes it first', async () => {
    // A different name with the same slug, private and another owner's, so
    // neither create lock nor the similar-gym check is shared: only the
    // unique slug index meets the two.
    const commitCompetitor = await holdTransaction(async (transaction) => {
      await transaction.insert(dbSchema.gyms).values({
        uuid: uuidv4(),
        slug: 'rock-hall',
        name: 'Rock-Hall!',
        ownerId: OTHER,
        isPublic: false,
      });
    });

    // Reads "rock-hall" as free (the competitor is uncommitted), then its
    // insert waits on the competitor's unique-index entry.
    const creating = createGym({ name: 'Rock Hall' });
    await waitUntilQueued(creating, 'transactionid');
    await commitCompetitor();

    const created = await creating;
    expect(created.slug).toBe('rock-hall-2');
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(1);
  });
});

describe('createGym name and cap', () => {
  it('stores the name trimmed and slugs it from the trimmed name', async () => {
    const created = await createGym({ name: '   Kletterhalle Nord  ' });

    expect(created.name).toBe('Kletterhalle Nord');
    expect(created.slug).toBe('kletterhalle-nord');
  });

  it('refuses a name that is only whitespace', async () => {
    await expect(createGym({ name: '    ' })).rejects.toThrow('Gym name cannot be empty');
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(0);
  });

  it('refuses with GYM_LIMIT_REACHED once the caller owns the cap, before any duplicate check', async () => {
    await insertCappedGyms(CLIMBER, MAX_AUTO_MINTED_GYMS_PER_OWNER);

    await expect(createGym({ name: 'Kletterhalle Nord' })).rejects.toMatchObject({
      extensions: { code: 'GYM_LIMIT_REACHED', maxGyms: MAX_AUTO_MINTED_GYMS_PER_OWNER },
    });
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(MAX_AUTO_MINTED_GYMS_PER_OWNER);
  });

  it('does not count deleted gyms against the cap', async () => {
    await insertCappedGyms(CLIMBER, MAX_AUTO_MINTED_GYMS_PER_OWNER);
    await db.update(dbSchema.gyms).set({ deletedAt: new Date() }).where(eq(dbSchema.gyms.name, 'Capped Gym 0'));

    const created = await createGym({ name: 'Kletterhalle Nord' });

    expect(created.name).toBe('Kletterhalle Nord');
  });

  it('counts only gyms the owner listed, not ones they run through a claim or a handover', async () => {
    await insertCappedGyms(CLIMBER, MAX_AUTO_MINTED_GYMS_PER_OWNER - 1);
    const claimed = await insertGym({ ownerId: CLIMBER, name: 'Claimed Gym' });
    await db
      .insert(dbSchema.gymClaims)
      .values({ gymId: claimed.id, claimantUserId: CLIMBER, method: 'admin', status: 'approved' });
    const handedOver = await insertGym({ ownerId: CLIMBER, name: 'Handed Over Gym' });
    await db.insert(dbSchema.gymOwnerReassignments).values({
      gymUuid: handedOver.uuid,
      previousOwnerId: SYSTEM_OWNER,
      newOwnerId: CLIMBER,
      reason: 'Gym staff asked for it',
      performedBy: OTHER,
    });

    // 24 listed: the 25th listing goes through, the 26th does not.
    await createGym({ name: 'Kletterhalle Nord' });
    await expect(createGym({ name: 'Boulderwerk' })).rejects.toMatchObject({
      extensions: { code: 'GYM_LIMIT_REACHED' },
    });
  });

  it('counts a gym whose claim is still pending', async () => {
    await insertCappedGyms(CLIMBER, MAX_AUTO_MINTED_GYMS_PER_OWNER - 1);
    const pending = await insertGym({ ownerId: CLIMBER, name: 'Pending Gym' });
    await db
      .insert(dbSchema.gymClaims)
      .values({ gymId: pending.id, claimantUserId: CLIMBER, method: 'admin', status: 'pending' });

    await expect(createGym({ name: 'Kletterhalle Nord' })).rejects.toMatchObject({
      extensions: { code: 'GYM_LIMIT_REACHED' },
    });
  });

  it('exempts global admins, not admins scoped to one board type', async () => {
    await insertCappedGyms(CLIMBER, MAX_AUTO_MINTED_GYMS_PER_OWNER);
    await insertCappedGyms(OTHER, MAX_AUTO_MINTED_GYMS_PER_OWNER);
    await db.insert(dbSchema.communityRoles).values([
      { userId: CLIMBER, role: 'admin', boardType: null },
      { userId: OTHER, role: 'admin', boardType: 'kilter' },
    ]);

    expect((await createGym({ name: 'Kletterhalle Nord' })).name).toBe('Kletterhalle Nord');
    await expect(createGym({ name: 'Boulderwerk' }, OTHER)).rejects.toMatchObject({
      extensions: { code: 'GYM_LIMIT_REACHED' },
    });
  });

  it('waits on the owner lock, so a create racing the 25th listing is refused at the cap', async () => {
    await insertCappedGyms(CLIMBER, MAX_AUTO_MINTED_GYMS_PER_OWNER - 1);
    // The 25th listing, mid-flight under the owner lock, under another name so
    // only the owner lock can make the create below wait.
    const commitTwentyFifth = await holdTransaction(async (transaction) => {
      await takeOwnerLock(transaction, CLIMBER);
      const twentyFifthUuid = uuidv4();
      await transaction
        .insert(dbSchema.gyms)
        .values({ uuid: twentyFifthUuid, slug: twentyFifthUuid, name: 'Alpha Gym', ownerId: CLIMBER });
    });

    const creating = createGym({ name: 'Beta Gym' });
    await waitUntilQueued(creating, 'advisory');
    await commitTwentyFifth();

    await expect(creating).rejects.toMatchObject({ extensions: { code: 'GYM_LIMIT_REACHED' } });
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(MAX_AUTO_MINTED_GYMS_PER_OWNER);
  });

  it('lets one of two concurrent creates by an owner at 24 listings through, under different names', async () => {
    await insertCappedGyms(CLIMBER, MAX_AUTO_MINTED_GYMS_PER_OWNER - 1);

    const results = await Promise.allSettled([createGym({ name: 'Alpha Gym' }), createGym({ name: 'Beta Gym' })]);

    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected.map((result) => errorCode(result.reason))).toEqual(['GYM_LIMIT_REACHED']);
    expect(await liveGymsOwnedBy(CLIMBER)).toBe(MAX_AUTO_MINTED_GYMS_PER_OWNER);
  });
});

describe('createGym acknowledgement limits', () => {
  it(`accepts ${MAX_ACKNOWLEDGED_GYM_UUIDS} acknowledged gyms and refuses one more`, async () => {
    const acknowledged = Array.from({ length: MAX_ACKNOWLEDGED_GYM_UUIDS }, () => uuidv4());

    await createGym({
      name: 'Kletterhalle Nord',
      duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: acknowledged },
    });
    await expect(
      createGym({
        name: 'Boulderwerk',
        duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: [...acknowledged, uuidv4()] },
      }),
    ).rejects.toThrow(`At most ${MAX_ACKNOWLEDGED_GYM_UUIDS} acknowledged gyms`);
  });

  it('finds an exact name even when more than 50 listings match by substring and sort ahead of it', async () => {
    // Inserted first, and alphabetically before the exact name, so only an
    // exact-first ORDER BY keeps the exact listing inside the 50 rows read.
    for (let index = 0; index < 55; index++) {
      await insertGym({ name: `A Bahnhof Bloc ${String(index).padStart(2, '0')}` });
    }
    const exact = await insertGym({ name: 'Bahnhof Bloc' });

    const refusal = await captureSimilarGyms(createGym({ name: 'Bahnhof Bloc' }));

    expect(refusal?.candidates[0]?.uuid).toBe(exact.uuid);
  });
});

describe('blockingSimilarGyms', () => {
  const gym = (uuid: string) => ({
    id: 1,
    uuid,
    slug: null,
    name: uuid,
    address: null,
    website: null,
    websiteVouchedByOwner: false,
    ownerId: SYSTEM_OWNER,
    latitude: null,
    longitude: null,
    distanceMeters: null,
  });

  it('blocks on every match under REJECT_IF_FOUND, and keeps the order', () => {
    expect(blockingSimilarGyms([gym('b'), gym('a')], 'REJECT_IF_FOUND', ['a', 'b']).map((match) => match.uuid)).toEqual(
      ['b', 'a'],
    );
  });

  it('blocks only on unacknowledged matches under CONFIRMED_SEPARATE', () => {
    expect(blockingSimilarGyms([gym('a'), gym('b')], 'CONFIRMED_SEPARATE', ['a']).map((match) => match.uuid)).toEqual([
      'b',
    ]);
    expect(blockingSimilarGyms([gym('a')], 'CONFIRMED_SEPARATE', [])).toHaveLength(1);
    expect(blockingSimilarGyms([], 'REJECT_IF_FOUND', [])).toEqual([]);
  });
});
