import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { sessionFeedQueries } from '../graphql/resolvers/social/session-feed';

const SETTER = 'draft-highlight-setter';
const CLIMBER = 'draft-highlight-climber';
const VIEWER = 'draft-highlight-viewer';
const SESSION = '63390000-0000-4000-8000-000000000001';
const DRAFT = 'draft-highlight-private';
const PUBLISHED = 'draft-highlight-public';
const DRAFT_TICK = '63390000-0000-4000-8000-000000000002';
const PUBLIC_TICK = '63390000-0000-4000-8000-000000000003';
const context = (userId: string): ConnectionContext => ({ userId, isAuthenticated: true }) as ConnectionContext;

beforeEach(async () => {
  await db.execute(sql`TRUNCATE board_sessions, boardsesh_ticks, board_climbs, board_climb_stats,
    board_climb_grades, users RESTART IDENTITY CASCADE`);
  await db.execute(sql`INSERT INTO users (id, name, email) VALUES
    (${SETTER}, 'Setter', 'draft-highlight-setter@example.test'),
    (${CLIMBER}, 'Climber', 'draft-highlight-climber@example.test'),
    (${VIEWER}, 'Viewer', 'draft-highlight-viewer@example.test')`);
  await db.execute(sql`INSERT INTO user_follows (follower_id, following_id) VALUES (${VIEWER}, ${CLIMBER})`);
  await db.execute(sql`INSERT INTO board_sessions (id, board_path, created_by_user_id, name, is_public, status)
    VALUES (${SESSION}, 'kilter/1/10/1,20/40', ${CLIMBER}, 'Public session', true, 'ended')`);
  await db.execute(sql`INSERT INTO board_climbs
    (uuid, board_type, layout_id, name, user_id, is_draft, is_listed, frames, frames_count)
    VALUES (${DRAFT}, 'kilter', 1, 'Private draft', ${SETTER}, true, false, 'p1r12', 1),
      (${PUBLISHED}, 'kilter', 1, 'Published climb', ${SETTER}, false, true, 'p1r12', 1)`);
  await db.execute(sql`INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty)
    VALUES ('kilter', ${DRAFT}, 40, 30), ('kilter', ${PUBLISHED}, 40, 20)`);
  await db.execute(sql`INSERT INTO board_climb_grades
    (board_type, climb_uuid, angle, local_grade, universal_grade, grade_low, grade_high, confidence,
     ascensionist_count, model_version, coeff_version)
    VALUES ('kilter', ${DRAFT}, 40, 30, 31, 29, 32, 'confirmed', 12, 'test', 'test')`);
  await db.execute(sql`INSERT INTO boardsesh_ticks
    (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, difficulty, climbed_at, session_id)
    VALUES (${DRAFT_TICK}, ${CLIMBER}, 'kilter', ${DRAFT}, 40, 'send', 1, NULL, '2026-10-01 11:00:00', ${SESSION}),
      (${PUBLIC_TICK}, ${CLIMBER}, 'kilter', ${PUBLISHED}, 40, 'send', 1, 20, '2026-10-01 10:00:00', ${SESSION})`);
});

describe('a feed card never features another setter’s draft', () => {
  it('does not rank daily highlights or fill grade buckets from a foreign draft', async () => {
    await db.execute(sql`UPDATE boardsesh_ticks SET session_id = NULL
      WHERE uuid IN (${DRAFT_TICK}, ${PUBLIC_TICK})`);
    const feed = await sessionFeedQueries.sessionGroupedFeed(
      null,
      { input: { limit: 20, followingOnly: true, includeDailyHighlights: true } },
      context(VIEWER),
    );
    const daily = feed.sessions.find((session) => session.sessionType === 'daily_highlight');
    expect(daily?.hardestSend?.climbUuid).toBe(PUBLISHED);
    expect(daily?.gradeDistribution).toHaveLength(1);
    expect(daily?.gradeDistribution[0].send).toBe(1);
  });

  it('picks the hardest readable climb instead of an inaccessible harder draft', async () => {
    const feed = await sessionFeedQueries.sessionGroupedFeed(null, { input: { limit: 20 } }, context(CLIMBER));
    const party = feed.sessions.find((session) => session.sessionId === SESSION);
    expect(party?.hardestSend?.climbUuid).toBe(PUBLISHED);
    // The session's grade buckets count every send in it, a draft's included:
    // a draft sent in a session is the climber's activity (owner decision,
    // 2026-10-13). Only the featured hardest send follows the climb rule.
    expect(party?.gradeDistribution).toHaveLength(2);
  });

  it('keeps a logged send before its catalog climb arrives', async () => {
    await db.execute(sql`INSERT INTO boardsesh_ticks
      (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, difficulty, climbed_at, session_id)
      VALUES ('63390000-0000-4000-8000-000000000004', ${CLIMBER}, 'kilter', 'catalog-not-arrived',
        40, 'send', 1, 24, '2026-10-01 12:00:00', ${SESSION})`);
    const feed = await sessionFeedQueries.sessionGroupedFeed(null, { input: { limit: 20 } }, context(CLIMBER));
    expect(feed.sessions.find((session) => session.sessionId === SESSION)?.hardestSend).toMatchObject({
      climbUuid: 'catalog-not-arrived',
      climbName: null,
      difficulty: 24,
      boardseshDifficulty: null,
    });
  });

  it('keeps the draft grades and hardest send available to its setter', async () => {
    const detail = await sessionFeedQueries.sessionDetail(null, { sessionId: SESSION }, context(SETTER));
    expect(detail?.ticks.find((tick) => tick.uuid === DRAFT_TICK)).toMatchObject({
      climbName: 'Private draft',
      difficulty: 30,
      boardseshDifficulty: 31,
    });
    const feed = await sessionFeedQueries.sessionGroupedFeed(null, { input: { limit: 20 } }, context(SETTER));
    expect(feed.sessions.find((session) => session.sessionId === SESSION)?.hardestSend?.climbUuid).toBe(DRAFT);
  });
});

describe('a feed card never features an unlisted or community-hidden climb', () => {
  const UNLISTED = 'draft-highlight-unlisted';
  const HIDDEN = 'draft-highlight-hidden';
  const UNLISTED_TICK = '63390000-0000-4000-8000-000000000005';
  const HIDDEN_TICK = '63390000-0000-4000-8000-000000000006';

  // Both harder than the published climb, so a leak would be the one featured.
  beforeEach(async () => {
    await db.execute(sql`INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, user_id, is_draft, is_listed, is_hidden, frames, frames_count)
      VALUES (${UNLISTED}, 'kilter', 1, 'Unlisted climb', ${SETTER}, false, false, false, 'p2r12', 1),
        (${HIDDEN}, 'kilter', 1, 'Hidden climb', ${SETTER}, false, true, true, 'p3r12', 1)`);
    await db.execute(sql`INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty)
      VALUES ('kilter', ${UNLISTED}, 40, 28), ('kilter', ${HIDDEN}, 40, 26)`);
    await db.execute(sql`INSERT INTO boardsesh_ticks
      (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, difficulty, climbed_at, session_id)
      VALUES (${UNLISTED_TICK}, ${CLIMBER}, 'kilter', ${UNLISTED}, 40, 'send', 1, 28, '2026-10-01 12:00:00', ${SESSION}),
        (${HIDDEN_TICK}, ${CLIMBER}, 'kilter', ${HIDDEN}, 40, 'send', 1, 26, '2026-10-01 13:00:00', ${SESSION})`);
  });

  it('features the hardest published, listed climb on a session card a stranger sees', async () => {
    const feed = await sessionFeedQueries.sessionGroupedFeed(null, { input: { limit: 20 } }, context(VIEWER));
    const party = feed.sessions.find((session) => session.sessionId === SESSION);
    expect(party?.hardestSend).toMatchObject({ climbUuid: PUBLISHED, climbName: 'Published climb' });
  });

  it('features the unlisted climb to its setter, and the hidden climb to no one', async () => {
    const feed = await sessionFeedQueries.sessionGroupedFeed(null, { input: { limit: 20 } }, context(SETTER));
    expect(feed.sessions.find((session) => session.sessionId === SESSION)?.hardestSend?.climbUuid).toBe(DRAFT);
    await db.execute(sql`UPDATE board_climbs SET is_draft = false, is_listed = true WHERE uuid = ${DRAFT}`);
    await db.execute(sql`UPDATE board_climb_stats SET display_difficulty = 10 WHERE climb_uuid = ${DRAFT}`);
    const again = await sessionFeedQueries.sessionGroupedFeed(null, { input: { limit: 20 } }, context(SETTER));
    expect(again.sessions.find((session) => session.sessionId === SESSION)?.hardestSend?.climbUuid).toBe(UNLISTED);
  });

  it('does not feature a hidden climb on a daily card while the day has another send', async () => {
    await db.execute(sql`UPDATE boardsesh_ticks SET session_id = NULL`);
    const feed = await sessionFeedQueries.sessionGroupedFeed(
      null,
      { input: { limit: 20, followingOnly: true, includeDailyHighlights: true } },
      context(VIEWER),
    );
    const daily = feed.sessions.find((session) => session.sessionType === 'daily_highlight');
    // The unlisted climb's log is not the viewer's to read at all; the hidden
    // one's is, but it is never the featured send.
    expect(daily?.hardestSend).toMatchObject({ climbUuid: PUBLISHED, climbName: 'Published climb' });
  });

  it('names no hidden climb on a daily card whose only send is on it', async () => {
    await db.execute(sql`UPDATE boardsesh_ticks SET session_id = NULL`);
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE uuid <> ${HIDDEN_TICK}`);
    const feed = await sessionFeedQueries.sessionGroupedFeed(
      null,
      { input: { limit: 20, followingOnly: true, includeDailyHighlights: true } },
      context(VIEWER),
    );
    const daily = feed.sessions.find((session) => session.sessionType === 'daily_highlight');
    expect(daily?.hardestSend?.climbName ?? null).toBeNull();
    expect(daily?.hardestSend?.frames ?? null).toBeNull();
  });

  describe("the card's featured beta clip", () => {
    const clipFor = (climbUuid: string) => `https://www.instagram.com/p/${climbUuid}-clip/`;
    const PUBLIC_CLIP = clipFor(PUBLISHED);

    /** A listed clip attached to `tick`, on `climbUuid`, posted by the climber who sent it. */
    const attachClip = (tickUuid: string, climbUuid: string) =>
      db.execute(sql`INSERT INTO board_beta_links
        (board_type, climb_uuid, link, is_listed, tick_uuid, created_by_user_id, angle)
        VALUES ('kilter', ${climbUuid}, ${clipFor(climbUuid)}, true, ${tickUuid}, ${CLIMBER}, 40)`);

    const featuredFor = async (viewerId: string) => {
      const feed = await sessionFeedQueries.sessionGroupedFeed(null, { input: { limit: 20 } }, context(viewerId));
      return feed.sessions.find((session) => session.sessionId === SESSION)?.featuredBeta ?? null;
    };

    beforeEach(async () => {
      await db.execute(
        sql`DELETE FROM board_beta_links WHERE link LIKE 'https://www.instagram.com/p/draft-highlight-%'`,
      );
      await attachClip(PUBLIC_TICK, PUBLISHED);
    });

    // Each harder than the published climb, so a leak would be the clip featured.
    it.each([
      ['a draft', DRAFT_TICK, DRAFT],
      ['an unlisted climb', UNLISTED_TICK, UNLISTED],
      ['a community-hidden climb', HIDDEN_TICK, HIDDEN],
    ])('never features a clip on %s to a stranger, and features the next one', async (_label, tickUuid, climbUuid) => {
      await attachClip(tickUuid, climbUuid);
      const featured = await featuredFor(VIEWER);
      expect(featured?.betaLink.link).toBe(PUBLIC_CLIP);
      expect(featured?.tick).toMatchObject({ climbUuid: PUBLISHED, climbName: 'Published climb' });
    });

    it.each([
      ['their draft', DRAFT_TICK, DRAFT, 'Private draft'],
      ['their unlisted climb', UNLISTED_TICK, UNLISTED, 'Unlisted climb'],
    ])('features the clip on %s to the setter', async (_label, tickUuid, climbUuid, climbName) => {
      await attachClip(tickUuid, climbUuid);
      const featured = await featuredFor(SETTER);
      expect(featured?.betaLink.link).toBe(clipFor(climbUuid));
      expect(featured?.tick).toMatchObject({ climbUuid, climbName });
    });

    it('features a clip on a community-hidden climb to no one, its setter included', async () => {
      await attachClip(HIDDEN_TICK, HIDDEN);
      expect((await featuredFor(SETTER))?.betaLink.link).toBe(PUBLIC_CLIP);
    });
  });
});
