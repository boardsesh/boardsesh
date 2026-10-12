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

describe('a visible tick never reveals another setter’s draft grades', () => {
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
    expect(party?.gradeDistribution).toHaveLength(1);
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
