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
  await db.execute(sql`
    TRUNCATE TABLE user_favorites, sync_deletions, board_climb_stats, boardsesh_ticks,
      playlists, playlist_ownership, playlist_climbs, user_follows, setter_follows, playlist_follows
    RESTART IDENTITY CASCADE
  `);
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
  it('encodes user_favorites deletions as a bare climb_uuid with the user id', async () => {
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
    // 1 part, matching primaryKeyColumns: ['climb_uuid'] on the client. This is
    // the regression test for the log_deletion_favorites() trigger body — plpgsql
    // resolves OLD.* at runtime, so a stale body has no compile-time signal.
    expect(favDeletion?.recordId).toBe('del-fav-climb');
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
    const leaked = otherResult.deletions.find((d) => d.recordId === 'scoped-del');
    expect(leaked).toBeUndefined();
  });
});

describe('cross-user isolation — every user-scoped sync resolver', () => {
  // One seeded row per user per surface; each resolver pulled as USER_ID must
  // return exactly the own row and never the other user's. Together with the
  // syncFavorites/syncDeletions cases above this covers all 8 user-scoped
  // resolvers (syncClimbs/syncClimbStats are public reference data by design).

  const pullAs = (queryName: keyof typeof syncQueries, userId: string) =>
    (
      syncQueries[queryName] as (
        parent: unknown,
        args: { cursor: null; limit: number },
        context: ConnectionContext,
      ) => Promise<SyncResult>
    )(undefined, { cursor: null, limit: 500 }, ctx(userId));

  it('syncTicks returns only the authenticated user ticks', async () => {
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at)
      VALUES ('tick-own', ${USER_ID}, 'kilter', 'c1', 40, 'send', now()),
             ('tick-other', ${OTHER_USER_ID}, 'kilter', 'c2', 40, 'send', now())
    `);

    const result = await pullAs('syncTicks', USER_ID);
    expect(result.documents.map((doc) => (doc as Record<string, unknown>).uuid)).toEqual(['tick-own']);
  });

  it('syncPlaylists returns only playlists the user OWNS (ownership join)', async () => {
    await db.execute(sql`
      INSERT INTO playlists (uuid, board_type, name) VALUES ('pl-own', 'kilter', 'Mine'), ('pl-other', 'kilter', 'Theirs')
    `);
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id, role)
      SELECT id, ${USER_ID}, 'owner' FROM playlists WHERE uuid = 'pl-own'
    `);
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id, role)
      SELECT id, ${OTHER_USER_ID}, 'owner' FROM playlists WHERE uuid = 'pl-other'
    `);
    // A non-owner role on the other playlist must not leak it either.
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id, role)
      SELECT id, ${USER_ID}, 'editor' FROM playlists WHERE uuid = 'pl-other'
    `);

    const result = await pullAs('syncPlaylists', USER_ID);
    expect(result.documents.map((doc) => (doc as Record<string, unknown>).uuid)).toEqual(['pl-own']);
  });

  it('syncPlaylistClimbs returns only climbs of playlists the user owns', async () => {
    await db.execute(sql`
      INSERT INTO playlists (uuid, board_type, name) VALUES ('plc-own', 'kilter', 'Mine'), ('plc-other', 'kilter', 'Theirs')
    `);
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id, role)
      SELECT id, ${USER_ID}, 'owner' FROM playlists WHERE uuid = 'plc-own'
    `);
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id, role)
      SELECT id, ${OTHER_USER_ID}, 'owner' FROM playlists WHERE uuid = 'plc-other'
    `);
    await db.execute(sql`
      INSERT INTO playlist_climbs (playlist_id, climb_uuid)
      SELECT id, 'climb-own' FROM playlists WHERE uuid = 'plc-own'
    `);
    await db.execute(sql`
      INSERT INTO playlist_climbs (playlist_id, climb_uuid)
      SELECT id, 'climb-other' FROM playlists WHERE uuid = 'plc-other'
    `);

    const result = await pullAs('syncPlaylistClimbs', USER_ID);
    expect(result.documents.map((doc) => (doc as Record<string, unknown>).climb_uuid)).toEqual(['climb-own']);
  });

  it('syncUserFollows returns only the authenticated user follows', async () => {
    await db.execute(sql`
      INSERT INTO user_follows (follower_id, following_id)
      VALUES (${USER_ID}, ${OTHER_USER_ID}), (${OTHER_USER_ID}, ${USER_ID})
    `);

    const result = await pullAs('syncUserFollows', USER_ID);
    expect(result.documents).toHaveLength(1);
    expect((result.documents[0] as Record<string, unknown>).follower_id).toBe(USER_ID);
  });

  it('syncSetterFollows returns only the authenticated user setter follows', async () => {
    await db.execute(sql`
      INSERT INTO setter_follows (follower_id, setter_username)
      VALUES (${USER_ID}, 'setter-own'), (${OTHER_USER_ID}, 'setter-other')
    `);

    const result = await pullAs('syncSetterFollows', USER_ID);
    expect(result.documents.map((doc) => (doc as Record<string, unknown>).setter_username)).toEqual(['setter-own']);
  });

  it('syncPlaylistFollows returns only the authenticated user playlist follows', async () => {
    await db.execute(sql`
      INSERT INTO playlist_follows (follower_id, playlist_uuid)
      VALUES (${USER_ID}, 'plf-own'), (${OTHER_USER_ID}, 'plf-other')
    `);

    const result = await pullAs('syncPlaylistFollows', USER_ID);
    expect(result.documents.map((doc) => (doc as Record<string, unknown>).playlist_uuid)).toEqual(['plf-own']);
  });
});
