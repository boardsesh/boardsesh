import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';
import { setterFollowQueries } from '../graphql/resolvers/social/setter-follows';

const OWNER = 'created-playlist-owner';
const STRANGER = 'created-playlist-stranger';
const PREFIX = 'created-playlist-';
const WALL_LAYOUT = 974520;
const ACTIVE = {
  activeBoardName: 'kilter',
  activeLayoutId: 1,
  activeSizeId: 10,
  activeSetIds: '1',
  activeAngle: 40,
};

function context(userId: string | null = OWNER): ConnectionContext {
  return { connectionId: userId ?? 'anonymous', isAuthenticated: !!userId, userId } as ConnectionContext;
}

type Input = Parameters<typeof playlistQueries.smartPlaylist>[1]['input'];
function fetchCreated(input: Partial<Input> = {}, viewer = context()) {
  return playlistQueries.smartPlaylist(null, { input: { type: 'CREATED_CLIMBS', userId: OWNER, ...input } }, viewer);
}

// Test Postgres uses hand-maintained DDL. Narrow INSERTs avoid unrelated schema
// defaults/columns, as the neighboring playlist integration suites do.
async function seedClimb(
  suffix: string,
  options: {
    boardType?: string;
    layoutId?: number;
    userId?: string | null;
    setter?: string;
    draft?: boolean;
    listed?: boolean;
    hidden?: boolean;
    sizes?: string;
    sets?: string;
  } = {},
) {
  await db.execute(sql`
    INSERT INTO board_climbs
      (uuid, board_type, layout_id, user_id, setter_username, name, frames, frames_count,
       is_draft, is_listed, is_hidden, created_at, compatible_size_ids, required_set_ids)
    VALUES (${PREFIX + suffix}, ${options.boardType ?? 'kilter'}, ${options.layoutId ?? 1},
      ${options.userId === undefined ? OWNER : options.userId}, ${options.setter ?? 'owner-setter'}, ${suffix},
      'p1r12p2r14', 1, ${options.draft ?? false}, ${options.listed ?? true}, ${options.hidden ?? false},
      '2026-11-01', ${options.sizes ?? '{10}'}::int[], ${options.sets ?? '{1}'}::int[])
  `);
}

describe('Created climbs generated playlist (real Postgres)', () => {
  beforeAll(async () => {
    for (const userId of [OWNER, STRANGER]) {
      await db.execute(sql`
        INSERT INTO users (id, email, name, created_at, updated_at)
        VALUES (${userId}, ${userId + '@test.com'}, ${userId}, NOW(), NOW())
      `);
    }
    await db.execute(sql`
      INSERT INTO user_board_mappings (user_id, board_type, board_username)
      VALUES (${OWNER}, 'kilter', 'linked-setter')
    `);
    await seedClimb('direct');
    await seedClimb('linked', { userId: null, setter: 'linked-setter' });
    await seedClimb('direct-and-linked', { setter: 'linked-setter' });
    await seedClimb('hidden', { hidden: true });
    await seedClimb('unlisted', { listed: false });
    await seedClimb('draft', { draft: true });
    await seedClimb('linked-wrong-board', { boardType: 'tension', userId: null, setter: 'linked-setter' });
    await seedClimb('other-setter', { userId: STRANGER });
    await seedClimb('other-board', { boardType: 'tension' });
    await seedClimb('wrong-layout', { layoutId: 8 });
    await seedClimb('wrong-size', { sizes: '{25}' });
    await seedClimb('wrong-sets', { sets: '{1,20}' });
    for (const [index, ownerId, deleted] of [
      [0, OWNER, false],
      [1, STRANGER, false],
      [2, OWNER, true],
    ] as const) {
      const boardUuid = `${PREFIX}wall-${index}`;
      const layoutId = WALL_LAYOUT + index;
      await db.execute(sql`
        INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public)
        VALUES (${boardUuid}, ${boardUuid}, ${ownerId}, 'spray', ${layoutId}, ${layoutId}, '1', 'Private wall', false)
      `);
      await db.execute(sql`
        INSERT INTO spray_walls (board_uuid, layout_id, deleted_at)
        VALUES (${boardUuid}, ${layoutId}, ${deleted ? '2026-11-01T00:00:00Z' : null})
      `);
      await seedClimb(`spray-${index}`, { boardType: 'spray', layoutId });
    }
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM spray_walls WHERE layout_id BETWEEN ${WALL_LAYOUT} AND ${WALL_LAYOUT + 2}`);
    await db.execute(sql`DELETE FROM user_boards WHERE uuid LIKE ${PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${OWNER}, ${STRANGER})`);
  });

  it('matches the owner profile, including linked, hidden and unlisted climbs but no drafts', async () => {
    const created = await fetchCreated({ pageSize: 100 });
    const profile = await setterFollowQueries.userClimbs(
      null,
      { input: { userId: OWNER, sortBy: 'new', limit: 100 } },
      context(),
    );
    expect(created.climbs.map((climb) => climb.uuid)).toEqual(profile.climbs.map((climb) => climb.uuid));
    expect(created.totalCount).toBe(10);
    expect(created.meta.climbCount).toBe(10);
    const suffixes = created.climbs.map((climb) => climb.uuid.slice(PREFIX.length));
    expect(suffixes).toEqual(expect.arrayContaining(['direct', 'linked', 'direct-and-linked', 'hidden', 'unlisted']));
    expect(suffixes).not.toEqual(expect.arrayContaining(['draft']));
    expect(created.climbs.find((climb) => climb.uuid === PREFIX + 'hidden')?.is_hidden).toBe(true);
  });

  it('keeps accessible private spray walls and excludes inaccessible or deleted walls', async () => {
    const result = await fetchCreated({ boardName: 'spray' });
    expect(result.climbs.map((climb) => climb.uuid)).toEqual([PREFIX + 'spray-0']);
    expect(result.totalCount).toBe(1);
  });

  it('applies board type before pagination and counts', async () => {
    const first = await fetchCreated({ boardName: 'tension', pageSize: 1 });
    expect(first.climbs.map((climb) => climb.uuid)).toEqual([PREFIX + 'other-board']);
    expect(first.totalCount).toBe(1);
    expect(first.hasMore).toBe(false);
    const beyond = await fetchCreated({ boardName: 'tension', pageSize: 1, page: 1 });
    expect(beyond.climbs).toEqual([]);
    expect(beyond.totalCount).toBe(1);
  });

  it('filters layout, size and sets before page boundaries with stable newest order', async () => {
    const collected: string[] = [];
    for (let page = 0; page < 4; page++) {
      const result = await fetchCreated({ ...ACTIVE, pageSize: 2, page });
      expect(result.totalCount).toBe(5);
      expect(result.meta.climbCount).toBe(5);
      expect(result.hasMore).toBe(page < 2);
      collected.push(...result.climbs.map((climb) => climb.uuid));
    }
    expect(collected).toEqual(
      ['unlisted', 'linked', 'hidden', 'direct-and-linked', 'direct'].map((suffix) => PREFIX + suffix),
    );
    expect(new Set(collected).size).toBe(5);
  });

  it('uses the same unscoped membership for its library-card count', async () => {
    const created = await fetchCreated({ pageSize: 100 });
    const counts = await playlistQueries.mySmartPlaylistCounts(null, undefined, context());
    expect(counts.find((entry) => entry.type === 'CREATED_CLIMBS')?.count).toBe(created.totalCount);
  });

  it.each([null, STRANGER])('returns uniform empty metadata before any DB access for viewer %s', async (viewerId) => {
    const select = vi.spyOn(db, 'select');
    const execute = vi.spyOn(db, 'execute');
    try {
      for (const userId of [OWNER, 'created-playlist-missing-user']) {
        const result = await fetchCreated({ userId }, context(viewerId));
        expect(result).toEqual({
          meta: { type: 'CREATED_CLIMBS', userId, userName: 'Climber', userAvatar: null, climbCount: 0 },
          climbs: [],
          totalCount: 0,
          hasMore: false,
        });
      }
      expect(select).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
      execute.mockRestore();
    }
  });

  it('rejects public view filters before DB access', async () => {
    await expect(fetchCreated({ view: { sortBy: 'name' } })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });
});
