import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { and, eq, inArray } from 'drizzle-orm';
import { communityRoles, gymMembers, gyms, userBoards, users } from '@boardsesh/db/schema';
import { db } from '../db/client';
import {
  managedGymPredicate,
  userCanAdminGym,
  userCanEditGym,
  userCanGrantGymAccess,
} from '../graphql/resolvers/social/gyms';

const actorKinds = [
  'owner',
  'admin',
  'editor',
  'member',
  'globalLeader',
  'globalAdmin',
  'scopedLeader',
  'wrongScope',
  'tester',
] as const;
type ActorKind = (typeof actorKinds)[number];
type GymRow = typeof gyms.$inferSelect;
type AccessVerdict = { edit: boolean; grant: boolean; admin: boolean };

let actors: Record<ActorKind, string>;
let fixtureUserIds: string[] = [];
let gymA: GymRow;
let gymB: GymRow;
let boardId: number;

beforeEach(async () => {
  const suffix = randomUUID();
  actors = Object.fromEntries(actorKinds.map((kind) => [kind, `gym-access-${kind}-${suffix}`])) as Record<
    ActorKind,
    string
  >;
  fixtureUserIds = Object.values(actors);
  await db.insert(users).values(fixtureUserIds.map((id) => ({ id, email: `${id}@example.test`, name: id })));
  const insertedGyms = await db
    .insert(gyms)
    .values([
      {
        uuid: randomUUID(),
        slug: `access-public-${suffix}`,
        name: 'Public gym',
        ownerId: actors.owner,
        isPublic: true,
      },
      {
        uuid: randomUUID(),
        slug: `access-private-${suffix}`,
        name: 'Private gym',
        ownerId: actors.owner,
        isPublic: false,
      },
    ])
    .returning();
  [gymA, gymB] = [insertedGyms[0]!, insertedGyms[1]!];
  await db
    .insert(gymMembers)
    .values(
      [gymA, gymB].flatMap((gym) =>
        (['admin', 'editor', 'member'] as const).map((role) => ({ gymId: gym.id, userId: actors[role], role })),
      ),
    );
  await db.insert(communityRoles).values([
    { userId: actors.globalLeader, role: 'community_leader', boardType: null },
    { userId: actors.globalAdmin, role: 'admin', boardType: null },
    { userId: actors.scopedLeader, role: 'community_leader', boardType: 'kilter' },
    { userId: actors.wrongScope, role: 'community_leader', boardType: 'tension' },
    { userId: actors.tester, role: 'tester', boardType: null },
  ]);
  const [board] = await db
    .insert(userBoards)
    .values({
      uuid: randomUUID(),
      slug: `access-board-${suffix}`,
      name: 'Last matching Kilter board',
      ownerId: actors.owner,
      gymId: gymA.id,
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1',
      isPublic: true,
    })
    .returning({ id: userBoards.id });
  boardId = board!.id;
});

afterEach(async () => {
  // Unique fixture owners cascade only this test's gyms, boards, and role rows.
  if (fixtureUserIds.length > 0) await db.delete(users).where(inArray(users.id, fixtureUserIds));
  fixtureUserIds = [];
});

async function listedGymIds(userId: string): Promise<number[]> {
  const listed = await db
    .select({ id: gyms.id })
    .from(gyms)
    .where(and(inArray(gyms.id, [gymA.id, gymB.id]), managedGymPredicate(userId, db)))
    .orderBy(gyms.id);
  return listed.map((gym) => gym.id);
}

async function accessVerdict(gym: GymRow, userId: string, lock = false): Promise<AccessVerdict> {
  if (!lock) {
    return {
      edit: await userCanEditGym(gym, userId),
      grant: await userCanGrantGymAccess(gym, userId),
      admin: await userCanAdminGym(gym, userId),
    };
  }
  return db.transaction(async (transaction) => {
    // Locking helpers require their caller to hold the canonical gym row first.
    const [lockedGym] = await transaction.select().from(gyms).where(eq(gyms.id, gym.id)).for('no key update');
    if (!lockedGym) throw new Error('Fixture gym disappeared');
    return {
      edit: await userCanEditGym(lockedGym, userId, transaction, { lock: true }),
      grant: await userCanGrantGymAccess(lockedGym, userId, transaction, { lock: true }),
      admin: await userCanAdminGym(lockedGym, userId, transaction, { lock: true }),
    };
  });
}

function expectedAccess(kind: ActorKind, gym: GymRow): AccessVerdict {
  const gymAdmin = kind === 'owner' || kind === 'admin';
  const communityAccess =
    kind === 'globalLeader' || kind === 'globalAdmin' || (kind === 'scopedLeader' && gym.id === gymA.id);
  return {
    edit: gymAdmin || communityAccess || kind === 'editor',
    grant: gymAdmin || communityAccess,
    admin: gymAdmin,
  };
}

async function expectScopedAccess(expectedGym: GymRow | null): Promise<void> {
  expect(await listedGymIds(actors.scopedLeader)).toEqual(expectedGym ? [expectedGym.id] : []);
  for (const gym of [gymA, gymB]) {
    const covered = gym.id === expectedGym?.id;
    const expected = { edit: covered, grant: covered, admin: false };
    expect(await accessVerdict(gym, actors.scopedLeader)).toEqual(expected);
    expect(await accessVerdict(gym, actors.scopedLeader, true)).toEqual(expected);
  }
}

describe('canonical gym access SQL and permission parity', () => {
  it('lists exactly the public and private gyms each role can edit', async () => {
    for (const kind of actorKinds) {
      const expectedIds = [gymA, gymB].filter((gym) => expectedAccess(kind, gym).edit).map((gym) => gym.id);
      const allowedIds: number[] = [];
      for (const gym of [gymA, gymB]) {
        if (await userCanEditGym(gym, actors[kind])) allowedIds.push(gym.id);
      }
      expect(await listedGymIds(actors[kind]), kind).toEqual(expectedIds);
      expect(allowedIds, kind).toEqual(expectedIds);
    }
  });

  it('keeps grant and admin authority distinct with the same verdict when evidence is locked', async () => {
    for (const kind of actorKinds) {
      for (const gym of [gymA, gymB]) {
        const expected = expectedAccess(kind, gym);
        expect(await accessVerdict(gym, actors[kind]), `${kind}: ${gym.name}`).toEqual(expected);
        expect(await accessVerdict(gym, actors[kind], true), `${kind} locked: ${gym.name}`).toEqual(expected);
      }
    }
  });

  it('moves scoped listing, edit, and grant authority with the last matching live board', async () => {
    await expectScopedAccess(gymA);
    await db.update(userBoards).set({ gymId: gymB.id }).where(eq(userBoards.id, boardId));
    await expectScopedAccess(gymB);
  });

  it('removes scoped listing, edit, and grant authority when the last matching board is deleted', async () => {
    await expectScopedAccess(gymA);
    await db.update(userBoards).set({ deletedAt: new Date() }).where(eq(userBoards.id, boardId));
    await expectScopedAccess(null);
  });

  it('lets an editor grant access only while its separate scoped leader authority covers the gym', async () => {
    await db
      .insert(gymMembers)
      .values([gymA, gymB].map((gym) => ({ gymId: gym.id, userId: actors.scopedLeader, role: 'editor' as const })));
    expect(await accessVerdict(gymA, actors.scopedLeader, true)).toEqual({ edit: true, grant: true, admin: false });
    expect(await accessVerdict(gymB, actors.scopedLeader, true)).toEqual({ edit: true, grant: false, admin: false });

    await db.update(userBoards).set({ gymId: gymB.id }).where(eq(userBoards.id, boardId));
    expect(await listedGymIds(actors.scopedLeader)).toEqual([gymA.id, gymB.id]);
    expect(await accessVerdict(gymA, actors.scopedLeader, true)).toEqual({ edit: true, grant: false, admin: false });
    expect(await accessVerdict(gymB, actors.scopedLeader, true)).toEqual({ edit: true, grant: true, admin: false });

    await db.update(userBoards).set({ deletedAt: new Date() }).where(eq(userBoards.id, boardId));
    expect(await listedGymIds(actors.scopedLeader)).toEqual([gymA.id, gymB.id]);
    for (const gym of [gymA, gymB]) {
      expect(await accessVerdict(gym, actors.scopedLeader, true)).toEqual({ edit: true, grant: false, admin: false });
    }
  });
});
