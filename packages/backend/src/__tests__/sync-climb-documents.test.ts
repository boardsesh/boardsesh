import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { syncClimbDocuments } from '../graphql/resolvers/sync/saved-climb';

// The ordinary pull must defer fresh writes; this exact-UUID mirror must not.
// Configure stability before import: the resolver captures this setting at module load.
process.env.SYNC_STABILITY_WINDOW_SECONDS = '30';
const { syncQueries } = await import('../graphql/resolvers/sync/queries');
process.env.SYNC_STABILITY_WINDOW_SECONDS = '0';
const OWNER = 'mirror-wall-owner';
const SETTER = 'mirror-wall-setter';
const CLIMB_UUID = 'bbc71411-d831-4bcf-8035-b8536100d6a0';
const WALL_UUID = 'bbc71411-d831-4bcf-8035-b8536100d6a1';
const WRONG_UUID = 'bbc71411-d831-4bcf-8035-b8536100d6a2';
const LAYOUT_ID = 87001;
const scope = { boardType: 'spray', layoutId: LAYOUT_ID, climbUuid: CLIMB_UUID };
function context(userId: string | null): ConnectionContext {
  return { userId, isAuthenticated: userId !== null } as ConnectionContext;
}

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE spray_walls, user_boards, board_climbs, board_climb_stats, users RESTART IDENTITY CASCADE`,
  );
  await db.execute(sql`INSERT INTO users (id, email, name) VALUES
    (${OWNER}, 'mirror-owner@example.test', 'Owner'), (${SETTER}, 'mirror-setter@example.test', 'Setter')`);
  await db.execute(sql`INSERT INTO user_boards
    (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, is_unlisted)
    VALUES (${WALL_UUID}, 'mirror-wall', ${OWNER}, 'spray', ${LAYOUT_ID}, ${LAYOUT_ID}, '', 'Wall', true, false)`);
  await db.execute(sql`INSERT INTO spray_walls (board_uuid, layout_id) VALUES (${WALL_UUID}, ${LAYOUT_ID})`);
  await db.execute(sql`INSERT INTO board_climbs
    (uuid, board_type, layout_id, name, user_id, is_draft, is_listed, compatible_size_ids, updated_at)
    VALUES (${CLIMB_UUID}, 'spray', ${LAYOUT_ID}, 'Fresh climb', ${SETTER}, false, true,
      ARRAY[${LAYOUT_ID}]::int[], now())`);
  await db.execute(sql`INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, updated_at)
    VALUES ('spray', ${CLIMB_UUID}, 40, 12, 1, now())`);
});

describe('saved climb canonical mirror', () => {
  it('returns fresh canonical climb and stats while an ordinary stable pull defers them', async () => {
    const page = await syncQueries.syncClimbs({}, { ...scope, limit: 500 }, context(SETTER));
    expect(page.documents).toEqual([]);
    const result = await syncClimbDocuments({}, scope, context(SETTER));
    expect(result?.climb).toMatchObject({ uuid: CLIMB_UUID, name: 'Fresh climb', compatible_size_ids: [LAYOUT_ID] });
    expect(result?.stats).toMatchObject([
      { climb_uuid: CLIMB_UUID, angle: 40, display_difficulty: 12, ascensionist_count: '1' },
    ]);
    expect(result).not.toHaveProperty('cursor');
    const canonicalStats = (await db.execute(sql`SELECT updated_at::text, sync_seq::text FROM board_climb_stats
      WHERE climb_uuid = ${CLIMB_UUID}`)) as unknown as Array<{ updated_at: string; sync_seq: string }>;
    expect(result?.stats).toMatchObject([
      { updated_at: canonicalStats[0].updated_at.replace(' ', 'T') + 'Z', sync_seq: canonicalStats[0].sync_seq },
    ]);
    const canonical = (await db.execute(sql`SELECT updated_at::text, sync_seq::text FROM board_climbs
      WHERE uuid = ${CLIMB_UUID}`)) as unknown as Array<{ updated_at: string; sync_seq: string }>;
    expect(result?.climb).toMatchObject({
      updated_at: canonical[0].updated_at.replace(' ', 'T') + 'Z',
      sync_seq: canonical[0].sync_seq,
    });
  });

  it('mirrors the compact UUID returned by the real saveClimb mutation', async () => {
    const { climbMutations } = await import('../graphql/resolvers/climbs/mutations');
    const saved = await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'kilter',
          layoutId: LAYOUT_ID,
          name: 'Real saved climb',
          description: '',
          isDraft: true,
          frames: 'p1r12',
          angle: 40,
        },
      },
      context(SETTER),
    );
    expect(saved.uuid).toMatch(/^[0-9A-F]{32}$/);
    expect(
      await syncClimbDocuments({}, { ...scope, boardType: 'kilter', climbUuid: saved.uuid }, context(SETTER)),
    ).toMatchObject({
      viewerId: SETTER,
      climb: { uuid: saved.uuid, name: 'Real saved climb', is_draft: true },
      stats: [],
    });
  });

  it('requires authentication and the exact scope, while published spray rows retain ordinary read access', async () => {
    await expect(syncClimbDocuments({}, scope, context(null))).rejects.toThrow();
    await expect(syncClimbDocuments({}, { ...scope, climbUuid: '' }, context(SETTER))).rejects.toThrow();
    await expect(syncClimbDocuments({}, { ...scope, climbUuid: 'F'.repeat(51) }, context(SETTER))).rejects.toThrow();
    expect(await syncClimbDocuments({}, scope, context(OWNER))).toMatchObject({
      viewerId: OWNER,
      climb: { user_id: SETTER },
    });
    expect(await syncClimbDocuments({}, { ...scope, layoutId: LAYOUT_ID + 1 }, context(SETTER))).toBeNull();
    expect(await syncClimbDocuments({}, { ...scope, boardType: 'kilter' }, context(SETTER))).toBeNull();
    expect(await syncClimbDocuments({}, { ...scope, climbUuid: WRONG_UUID }, context(SETTER))).toBeNull();
  });

  it('keeps catalogue document reads author-only for published climbs and drafts', async () => {
    await db.execute(sql`INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, user_id, is_draft, is_listed)
      VALUES (${WRONG_UUID}, 'kilter', ${LAYOUT_ID}, 'Catalogue climb', ${SETTER}, false, true)`);
    const catalogueScope = { ...scope, boardType: 'kilter', climbUuid: WRONG_UUID };
    expect(await syncClimbDocuments({}, catalogueScope, context(SETTER))).toMatchObject({
      viewerId: SETTER,
      climb: { user_id: SETTER, board_type: 'kilter' },
    });
    expect(await syncClimbDocuments({}, catalogueScope, context(OWNER))).toBeNull();
    await db.execute(sql`UPDATE board_climbs SET is_draft = true
      WHERE uuid = ${WRONG_UUID} AND board_type = 'kilter'`);
    expect(await syncClimbDocuments({}, catalogueScope, context(SETTER))).not.toBeNull();
    expect(await syncClimbDocuments({}, catalogueScope, context(OWNER))).toBeNull();
    await expect(syncClimbDocuments({}, { ...scope, layoutId: 0 }, context(SETTER))).rejects.toThrow();
    await expect(
      syncClimbDocuments({}, { ...scope, layoutId: null } as unknown as typeof scope, context(SETTER)),
    ).rejects.toThrow();
  });

  it('never exposes another setter draft, including to its public or private wall owner', async () => {
    await db.execute(sql`UPDATE board_climbs SET is_draft = true WHERE uuid = ${CLIMB_UUID}`);
    expect(await syncClimbDocuments({}, scope, context(OWNER))).toBeNull();
    expect(await syncClimbDocuments({}, scope, context('other-reader'))).toBeNull();
    expect(await syncClimbDocuments({}, scope, context(SETTER))).toMatchObject({ viewerId: SETTER });
    await db.execute(sql`UPDATE user_boards SET is_public = false WHERE uuid = ${WALL_UUID}`);
    expect(await syncClimbDocuments({}, scope, context(OWNER))).toBeNull();
    expect(await syncClimbDocuments({}, scope, context(SETTER))).toBeNull();
  });

  it('allows the wall owner to mirror another setter published climb without changing attribution', async () => {
    await db.execute(sql`UPDATE user_boards SET is_public = false WHERE uuid = ${WALL_UUID}`);
    expect(await syncClimbDocuments({}, scope, context(SETTER))).toBeNull();
    expect(await syncClimbDocuments({}, scope, context('other-reader'))).toBeNull();
    expect(await syncClimbDocuments({}, scope, context(OWNER))).toMatchObject({
      viewerId: OWNER,
      climb: { user_id: SETTER },
    });
    await db.execute(sql`UPDATE spray_walls SET hidden_at = now() WHERE board_uuid = ${WALL_UUID}`);
    expect(await syncClimbDocuments({}, scope, context(OWNER))).toMatchObject({
      viewerId: OWNER,
      climb: { user_id: SETTER },
    });
    expect(await syncClimbDocuments({}, scope, context(SETTER))).toBeNull();
  });

  it('requires the matching UUID capability for an unlisted wall', async () => {
    await db.execute(sql`UPDATE user_boards SET is_public = false, is_unlisted = true WHERE uuid = ${WALL_UUID}`);
    expect(await syncClimbDocuments({}, scope, context(SETTER))).toBeNull();
    expect(await syncClimbDocuments({}, { ...scope, sprayWallUuid: WRONG_UUID }, context(SETTER))).toBeNull();
    expect(await syncClimbDocuments({}, { ...scope, sprayWallUuid: WALL_UUID }, context(SETTER))).not.toBeNull();
    await db.execute(sql`UPDATE user_boards SET is_unlisted = false WHERE uuid = ${WALL_UUID}`);
    expect(await syncClimbDocuments({}, { ...scope, sprayWallUuid: WALL_UUID }, context(SETTER))).toBeNull();
  });

  it('does not let a capability bypass hidden or deleted walls', async () => {
    await db.execute(sql`UPDATE user_boards SET is_public = false, is_unlisted = true WHERE uuid = ${WALL_UUID}`);
    await db.execute(sql`UPDATE spray_walls SET hidden_at = now() WHERE board_uuid = ${WALL_UUID}`);
    expect(await syncClimbDocuments({}, { ...scope, sprayWallUuid: WALL_UUID }, context(SETTER))).toBeNull();
    await db.execute(sql`UPDATE board_climbs SET user_id = ${OWNER} WHERE uuid = ${CLIMB_UUID}`);
    expect(await syncClimbDocuments({}, scope, context(OWNER))).not.toBeNull();
    await db.execute(sql`UPDATE board_climbs SET user_id = ${SETTER} WHERE uuid = ${CLIMB_UUID}`);
    await db.execute(sql`UPDATE spray_walls SET hidden_at = NULL, deleted_at = now() WHERE board_uuid = ${WALL_UUID}`);
    expect(await syncClimbDocuments({}, { ...scope, sprayWallUuid: WALL_UUID }, context(SETTER))).toBeNull();
    await db.execute(sql`UPDATE spray_walls SET deleted_at = NULL WHERE board_uuid = ${WALL_UUID}`);
    await db.execute(sql`UPDATE user_boards SET deleted_at = now() WHERE uuid = ${WALL_UUID}`);
    expect(await syncClimbDocuments({}, { ...scope, sprayWallUuid: WALL_UUID }, context(SETTER))).toBeNull();
  });
});
