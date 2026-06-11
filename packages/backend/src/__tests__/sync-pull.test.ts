import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext, SyncResult, SyncDeletionsResult, SyncCursorInput } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { syncQueries } from '../graphql/resolvers/sync/queries';

const USER_ID = 'sync-pull-user';
const OTHER_USER_ID = 'sync-pull-other';

function ctx(userId: string = USER_ID): ConnectionContext {
  return {
    connectionId: 'sync-pull-conn',
    isAuthenticated: true,
    userId,
    sessionId: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

async function insertUser(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'Test ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

const callSyncFavorites = (cursor: SyncCursorInput | null, limit: number, userId = USER_ID) =>
  syncQueries.syncFavorites(undefined, { cursor, limit }, ctx(userId)) as Promise<SyncResult>;

const callSyncDeletions = (cursor: SyncCursorInput | null, limit: number, userId = USER_ID) =>
  syncQueries.syncDeletions(undefined, { cursor, limit }, ctx(userId)) as Promise<SyncDeletionsResult>;

beforeEach(async () => {
  // The shared setup only truncates session tables between tests; clear the
  // sync surface here so each case starts clean (no cross-test favorite/deletion
  // leakage, which would inflate the from-epoch pulls below).
  await db.execute(sql`TRUNCATE TABLE user_favorites, sync_deletions, board_climb_stats RESTART IDENTITY CASCADE`);
  await insertUser(USER_ID);
  await insertUser(OTHER_USER_ID);
});

describe('syncFavorites — document shape + composite-cursor pagination', () => {
  it('emits snake_case documents scoped to the authenticated user', async () => {
    await db.execute(sql`
      INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle, created_at, updated_at)
      VALUES (${USER_ID}, 'kilter', 'shape-climb', 40, '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')
    `);
    // A different user's favorite must NOT leak into this user's pull.
    await db.execute(sql`
      INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle, created_at, updated_at)
      VALUES (${OTHER_USER_ID}, 'tension', 'other-climb', 25, '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')
    `);

    const result = await callSyncFavorites(null, 500);

    expect(result.documents).toHaveLength(1);
    const doc = result.documents[0] as Record<string, unknown>;
    // Keys are the snake_case local columns from the manifest, no synthetic id,
    // and timestamps are ISO strings.
    expect(Object.keys(doc).sort()).toEqual(
      ['angle', 'board_name', 'climb_uuid', 'created_at', 'updated_at', 'user_id'].sort(),
    );
    expect(doc.board_name).toBe('kilter');
    expect(doc.climb_uuid).toBe('shape-climb');
    expect(doc.user_id).toBe(USER_ID);
    expect(typeof doc.updated_at).toBe('string');
    expect(doc).not.toHaveProperty('__seq');
    expect(doc).not.toHaveProperty('id');
    expect(result.hasMore).toBe(false);
  });

  it('pages through a timestamp collision without skipping or duplicating rows', async () => {
    // 7 favorites that ALL share the exact same updated_at — the Aurora
    // bulk-update collision scenario. Only the bigserial id differentiates them.
    const sharedTs = '2026-05-02T12:00:00Z';
    const total = 7;
    for (let i = 0; i < total; i++) {
      await db.execute(sql`
        INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle, created_at, updated_at)
        VALUES (${USER_ID}, 'kilter', ${'collide-' + i}, 40, ${sharedTs}, ${sharedTs})
      `);
    }

    const pageSize = 3;
    const seen = new Set<string>();
    let cursor: SyncCursorInput | null = null;
    let pages = 0;
    let hasMore = true;

    while (hasMore) {
      const page: SyncResult = await callSyncFavorites(cursor, pageSize);
      pages++;
      for (const doc of page.documents as Array<Record<string, unknown>>) {
        seen.add(String(doc.climb_uuid));
      }
      cursor = page.cursor;
      hasMore = page.hasMore;
      // Safety valve so a cursor bug can't loop forever.
      expect(pages).toBeLessThan(10);
    }

    // Every row fetched exactly once across pages despite the identical timestamp.
    expect(seen.size).toBe(total);
    for (let i = 0; i < total; i++) {
      expect(seen.has('collide-' + i)).toBe(true);
    }
    // ceil(7 / 3) = 3 pages; the cursor advanced by id within the shared timestamp.
    expect(pages).toBe(3);
  });

  it('returns the supplied cursor unchanged when there are no new rows', async () => {
    const cursor: SyncCursorInput = { updatedAt: '2030-01-01T00:00:00Z', syncSeq: '999' };
    const result = await callSyncFavorites(cursor, 500);
    expect(result.documents).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.cursor.updatedAt).toBe('2030-01-01T00:00:00Z');
    expect(result.cursor.syncSeq).toBe('999');
  });
});

describe('syncDeletions — record_id encoding', () => {
  it('encodes user_favorites deletions as board_name:climb_uuid:angle with the user id', async () => {
    await db.execute(sql`
      INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle, created_at, updated_at)
      VALUES (${USER_ID}, 'tension', 'del-fav-climb', 25, now(), now())
    `);
    await db.execute(sql`
      DELETE FROM user_favorites WHERE user_id = ${USER_ID} AND climb_uuid = 'del-fav-climb'
    `);

    const result = await callSyncDeletions(null, 500);

    const favDeletion = result.deletions.find((d) => d.tableName === 'user_favorites');
    expect(favDeletion).toBeDefined();
    expect(favDeletion?.recordId).toBe('tension:del-fav-climb:25');
    expect(typeof favDeletion?.deletedAt).toBe('string');
  });

  it('encodes board_climb_stats deletions as board_type:climb_uuid:angle (reference data, user-NULL)', async () => {
    await db.execute(sql`
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, updated_at)
      VALUES ('kilter', 'del-stats-climb', 40, 5, now())
    `);
    await db.execute(sql`
      DELETE FROM board_climb_stats WHERE board_type = 'kilter' AND climb_uuid = 'del-stats-climb' AND angle = 40
    `);

    // Reference-data deletions (user_id IS NULL) are visible to every user.
    const result = await callSyncDeletions(null, 500);

    const statsDeletion = result.deletions.find((d) => d.tableName === 'board_climb_stats');
    expect(statsDeletion).toBeDefined();
    expect(statsDeletion?.recordId).toBe('kilter:del-stats-climb:40');
  });

  it('scopes user deletions: another user does not see this user favorite deletion', async () => {
    await db.execute(sql`
      INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle, created_at, updated_at)
      VALUES (${USER_ID}, 'kilter', 'scoped-del', 40, now(), now())
    `);
    await db.execute(sql`DELETE FROM user_favorites WHERE user_id = ${USER_ID} AND climb_uuid = 'scoped-del'`);

    const otherResult = await callSyncDeletions(null, 500, OTHER_USER_ID);
    const leaked = otherResult.deletions.find((d) => d.recordId === 'kilter:scoped-del:40');
    expect(leaked).toBeUndefined();
  });
});
