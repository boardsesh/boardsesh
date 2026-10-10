import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { createRequire } from 'node:module';
import { sql } from 'drizzle-orm';
import type * as GraphQLModule from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { setupWorkerDatabase } from './worker-db';

vi.mock('../utils/rate-limiter', () => ({ checkRateLimit: vi.fn(), resetAllRateLimits: vi.fn() }));
vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn().mockResolvedValue(undefined) }));

// Side effects saveTick fires after the write; none of them are under test and
// they would otherwise pull in Redis / the social event bus.
vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', () => ({
  queueClimbStatsRecompute: vi.fn(),
  recomputeClimbStatsNow: vi.fn(async () => undefined),
}));
vi.mock('../events', () => ({ publishSocialEvent: vi.fn(async () => undefined) }));
vi.mock('../graphql/resolvers/sessions/debounced-stats-publisher', () => ({
  publishDebouncedSessionStats: vi.fn(),
}));
vi.mock('../graphql/resolvers/board-presence/stats', () => ({ queueBoardStatsPublish: vi.fn() }));
vi.mock('../services/analytics/posthog', () => ({ captureBackendEvent: vi.fn(() => true) }));

import { db } from '../db/client';
import { schema } from '../graphql/index';

// `graphql` resolves to two module instances under the test transform. The
// schema was built with the CJS copy, so `execute` has to come from the same
// one. See spray-visibility-sweep.test.ts for the long version.
const requireFromHere = createRequire(import.meta.url);
const { execute, parse } = requireFromHere('graphql') as typeof GraphQLModule;

const USER_ID = 'u-tick-revision';
const BOARD = 'moonboard';
// Prefixed so cleanup can't touch a neighbouring suite's fixtures.
const CLIMB_UUID = 'TICKREV-CLIMB';

const SAVE_TICK = `mutation Save($input: SaveTickInput!) {
  saveTick(input: $input) { uuid climbRevision }
}`;

/**
 * Climb revisions were retired (#6023, #6180): saveTick no longer records which
 * revision a tick was logged on. `SaveTickInput.climbRevision` stays in the
 * schema because app bundles from before the retirement, and sends already
 * queued in their offline outboxes, still carry it. Dropping the field would
 * fail those requests, and the drainer dead-letters a send that fails for good.
 */
describe('saveTick with a climbRevision from an older app', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (${USER_ID}, ${`${USER_ID}@test.com`}, 'Rev Vision', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed)
      VALUES (${CLIMB_UUID}, ${BOARD}, 1, 'setter', 'Test Climb', '', 'p1r1', true)
      ON CONFLICT (uuid) DO NOTHING
    `);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid = ${CLIMB_UUID}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
  });

  it('saves the tick and stores no revision', async () => {
    const result = await execute({
      schema,
      document: parse(SAVE_TICK),
      variableValues: {
        input: {
          boardType: BOARD,
          climbUuid: CLIMB_UUID,
          climbRevision: 3,
          angle: 40,
          isMirror: false,
          status: 'send',
          attemptCount: 1,
          quality: 4,
          difficulty: 17,
          isBenchmark: false,
          comment: '',
          climbedAt: '2026-08-15T12:00:00.000Z',
        },
      },
      contextValue: {
        connectionId: 'conn-tick-revision',
        isAuthenticated: true,
        userId: USER_ID,
      } as ConnectionContext,
    });

    expect(result.errors ?? []).toEqual([]);
    const saved = (result.data as { saveTick: { uuid: string; climbRevision: number | null } }).saveTick;
    expect(saved.climbRevision).toBeNull();

    const stored = (await db.execute(sql`
      SELECT climb_revision FROM boardsesh_ticks WHERE uuid = ${saved.uuid}
    `)) as unknown as Array<{ climb_revision: number | null }>;
    expect([...stored]).toEqual([{ climb_revision: null }]);
  });
});
