import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext, SyncResult, SyncDeletionsResult, SyncCursorInput } from '@boardsesh/shared-schema';
import { rowsFromResult } from '@boardsesh/db/client';
import { db } from '../db/client';
import { syncQueries } from '../graphql/resolvers/sync/queries';
import { toIso } from '../graphql/resolvers/sync/row-normalize';

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

// #6339's code was reverted but its migrations stay applied in production:
// 0270's reference-membership trigger and 0272's stream_at stamp still fire
// underneath these resolvers, and nothing reads stream_at or the 0273 flag.
describe('syncDeletions with the applied #6339 migrations underneath it', () => {
  const layoutId = 96339;

  type MarkerRow = {
    id: string;
    user_id: string | null;
    deleted_at: string;
    stream_at: string | null;
    is_membership_withdrawal: boolean;
  };

  const climbMarkers = async (climbUuid: string) =>
    rowsFromResult<MarkerRow>(
      await db.execute(sql`
        SELECT id, user_id, deleted_at, stream_at, is_membership_withdrawal
        FROM sync_deletions
        WHERE table_name = 'board_climbs' AND record_id = ${climbUuid}
        ORDER BY id
      `),
    );

  // An hour old, like any copy a device has had time to pull.
  const insertPublishedClimb = (climbUuid: string, ownerId: string | null, isDraft = false, isListed = true) =>
    db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, name, is_listed, is_draft, user_id, updated_at)
      VALUES (${climbUuid}, 'kilter', ${layoutId}, 'Reverted 6339', ${isListed}, ${isDraft}, ${ownerId},
              now() - interval '1 hour')
    `);

  afterEach(async () => {
    await db.execute(sql`DELETE FROM board_climbs WHERE board_type = 'kilter' AND layout_id = ${layoutId}`);
  });

  it('delivers an unlisting marker as an ordinary deletion and pages it on deleted_at', async () => {
    const climbUuid = 'reverted-6339-unlisted';
    await insertPublishedClimb(climbUuid, USER_ID);
    await db.execute(sql`UPDATE board_climbs SET is_listed = false WHERE uuid = ${climbUuid}`);

    const [marker] = await climbMarkers(climbUuid);
    expect(marker.user_id).toBeNull();
    expect(marker.is_membership_withdrawal).toBe(false);
    expect(marker.stream_at).not.toBeNull();
    // The two cursors disagree by at least the one-second backdate, so the
    // assertion on the returned cursor below tells them apart.
    expect(Date.parse(toIso(marker.stream_at)) - Date.parse(toIso(marker.deleted_at))).toBeGreaterThanOrEqual(1000);

    const deletions = await callSyncDeletions(null, 500, OTHER_USER_ID);
    expect(deletions.deletions).toEqual([
      { tableName: 'board_climbs', recordId: climbUuid, deletedAt: toIso(marker.deleted_at) },
    ]);
    expect(deletions.cursor).toEqual({ updatedAt: toIso(marker.deleted_at), syncSeq: String(marker.id) });

    // The owner's device drops its old copy, then pulls the new row back: it
    // is newer than the marker, so the resurrection guard keeps it.
    const climbs = (await syncQueries.syncClimbs(
      undefined,
      { boardType: 'kilter', layoutId, cursor: null, limit: 500 },
      ctx(USER_ID),
    )) as SyncResult;
    const climb = (climbs.documents as Array<Record<string, unknown>>).find((document) => document.uuid === climbUuid);
    expect(climb?.is_listed).toBe(false);
    expect(Date.parse(String(climb?.updated_at))).toBeGreaterThan(Date.parse(toIso(marker.deleted_at)));
  });

  it('writes an owner-scoped marker when an unlisted climb changes owner, and the write still succeeds', async () => {
    const climbUuid = 'reverted-6339-owner-change';
    await insertPublishedClimb(climbUuid, USER_ID, false, false);
    await db.execute(sql`UPDATE board_climbs SET user_id = ${OTHER_USER_ID} WHERE uuid = ${climbUuid}`);

    const [marker] = await climbMarkers(climbUuid);
    expect(marker.user_id).toBe(USER_ID);

    const formerOwner = await callSyncDeletions(null, 500, USER_ID);
    expect(formerOwner.deletions.map((deletion) => deletion.recordId)).toEqual([climbUuid]);
    const newOwner = await callSyncDeletions(null, 500, OTHER_USER_ID);
    expect(newOwner.deletions).toEqual([]);
  });

  it("continues from a cursor #6339's backend built from stream_at, without redelivering", async () => {
    for (const climbUuid of ['stream-cursor-a', 'stream-cursor-b']) {
      await db.execute(sql`
        INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle, created_at, updated_at)
        VALUES (${USER_ID}, 'kilter', ${climbUuid}, 40, now(), now())
      `);
      await db.execute(sql`DELETE FROM user_favorites WHERE user_id = ${USER_ID} AND climb_uuid = ${climbUuid}`);
    }
    const [first] = rowsFromResult<MarkerRow>(
      await db.execute(sql`SELECT id, stream_at FROM sync_deletions ORDER BY id LIMIT 1`),
    );
    expect(first.stream_at).not.toBeNull();

    const result = await callSyncDeletions({ updatedAt: toIso(first.stream_at), syncSeq: String(first.id) }, 500);
    expect(result.deletions.map((deletion) => deletion.recordId)).toEqual(['kilter:stream-cursor-b:40']);
  });

  it("delivers the rest of a transaction when #6339's cursor ended inside it", async () => {
    // Eight markers from one DELETE: one transaction, so one deleted_at, and
    // eight increasing stream_at values from 0272's trigger.
    const climbUuids = Array.from({ length: 8 }, (_, index) => `one-txn-${index}`);
    for (const climbUuid of climbUuids) {
      await db.execute(sql`
        INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle, created_at, updated_at)
        VALUES (${USER_ID}, 'kilter', ${climbUuid}, 40, now(), now())
      `);
    }
    await db.execute(sql`DELETE FROM user_favorites WHERE user_id = ${USER_ID} AND climb_uuid LIKE 'one-txn-%'`);
    const markers = rowsFromResult<MarkerRow & { record_id: string }>(
      await db.execute(sql`SELECT id, record_id, deleted_at, stream_at FROM sync_deletions ORDER BY id`),
    );
    expect(markers).toHaveLength(8);
    expect(new Set(markers.map((marker) => toIso(marker.deleted_at))).size).toBe(1);

    // #6339's page of three ended on the third marker and returned its
    // (stream_at, id), which is later than the deleted_at all eight share.
    const third = markers[2];
    expect(Date.parse(toIso(third.stream_at))).toBeGreaterThan(Date.parse(toIso(third.deleted_at)));
    const result = await callSyncDeletions({ updatedAt: toIso(third.stream_at), syncSeq: String(third.id) }, 500);

    expect(result.deletions.map((deletion) => deletion.recordId)).toEqual(
      markers.slice(3).map((marker) => marker.record_id),
    );
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

describe('climb revision columns (#6023)', () => {
  it('syncTicks emits climb_revision, and null for a tick that has none', async () => {
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, climb_revision, angle, status, climbed_at)
      VALUES ('tick-rev-3', ${USER_ID}, 'kilter', 'c1', 3, 40, 'send', now()),
             ('tick-rev-unknown', ${USER_ID}, 'kilter', 'c1', NULL, 40, 'send', now())
    `);

    const result = (await syncQueries.syncTicks(undefined, { cursor: null, limit: 500 }, ctx())) as SyncResult;
    const revisionByUuid = new Map(
      (result.documents as Array<Record<string, unknown>>).map((doc) => [doc.uuid, doc.climb_revision]),
    );
    expect(revisionByUuid).toEqual(
      new Map([
        ['tick-rev-3', 3],
        ['tick-rev-unknown', null],
      ]),
    );
  });

  it('syncClimbs emits revision_number and holds_revision_number, 1 and 1 on a climb nobody has edited', async () => {
    const layoutId = 96023;
    await db.execute(sql`DELETE FROM board_climbs WHERE board_type = 'kilter' AND layout_id = ${layoutId}`);
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, name, is_listed, is_draft, updated_at)
      VALUES ('sync-rev-unedited', 'kilter', ${layoutId}, 'Unedited', true, false, now())
    `);
    await db.execute(sql`
      INSERT INTO board_climbs
        (uuid, board_type, layout_id, name, is_listed, is_draft, revision_number, holds_revision_number, updated_at)
      VALUES ('sync-rev-edited', 'kilter', ${layoutId}, 'Edited', true, false, 5, 3, now())
    `);

    try {
      const result = (await syncQueries.syncClimbs(
        undefined,
        { boardType: 'kilter', layoutId, cursor: null, limit: 500 },
        ctx(),
      )) as SyncResult;
      const revisionsByUuid = new Map(
        (result.documents as Array<Record<string, unknown>>).map((doc) => [
          doc.uuid,
          [doc.revision_number, doc.holds_revision_number],
        ]),
      );
      expect(revisionsByUuid).toEqual(
        new Map([
          ['sync-rev-unedited', [1, 1]],
          ['sync-rev-edited', [5, 3]],
        ]),
      );
    } finally {
      await db.execute(sql`DELETE FROM board_climbs WHERE board_type = 'kilter' AND layout_id = ${layoutId}`);
    }
  });
});

// #6339's backend issued deletion cursors whose time is later than the named
// marker's deleted_at. These cases build that shape from deleted_at itself, so
// they hold before and after the cleanup migration drops stream_at.
describe('syncDeletions resumes a cursor from before the revert', () => {
  // One transaction's markers share one deleted_at; the ids keep their order.
  const TRANSACTION_AT = '2026-10-13 02:00:00.123456';
  const LATER_AT = '2026-10-13 02:00:05.000000';

  type InsertedMarker = { id: string; record_id: string };

  const insertMarkers = async (deletedAt: string, recordIds: string[], userId = USER_ID) => {
    const inserted: InsertedMarker[] = [];
    for (const recordId of recordIds) {
      const [marker] = rowsFromResult<InsertedMarker>(
        await db.execute(sql`
          INSERT INTO sync_deletions (table_name, record_id, user_id, deleted_at)
          VALUES ('user_favorites', ${recordId}, ${userId}, ${deletedAt}::timestamp)
          RETURNING id, record_id
        `),
      );
      inserted.push(marker);
    }
    return inserted;
  };

  // What #6339's cursor held: a time after the marker's deleted_at.
  const insertionTimeCursor = (marker: InsertedMarker): SyncCursorInput => ({
    updatedAt: toIso('2026-10-13 02:00:00.373456'),
    syncSeq: String(marker.id),
  });

  const recordIds = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

  it('resumes from the named marker so the rest of its transaction arrives once', async () => {
    const markers = await insertMarkers(TRANSACTION_AT, recordIds(8, 'resume'));

    const result = await callSyncDeletions(insertionTimeCursor(markers[2]), 500);

    expect(result.deletions.map((deletion) => deletion.recordId)).toEqual(
      markers.slice(3).map((marker) => marker.record_id),
    );
    expect(result.cursor).toEqual({ updatedAt: toIso(TRANSACTION_AT), syncSeq: String(markers[7].id) });
  });

  it('leaves a cursor this resolver issued unchanged', async () => {
    const markers = await insertMarkers(TRANSACTION_AT, recordIds(8, 'own-cursor'));

    const firstPage = await callSyncDeletions(null, 3);
    expect(firstPage.cursor).toEqual({ updatedAt: toIso(TRANSACTION_AT), syncSeq: String(markers[2].id) });
    const secondPage = await callSyncDeletions(firstPage.cursor, 500);

    expect([...firstPage.deletions, ...secondPage.deletions].map((deletion) => deletion.recordId)).toEqual(
      markers.map((marker) => marker.record_id),
    );
  });

  it("keeps the cursor's time when the named marker was pruned or is not the caller's", async () => {
    // The other account's marker gets the lowest id, so resuming from its
    // deleted_at would hand this caller its own markers again.
    const others = await insertMarkers(TRANSACTION_AT, recordIds(1, 'others'), OTHER_USER_ID);
    const own = await insertMarkers(TRANSACTION_AT, recordIds(3, 'pruned'));
    const later = await insertMarkers(LATER_AT, ['later']);
    await db.execute(sql`DELETE FROM sync_deletions WHERE id = ${own[0].id}::bigint`);

    const afterPrune = await callSyncDeletions(insertionTimeCursor(own[0]), 500);
    expect(afterPrune.deletions.map((deletion) => deletion.recordId)).toEqual([later[0].record_id]);

    const otherUsersMarker = await callSyncDeletions(insertionTimeCursor(others[0]), 500);
    expect(otherUsersMarker.deletions.map((deletion) => deletion.recordId)).toEqual([later[0].record_id]);
  });
});
