// A session card names the climbs sent in the session (owner decision,
// 2026-10-13: "a draft sent to a session or shown in climb history is fine").
// Sending a climb is the climber's activity, so the card applies the climber's
// account privacy and the wall rule, and no climb rule: a draft, someone else's
// unlisted climb and a climb the community hid are named like any other send.
// Real Postgres throughout.

import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { sessionFeedQueries } from '../graphql/resolvers/social/session-feed';
import { generateSessionSummary } from '../graphql/resolvers/sessions/session-summary';

const SETTER = 'card-names-setter';
const CLIMBER = 'card-names-climber';
const VIEWER = 'card-names-viewer';
const SESSION = '64550000-0000-4000-8000-000000000001';
const DRAFT = 'card-names-draft';
const UNLISTED = 'card-names-unlisted';
const HIDDEN = 'card-names-hidden';
const PUBLISHED = 'card-names-published';
const DRAFT_TICK = '64550000-0000-4000-8000-000000000002';
const UNLISTED_TICK = '64550000-0000-4000-8000-000000000003';
const HIDDEN_TICK = '64550000-0000-4000-8000-000000000004';
const PUBLIC_TICK = '64550000-0000-4000-8000-000000000005';
const context = (userId: string): ConnectionContext => ({ userId, isAuthenticated: true }) as ConnectionContext;

// Each climb is the setter's, not the climber's, and each is harder than the
// next, so the card's hardest send says which ones it may name.
beforeEach(async () => {
  await db.execute(sql`TRUNCATE board_sessions, boardsesh_ticks, board_climbs, board_climb_stats,
    board_climb_grades, board_beta_links, users RESTART IDENTITY CASCADE`);
  await db.execute(sql`INSERT INTO users (id, name, email) VALUES
    (${SETTER}, 'Setter', 'card-names-setter@example.test'),
    (${CLIMBER}, 'Climber', 'card-names-climber@example.test'),
    (${VIEWER}, 'Viewer', 'card-names-viewer@example.test')`);
  await db.execute(sql`INSERT INTO user_follows (follower_id, following_id) VALUES (${VIEWER}, ${CLIMBER})`);
  await db.execute(sql`INSERT INTO board_sessions (id, board_path, created_by_user_id, name, is_public, status)
    VALUES (${SESSION}, 'kilter/1/10/1,20/40', ${CLIMBER}, 'Public session', true, 'ended')`);
  await db.execute(sql`INSERT INTO board_climbs
    (uuid, board_type, layout_id, name, user_id, is_draft, is_listed, is_hidden, frames, frames_count)
    VALUES (${DRAFT}, 'kilter', 1, 'Sent draft', ${SETTER}, true, false, false, 'p1r12', 1),
      (${UNLISTED}, 'kilter', 1, 'Unlisted climb', ${SETTER}, false, false, false, 'p2r12', 1),
      (${HIDDEN}, 'kilter', 1, 'Hidden climb', ${SETTER}, false, true, true, 'p3r12', 1),
      (${PUBLISHED}, 'kilter', 1, 'Published climb', ${SETTER}, false, true, false, 'p4r12', 1)`);
  await db.execute(sql`INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty)
    VALUES ('kilter', ${DRAFT}, 40, 30), ('kilter', ${UNLISTED}, 40, 28), ('kilter', ${HIDDEN}, 40, 26),
      ('kilter', ${PUBLISHED}, 40, 20)`);
  await db.execute(sql`INSERT INTO boardsesh_ticks
    (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, difficulty, climbed_at, session_id)
    VALUES (${DRAFT_TICK}, ${CLIMBER}, 'kilter', ${DRAFT}, 40, 'send', 1, 30, '2026-10-01 11:00:00', ${SESSION}),
      (${UNLISTED_TICK}, ${CLIMBER}, 'kilter', ${UNLISTED}, 40, 'send', 1, 28, '2026-10-01 12:00:00', ${SESSION}),
      (${HIDDEN_TICK}, ${CLIMBER}, 'kilter', ${HIDDEN}, 40, 'send', 1, 26, '2026-10-01 13:00:00', ${SESSION}),
      (${PUBLIC_TICK}, ${CLIMBER}, 'kilter', ${PUBLISHED}, 40, 'send', 1, 20, '2026-10-01 10:00:00', ${SESSION})`);
});

const dropTicks = (...tickUuids: string[]) =>
  db.execute(
    sql`DELETE FROM boardsesh_ticks WHERE uuid IN ${sql`(${sql.join(
      tickUuids.map((uuid) => sql`${uuid}`),
      sql`, `,
    )})`}`,
  );

async function feedCardHardestSend(viewerId: string) {
  const feed = await sessionFeedQueries.sessionGroupedFeed(null, { input: { limit: 20 } }, context(viewerId));
  return feed.sessions.find((session) => session.sessionId === SESSION)?.hardestSend ?? null;
}

describe('the session feed card names the climbs sent in the session', () => {
  it('names a draft sent to the session, for the climber and for anyone who may see the session', async () => {
    for (const viewerId of [CLIMBER, VIEWER]) {
      expect(await feedCardHardestSend(viewerId)).toMatchObject({ climbUuid: DRAFT, climbName: 'Sent draft' });
    }
  });

  it("names the climber's own send on someone else's unlisted climb", async () => {
    await dropTicks(DRAFT_TICK);
    for (const viewerId of [CLIMBER, VIEWER]) {
      expect(await feedCardHardestSend(viewerId)).toMatchObject({ climbUuid: UNLISTED, climbName: 'Unlisted climb' });
    }
  });

  it('names a send on a climb the community hid', async () => {
    await dropTicks(DRAFT_TICK, UNLISTED_TICK);
    for (const viewerId of [CLIMBER, VIEWER]) {
      expect(await feedCardHardestSend(viewerId)).toMatchObject({ climbUuid: HIDDEN, climbName: 'Hidden climb' });
    }
  });

  it("features the clip on the climber's send on someone else's unlisted climb", async () => {
    const clip = 'https://www.instagram.com/p/card-names-unlisted-clip/';
    await db.execute(sql`INSERT INTO board_beta_links
      (board_type, climb_uuid, link, is_listed, tick_uuid, created_by_user_id, angle)
      VALUES ('kilter', ${UNLISTED}, ${clip}, true, ${UNLISTED_TICK}, ${CLIMBER}, 40)`);
    const feed = await sessionFeedQueries.sessionGroupedFeed(null, { input: { limit: 20 } }, context(CLIMBER));
    const featured = feed.sessions.find((session) => session.sessionId === SESSION)?.featuredBeta;
    expect(featured?.betaLink.link).toBe(clip);
    expect(featured?.tick).toMatchObject({ climbUuid: UNLISTED, climbName: 'Unlisted climb' });
  });
});

describe('the session summary names the climbs sent in the session', () => {
  it("names the climber's own hardest send on someone else's unlisted climb", async () => {
    await dropTicks(DRAFT_TICK);
    for (const viewerId of [CLIMBER, VIEWER]) {
      const summary = await generateSessionSummary(SESSION, viewerId);
      expect(summary?.hardestClimb).toMatchObject({ climbUuid: UNLISTED, climbName: 'Unlisted climb' });
    }
  });

  it('names a draft sent to the session', async () => {
    const summary = await generateSessionSummary(SESSION, CLIMBER);
    expect(summary?.hardestClimb).toMatchObject({ climbUuid: DRAFT, climbName: 'Sent draft' });
  });

  it('names a send on a climb the community hid', async () => {
    await dropTicks(DRAFT_TICK, UNLISTED_TICK);
    const summary = await generateSessionSummary(SESSION, VIEWER);
    expect(summary?.hardestClimb).toMatchObject({ climbUuid: HIDDEN, climbName: 'Hidden climb' });
  });
});
