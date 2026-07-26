import { describe, it, expect, afterAll } from 'vite-plus/test';
import { and, eq, like, sql } from 'drizzle-orm';

import { db } from '../db/client';
import { notifications } from '@boardsesh/db/schema';
import { createSetterSyncNotifications as createKilterSetterNotifications } from '@boardsesh/kilter-sync';
import { createSetterSyncNotifications as createAuroraSetterNotifications } from '@boardsesh/aurora-sync';

// ---------------------------------------------------------------------------
// Setter-notification dedup backstop (real DB) — #3539
//
// New-climb detection is a pre-read of which climb uuids already exist, run
// inside a transaction. Two board-wide syncs in flight at the same time both
// read before either commits, so both classify the same climbs as new and both
// insert a full set of "new climbs from <setter>" rows — followers got the same
// alert twice. `notifications_dedup_idx` is a plain index, so nothing stopped
// them.
//
// The backstop is a deterministic (uuid v5) notification uuid riding
// `notifications.uuid`, which is already NOT NULL UNIQUE, plus
// onConflictDoNothing. It needs no migration and no cleanup of historical rows
// (those carry random v4 uuids that can never collide with these).
//
// These call the REAL production functions from both sync packages rather than
// a re-expressed insert. Each test seeds its own followers and its own climb
// uuids so nothing is shared between them.
// ---------------------------------------------------------------------------

const FIXTURE_PREFIX = 'setter-dedup';
const noopLog = () => {};

let fixtureCounter = 0;

type Fixture = { setterUsername: string; followers: [string, string]; climbUuid: string; otherClimbUuid: string };

/** Seed a self-contained setter + two followers, inside the test that uses them. */
async function seedFixture(): Promise<Fixture> {
  const id = `${FIXTURE_PREFIX}-${++fixtureCounter}`;
  const followers: [string, string] = [`${id}-follower-1`, `${id}-follower-2`];

  for (const followerId of followers) {
    await db.execute(sql`
      INSERT INTO "users" (id, email, name, created_at, updated_at)
      VALUES (${followerId}, ${`${followerId}@test.com`}, ${followerId}, now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO "setter_follows" (follower_id, setter_username, created_at, updated_at)
      VALUES (${followerId}, ${`${id}-setter`}, now(), now())
      ON CONFLICT DO NOTHING
    `);
  }

  return {
    setterUsername: `${id}-setter`,
    followers,
    climbUuid: `${id}-climb-a`,
    otherClimbUuid: `${id}-climb-b`,
  };
}

async function countNotifications(entityId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`(count(*))::int` })
    .from(notifications)
    .where(and(eq(notifications.type, 'new_climbs_synced'), eq(notifications.entityId, entityId)));
  return Number(rows[0]?.total ?? 0);
}

describe('setter sync notification dedup (real DB)', () => {
  afterAll(async () => {
    await db.execute(sql`DELETE FROM "notifications" WHERE "recipient_id" LIKE ${`${FIXTURE_PREFIX}-%`}`);
    await db.execute(sql`DELETE FROM "setter_follows" WHERE "setter_username" LIKE ${`${FIXTURE_PREFIX}-%`}`);
    await db.execute(sql`DELETE FROM "users" WHERE "id" LIKE ${`${FIXTURE_PREFIX}-%`}`);
  });

  it('kilter: running the same catalog notification twice notifies each follower once', async () => {
    const fixture = await seedFixture();
    const newClimbs = [{ uuid: fixture.climbUuid, setterUsername: fixture.setterUsername, layoutId: 1, name: 'Test' }];

    await createKilterSetterNotifications(db, newClimbs, noopLog);
    expect(await countNotifications(fixture.climbUuid)).toBe(2);

    // The overlapping-instance replay: identical inputs, and the second run
    // lands zero new rows instead of a second full set.
    await createKilterSetterNotifications(db, newClimbs, noopLog);
    expect(await countNotifications(fixture.climbUuid)).toBe(2);
  });

  it('aurora: running the same shared-sync notification twice notifies each follower once', async () => {
    const fixture = await seedFixture();
    const newClimbs = [{ uuid: fixture.climbUuid, setterUsername: fixture.setterUsername, layoutId: 1, name: 'Test' }];

    await createAuroraSetterNotifications(db, 'tension', newClimbs, noopLog);
    expect(await countNotifications(fixture.climbUuid)).toBe(2);

    await createAuroraSetterNotifications(db, 'tension', newClimbs, noopLog);
    expect(await countNotifications(fixture.climbUuid)).toBe(2);
  });

  it('two genuinely concurrent runs still produce one notification per follower', async () => {
    const fixture = await seedFixture();
    const newClimbs = [{ uuid: fixture.climbUuid, setterUsername: fixture.setterUsername, layoutId: 1 }];

    // The real shape of the bug: both instances in flight at once, on separate
    // pool connections, neither having seen the other's rows.
    await Promise.all([
      createKilterSetterNotifications(db, newClimbs, noopLog),
      createKilterSetterNotifications(db, newClimbs, noopLog),
    ]);

    expect(await countNotifications(fixture.climbUuid)).toBe(2);
  });

  it('aurora and kilter agree on the uuid, so a board synced by both never double-notifies', async () => {
    const fixture = await seedFixture();
    const newClimbs = [{ uuid: fixture.climbUuid, setterUsername: fixture.setterUsername, layoutId: 1 }];

    await createKilterSetterNotifications(db, newClimbs, noopLog);
    await createAuroraSetterNotifications(db, 'tension', newClimbs, noopLog);

    expect(await countNotifications(fixture.climbUuid)).toBe(2);
  });

  it('a genuinely different batch still notifies', async () => {
    const fixture = await seedFixture();

    await createKilterSetterNotifications(
      db,
      [{ uuid: fixture.climbUuid, setterUsername: fixture.setterUsername, layoutId: 1 }],
      noopLog,
    );
    // Dedup must not swallow the setter's NEXT batch of climbs — the uuid is
    // keyed on the batch's head climb, so a new batch is a new notification.
    await createKilterSetterNotifications(
      db,
      [{ uuid: fixture.otherClimbUuid, setterUsername: fixture.setterUsername, layoutId: 1 }],
      noopLog,
    );

    expect(await countNotifications(fixture.climbUuid)).toBe(2);
    expect(await countNotifications(fixture.otherClimbUuid)).toBe(2);
  });

  it('each follower gets their own row (the uuid is per recipient, not per batch)', async () => {
    const fixture = await seedFixture();

    await createKilterSetterNotifications(
      db,
      [{ uuid: fixture.climbUuid, setterUsername: fixture.setterUsername, layoutId: 1 }],
      noopLog,
    );

    const recipients = await db
      .select({ recipientId: notifications.recipientId })
      .from(notifications)
      .where(and(eq(notifications.type, 'new_climbs_synced'), eq(notifications.entityId, fixture.climbUuid)));

    expect(new Set(recipients.map((row) => row.recipientId))).toEqual(new Set(fixture.followers));
  });

  it('leaves other notification types alone', async () => {
    const fixture = await seedFixture();

    // A different type sharing the same (actor, recipient, entity) tuple must
    // still be insertable — the dedup is scoped to new_climbs_synced by folding
    // the type into the uuid, not by a table-wide constraint.
    for (const uuid of ['other-type-1', 'other-type-2']) {
      await db.insert(notifications).values({
        uuid: `${fixture.followers[0]}-${uuid}`,
        recipientId: fixture.followers[0],
        actorId: null,
        type: 'new_climb',
        entityType: 'climb',
        entityId: fixture.climbUuid,
      });
    }

    const rows = await db
      .select({ total: sql<number>`(count(*))::int` })
      .from(notifications)
      .where(and(eq(notifications.type, 'new_climb'), like(notifications.recipientId, `${FIXTURE_PREFIX}-%`)));
    expect(Number(rows[0]?.total ?? 0)).toBe(2);
  });
});
