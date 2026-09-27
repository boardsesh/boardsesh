/**
 * Shared fixtures for the provider sync family tests: the ledger tables the
 * worker DB may not have yet, a linked Tension account, and a stand-in for
 * Aurora's HTTP API so the real runner, appliers and fences run end to end.
 */
import { readFileSync } from 'node:fs';
import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { vi } from 'vitest';
import { encrypt } from '@boardsesh/crypto';
import type { DbInstance } from '@boardsesh/db/client';
import { initializeJobQueueSchema } from '@boardsesh/db/job-queue-schema';
import { auroraCredentials } from '@boardsesh/db/schema';
import { rotateLinkGeneration } from '@boardsesh/db/queries';

/** Apply the ledger migrations when this worker DB predates them, then the owner-only queue setup. */
export async function ensureBackgroundJobSchema(owner: postgres.Sql, workerRoles: readonly string[] = []) {
  const [existingLedger] = await owner`SELECT to_regclass('public.background_job_runs') AS ledger`;
  if (!existingLedger.ledger) {
    await owner.unsafe(
      readFileSync(new URL('../../../../../db/drizzle/0241_background_job_runs.sql', import.meta.url), 'utf8'),
    );
  }
  const [familyColumn] = await owner`SELECT 1 AS present FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'background_job_runs' AND column_name = 'family'`;
  if (!familyColumn) {
    await owner.unsafe(
      readFileSync(new URL('../../../../../db/drizzle/0243_background_job_families.sql', import.meta.url), 'utf8'),
    );
  }
  await initializeJobQueueSchema(drizzle(owner), undefined, undefined, workerRoles);
}

export const AURORA_USER_ID = 4242;
export const FIXTURE_BOARD = 'tension';

/** A user, a climb to log against, and a linked Tension credential with its control row. */
export async function insertLinkedTensionAccount(
  database: DbInstance,
  userId: string,
  climbUuid: string,
): Promise<{ linkGeneration: string }> {
  await database.execute(sql`
    INSERT INTO users (id, email, name, created_at, updated_at)
    VALUES (${userId}, ${userId + '@test.com'}, 'Sync Tester', now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
  await database.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at)
    VALUES (${climbUuid}, ${FIXTURE_BOARD}, 1, 'test-setter', 'Sync Test Climb', 'p1r1', 1, false, true, 0, 100, 0, 150, '2024-01-01')
    ON CONFLICT (uuid) DO NOTHING
  `);
  await database
    .insert(auroraCredentials)
    .values({
      userId,
      boardType: FIXTURE_BOARD,
      encryptedUsername: encrypt('climber'),
      encryptedPassword: encrypt('hunter2'),
      auroraUserId: AURORA_USER_ID,
      syncStatus: 'active',
    })
    .onConflictDoNothing();
  return database.transaction((transaction) =>
    rotateLinkGeneration(transaction, { userId, boardType: FIXTURE_BOARD, linked: true }),
  );
}

export async function removeFixtures(database: DbInstance, userIds: readonly string[], climbUuids: readonly string[]) {
  for (const userId of userIds) {
    await database.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${userId}`);
    await database.execute(sql`DELETE FROM playlist_ownership WHERE user_id = ${userId}`);
    await database.execute(sql`DELETE FROM aurora_credentials WHERE user_id = ${userId}`);
    await database.execute(sql`DELETE FROM provider_sync_controls WHERE user_id = ${userId}`);
    await database.execute(sql`DELETE FROM users WHERE id = ${userId}`);
  }
  await database.execute(sql`DELETE FROM playlist_climbs WHERE climb_uuid LIKE 'psync-%'`);
  await database.execute(sql`DELETE FROM playlists WHERE aurora_id LIKE 'psync-%'`);
  await database.execute(sql`DELETE FROM board_circuits WHERE uuid LIKE 'psync-%'`);
  await database.execute(sql`DELETE FROM board_tags WHERE entity_uuid LIKE 'psync-%'`);
  await database.execute(sql`DELETE FROM board_user_syncs WHERE user_id = ${AURORA_USER_ID}`);
  await database.execute(sql`DELETE FROM board_users WHERE id = ${AURORA_USER_ID}`);
  await database.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid LIKE 'psync-%'`);
  for (const climbUuid of climbUuids) {
    await database.execute(sql`DELETE FROM board_climbs WHERE uuid = ${climbUuid}`);
  }
  await database.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE 'psync-draft-%'`);
}

export function ascentRow(uuid: string, climbUuid: string, climbedAt: string) {
  return {
    uuid,
    climb_uuid: climbUuid,
    angle: 40,
    is_mirror: false,
    attempt_id: 2,
    bid_count: 3,
    quality: 3,
    difficulty: 20,
    is_benchmark: false,
    is_listed: true,
    comment: '',
    climbed_at: climbedAt,
    created_at: climbedAt,
  };
}

/** Every user table Aurora returns, so one page exercises every applier branch. */
export function fullSyncPage(climbUuid: string) {
  return {
    users: [{ id: AURORA_USER_ID, username: 'climber', created_at: '2024-01-01 00:00:00' }],
    draft_climbs: [
      {
        uuid: 'psync-draft-1',
        layout_id: 1,
        setter_username: 'climber',
        name: 'Draft',
        description: '',
        hsm: 1,
        edge_left: 0,
        edge_right: 100,
        edge_bottom: 0,
        edge_top: 150,
        angle: 40,
        frames_count: 1,
        frames_pace: 0,
        frames: 'p1r1',
        created_at: '2026-05-01 10:00:00',
      },
    ],
    ascents: [ascentRow('psync-ascent-1', climbUuid, '2026-05-01 22:00:00')],
    bids: [
      {
        uuid: 'psync-bid-1',
        climb_uuid: climbUuid,
        angle: 40,
        is_mirror: false,
        bid_count: 2,
        comment: '',
        climbed_at: '2026-05-02 09:00:00',
        created_at: '2026-05-02 09:00:00',
      },
    ],
    tags: [{ entity_uuid: 'psync-tagged-climb', user_id: AURORA_USER_ID, name: 'favorite', is_listed: true }],
    circuits: [
      {
        uuid: 'psync-circuit-1',
        name: 'Warmups',
        description: '',
        color: 'FF0000',
        user_id: AURORA_USER_ID,
        is_public: false,
        created_at: '2026-05-01 00:00:00',
        updated_at: '2026-05-01 00:00:00',
        climbs: [{ climb_uuid: climbUuid, angle: 40, position: 0 }],
      },
    ],
    user_syncs: [
      { table_name: 'ascents', last_synchronized_at: '2026-05-03 00:00:00.000000', user_id: AURORA_USER_ID },
    ],
    _complete: true,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * Stand-in for Aurora: `/sessions` logs in, each `/sync` returns the next page.
 * `onRequest` runs before the response, which is where a test relinks the
 * account or aborts the run between two provider calls.
 */
export function stubAuroraApi(options: {
  pages: Array<Record<string, unknown>>;
  onRequest?: (kind: 'login' | 'sync', index: number) => void | Promise<void>;
}) {
  let syncIndex = 0;
  const requests: Array<'login' | 'sync'> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    // Like the real fetch, an aborted signal rejects before any response.
    const rejectIfAborted = () => {
      if (init?.signal?.aborted) throw init.signal.reason;
    };
    if (url.endsWith('/sessions')) {
      requests.push('login');
      await options.onRequest?.('login', 0);
      rejectIfAborted();
      return jsonResponse({ session: { token: 'aurora-session-token', user_id: AURORA_USER_ID } });
    }
    if (url.endsWith('/sync')) {
      const index = syncIndex++;
      requests.push('sync');
      await options.onRequest?.('sync', index);
      rejectIfAborted();
      return jsonResponse(options.pages[Math.min(index, options.pages.length - 1)]);
    }
    throw new Error(`Unexpected request in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, requests };
}
