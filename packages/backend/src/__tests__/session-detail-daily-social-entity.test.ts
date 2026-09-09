/**
 * #5290 — editing a daily session group throws away the recap: synthetic
 * `daily:<user>:<date>` ids reached `updateSession`, `addComment` and `vote`,
 * which all reject them (no `board_sessions` row exists for a daily group).
 *
 * The fix is `sessionDetail` resolving `socialEntityType`/`socialEntityId` for
 * a daily-highlight session to the day's hardest tick — the same entity
 * `sessionGroupedFeed` already redirects to — so a comment or a vote posted
 * from the detail screen lands on a real row instead of a rejected one.
 * `updateSession` is unaffected by design: a daily group has no session row to
 * rename or annotate, so the mobile client stops offering the edit affordance
 * for it (see `canEditSessionDetail` in packages/mobile) rather than teaching
 * the endpoint to accept a synthetic id.
 *
 * `applyRateLimit` is stubbed to a no-op, matching session-update.test.ts, so
 * these tests don't depend on the per-process/Redis rate limiter.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { sessionFeedQueries } from '../graphql/resolvers/social/session-feed';
import { sessionEditMutations } from '../graphql/resolvers/social/session-mutations';
import { socialCommentMutations } from '../graphql/resolvers/social/comments';
import { socialVoteMutations } from '../graphql/resolvers/social/votes';

vi.mock('../graphql/resolvers/shared/helpers', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    applyRateLimit: vi.fn().mockResolvedValue(undefined),
  };
});

const USER_ID = 'sd-daily-social-user';
const CLIMB_UUID = 'sd-daily-social-climb';
const BOARD_UUID = 'sd-daily-social-board';
const DAY = '2026-03-10';
const DAILY_SESSION_ID = `daily:${USER_ID}:${DAY}`;
const ATTEMPT_TICK = 'sd-daily-social-attempt';
const SEND_TICK = 'sd-daily-social-send';

let boardId: number;

const ctx = (overrides: Partial<ConnectionContext> = {}): ConnectionContext => ({
  connectionId: 'conn-sd-daily',
  transport: 'http',
  userId: USER_ID,
  isAuthenticated: true,
  ...overrides,
});

const cleanup = async () => {
  await db.execute(sql`DELETE FROM comments WHERE entity_id IN (${ATTEMPT_TICK}, ${SEND_TICK})`);
  await db.execute(sql`DELETE FROM votes WHERE entity_id IN (${ATTEMPT_TICK}, ${SEND_TICK})`);
  await db.execute(sql`DELETE FROM vote_counts WHERE entity_id IN (${ATTEMPT_TICK}, ${SEND_TICK})`);
  await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid = ${CLIMB_UUID}`);
  await db.execute(sql`DELETE FROM user_boards WHERE uuid = ${BOARD_UUID}`);
  await db.execute(sql`DELETE FROM "users" WHERE id = ${USER_ID}`);
};

describe('sessionDetail — daily-highlight social entity (real DB)', () => {
  beforeAll(async () => {
    await cleanup();
    await db.execute(sql`
      INSERT INTO "users" (id, email, name, created_at, updated_at)
      VALUES (${USER_ID}, ${USER_ID + '@test.com'}, 'Daily Social', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    const boardResult = await db.execute(sql`
      INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name)
      VALUES (${BOARD_UUID}, ${BOARD_UUID}, ${USER_ID}, 'kilter', 1, 10, '1,20', 'Daily Social Board')
      ON CONFLICT (uuid) DO UPDATE SET slug = excluded.slug
      RETURNING id
    `);
    boardId = Number(Array.from(boardResult as Iterable<{ id: number }>)[0].id);
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at)
      VALUES (${CLIMB_UUID}, 'kilter', 1, 'test-setter', 'Daily Social Climb', 'p1r1', 1, false, true, 0, 100, 0, 150, '2024-01-01')
      ON CONFLICT (uuid) DO NOTHING
    `);
    // No session_id: an unassigned daily-highlight group, like the ticks in #5290.
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, board_id, climb_uuid, angle, status, attempt_count, difficulty, climbed_at, session_id)
      VALUES (${ATTEMPT_TICK}, ${USER_ID}, 'kilter', ${boardId}, ${CLIMB_UUID}, 40, 'attempt', 3, 30, ${DAY + ' 09:00:00'}, NULL)
    `);
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, board_id, climb_uuid, angle, status, attempt_count, difficulty, climbed_at, session_id)
      VALUES (${SEND_TICK}, ${USER_ID}, 'kilter', ${boardId}, ${CLIMB_UUID}, 40, 'send', 1, 25, ${DAY + ' 10:00:00'}, NULL)
    `);
  });

  afterAll(cleanup);

  it('resolves socialEntityType/Id to the day’s hardest tick, not the synthetic sessionId', async () => {
    const detail = await sessionFeedQueries.sessionDetail(null, { sessionId: DAILY_SESSION_ID });
    expect(detail).not.toBeNull();
    expect(detail!.sessionType).toBe('daily_highlight');
    // The send outranks the harder-graded attempt (25 vs 30) — sends always win.
    expect(detail!.socialEntityType).toBe('tick');
    expect(detail!.socialEntityId).toBe(SEND_TICK);
  });

  it('starts with zero votes/comments before anyone has voted or commented', async () => {
    const detail = await sessionFeedQueries.sessionDetail(null, { sessionId: DAILY_SESSION_ID });
    expect(detail!.upvotes).toBe(0);
    expect(detail!.commentCount).toBe(0);
  });

  it('round-trips a comment through addComment via the resolved social entity', async () => {
    const detail = await sessionFeedQueries.sessionDetail(null, { sessionId: DAILY_SESSION_ID });

    const comment = await socialCommentMutations.addComment(
      undefined,
      { input: { entityType: detail!.socialEntityType, entityId: detail!.socialEntityId, body: 'Nice send!' } },
      ctx(),
    );

    expect(comment.entityType).toBe('tick');
    expect(comment.entityId).toBe(SEND_TICK);

    // The detail screen's own comment count now reflects it — this was
    // hardcoded to 0 for every daily-highlight session before this fix.
    const refreshed = await sessionFeedQueries.sessionDetail(null, { sessionId: DAILY_SESSION_ID });
    expect(refreshed!.commentCount).toBe(1);
  });

  it('round-trips a vote through the vote mutation via the resolved social entity', async () => {
    const summary = await socialVoteMutations.vote(
      undefined,
      { input: { entityType: 'tick', entityId: SEND_TICK, value: 1 } },
      ctx(),
    );

    expect(summary.upvotes).toBe(1);

    // The detail screen's own vote count now reflects it too.
    const refreshed = await sessionFeedQueries.sessionDetail(null, { sessionId: DAILY_SESSION_ID });
    expect(refreshed!.upvotes).toBe(1);
  });

  // Documents the bug's original failure mode: the client used to send the
  // session's raw (possibly synthetic) id straight through. This is
  // pre-existing, unchanged validateEntityExists behaviour — the fix is that
  // SessionSummaryCard/SessionDetailScreen no longer send it (see
  // SessionSummaryCard.test.tsx), not that this endpoint learns to accept it.
  it('still rejects the raw daily: id directly (comments never learn the synthetic form)', async () => {
    await expect(
      socialCommentMutations.addComment(
        undefined,
        { input: { entityType: 'session', entityId: DAILY_SESSION_ID, body: 'This should not work' } },
        ctx(),
      ),
    ).rejects.toThrow(/Session not found/);
  });

  // updateSession is intentionally NOT fixed to accept a daily: id (see the
  // module doc comment above) — a daily group has no board_sessions row to
  // write to. This pins that the endpoint keeps failing closed rather than
  // silently accepting or corrupting data if the client-side gate is ever
  // bypassed.
  it('updateSession still rejects a daily: sessionId (editing stays client-gated, not endpoint-accepted)', async () => {
    await expect(
      sessionEditMutations.updateSession(
        undefined,
        { input: { sessionId: DAILY_SESSION_ID, notes: 'First proper sesh' } },
        ctx(),
      ),
    ).rejects.toThrow(/Session ID must be alphanumeric with hyphens only/);
  });
});
