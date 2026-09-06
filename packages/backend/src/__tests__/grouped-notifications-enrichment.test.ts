import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialNotificationQueries } from '../graphql/resolvers/social/notifications';

// #5192 QA: "I don't see the previews of the climbs in the notifications screen?
// Pressing a created climb notification doesn't open it in the drawer."
//
// Both symptoms share one input — the climb fields the grouped resolver hangs
// off `notifications.entity_id`. The sibling suite (`notifications.test.ts`)
// mocks the db entirely, so it proves the MAPPING and nothing about the SQL:
// a wrong column, a join that misses, or a type that arrives as a string all
// pass there. This one runs the resolver against real Postgres so the query
// itself is under test.
//
// FIXTURE_RUN_ID keeps rows unique across parallel workers sharing the worker
// DB — no TRUNCATE of shared tables, only scoped INSERT/DELETE by uuid prefix.

const FIXTURE_RUN_ID = crypto.randomUUID().slice(0, 8);
const RECIPIENT_ID = `gn5192-me-${FIXTURE_RUN_ID}`;
const SETTER_ID = `gn5192-setter-${FIXTURE_RUN_ID}`;
const CLIMB_UUID = `gn5192-climb-${FIXTURE_RUN_ID}`;
const CLIMB_FRAMES = 'p1080r12p1122r13';
const NEW_CLIMB_NOTIFICATION = `gn5192-n-climb-${FIXTURE_RUN_ID}`;
const TICK_UUID = `gn5192-tick-${FIXTURE_RUN_ID}`;
const TICK_COMMENT_NOTIFICATION = `gn5192-n-tick-${FIXTURE_RUN_ID}`;

function makeCtx(): ConnectionContext {
  return {
    connectionId: `gn5192-${FIXTURE_RUN_ID}`,
    isAuthenticated: true,
    userId: RECIPIENT_ID,
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

describe('groupedNotifications climb enrichment against real Postgres (#5192)', () => {
  beforeAll(async () => {
    await db.execute(sql`
      INSERT INTO users (id, email, name)
      VALUES
        (${RECIPIENT_ID}, ${`${RECIPIENT_ID}@test.invalid`}, 'Notification reader'),
        (${SETTER_ID}, ${`${SETTER_ID}@test.invalid`}, 'Climb setter')
      ON CONFLICT (id) DO NOTHING
    `);

    // A climb with everything a thumbnail needs. `compatible_size_ids` is the
    // column the row uses to pick a size on boards that number holds per size.
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, angle, setter_username, name, frames, compatible_size_ids, is_listed)
      VALUES (${CLIMB_UUID}, 'kilter', 8, 40, 'setter', 'QA preview climb', ${CLIMB_FRAMES}, ARRAY[17, 18]::int[], true)
      ON CONFLICT (uuid) DO NOTHING
    `);

    // An ascent on that climb, so a comment on it resolves through the tick.
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at)
      VALUES (${TICK_UUID}, ${RECIPIENT_ID}, 'kilter', ${CLIMB_UUID}, 40, 'send', now())
      ON CONFLICT (uuid) DO NOTHING
    `);

    // Exactly what handleClimbCreated and handleCommentCreated write.
    await db.execute(sql`
      INSERT INTO notifications (uuid, recipient_id, actor_id, type, entity_type, entity_id)
      VALUES
        (${NEW_CLIMB_NOTIFICATION}, ${RECIPIENT_ID}, ${SETTER_ID}, 'new_climb', 'climb', ${CLIMB_UUID}),
        (${TICK_COMMENT_NOTIFICATION}, ${RECIPIENT_ID}, ${SETTER_ID}, 'comment_on_tick', 'tick', ${TICK_UUID})
      ON CONFLICT (uuid) DO NOTHING
    `);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM notifications WHERE recipient_id = ${RECIPIENT_ID}`);
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE uuid = ${TICK_UUID}`);
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid = ${CLIMB_UUID}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${RECIPIENT_ID}, ${SETTER_ID})`);
  });

  it('hangs the climb off entity_id so the row can both draw and open', async () => {
    const { groups } = await socialNotificationQueries.groupedNotifications(null, {}, makeCtx());
    const group = groups.find((candidate) => candidate.type === 'new_climb');

    expect(group).toBeDefined();
    // Opening the climb needs these three; the QA report was that pressing did
    // nothing, which is exactly what a missing climbUuid or boardType looks like.
    expect(group!.climbUuid).toBe(CLIMB_UUID);
    expect(group!.boardType).toBe('kilter');
    expect(group!.climbLayoutId).toBe(8);
    // Drawing the board art needs these two.
    expect(group!.climbFrames).toBe(CLIMB_FRAMES);
    expect(group!.climbCompatibleSizeIds).toEqual([17, 18]);
  });

  it('carries the entity key the client marks read and re-queries by', async () => {
    // entityType/entityId are not decoration: the client sends them straight
    // back to markGroupNotificationsRead, and notificationActors matches on the
    // same triple. Undefined here marked the wrong group read (the query
    // matches entity_id IS NULL) and returned an empty actor list.
    const { groups } = await socialNotificationQueries.groupedNotifications(null, {}, makeCtx());
    const group = groups.find((candidate) => candidate.type === 'new_climb')!;

    expect(group.entityType).toBe('climb');
    expect(group.entityId).toBe(CLIMB_UUID);
  });

  it('resolves an ascent comment to its thread and its climb', async () => {
    // The whole point of the thread fields — a comment row that cannot name its
    // thread opens nothing when tapped.
    const { groups } = await socialNotificationQueries.groupedNotifications(null, {}, makeCtx());
    const group = groups.find((candidate) => candidate.type === 'comment_on_tick')!;

    expect(group.threadEntityType).toBe('tick');
    expect(group.threadEntityId).toBe(TICK_UUID);
    // And the tick walks to its climb, which is what lets the row draw art.
    expect(group.climbUuid).toBe(CLIMB_UUID);
    expect(group.climbFrames).toBe(CLIMB_FRAMES);
  });

  it('returns climbLayoutId as a number, not a string', async () => {
    // A layout arriving as "8" would pass the `!= null` guard, then fail
    // `toBoardName`-adjacent numeric use downstream and silently draw nothing.
    const { groups } = await socialNotificationQueries.groupedNotifications(null, {}, makeCtx());
    const group = groups.find((candidate) => candidate.type === 'new_climb')!;

    expect(typeof group.climbLayoutId).toBe('number');
    expect(typeof group.climbFrames).toBe('string');
    expect(Array.isArray(group.climbCompatibleSizeIds)).toBe(true);
  });
});
