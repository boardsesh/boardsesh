import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { users, playlistOwnership } from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';
import type { PlaylistSettersInput } from '../graphql/resolvers/playlists/queries/playlist-setters';

// Integration tests (real DB) for `playlistSetters` (#6651): the setter picker
// in a playlist's filter sheet. It lists the setters of the climbs the viewer
// can see in the list, and each username must be exactly what the view's
// setter filter then matches.

const PUBLIC_PLAYLIST = 'pl-setters-public';
const PRIVATE_PLAYLIST = 'pl-setters-private';
const CROWDED_PLAYLIST = 'pl-setters-crowded';
const OWNER = 'pl-setters-owner';
const STRANGER = 'pl-setters-stranger';

function makeCtx(userId: string | null): ConnectionContext {
  const overrides: Partial<ConnectionContext> = { isAuthenticated: userId !== null, userId: userId ?? undefined };
  return {
    connectionId: 'conn-1',
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    ...overrides,
  } as ConnectionContext;
}

const owner = makeCtx(OWNER);
const stranger = makeCtx(STRANGER);
const anonymous = makeCtx(null);

async function setters(input: PlaylistSettersInput, ctx: ConnectionContext = stranger) {
  return playlistQueries.playlistSetters(null, { input }, ctx);
}

async function seedClimb(
  uuid: string,
  setter: string | null,
  options: { boardType?: string; layoutId?: number; isDraft?: boolean; userId?: string } = {},
) {
  const boardType = options.boardType ?? 'kilter';
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed, is_draft, user_id, frames_count, compatible_size_ids)
    VALUES (${uuid}, ${boardType}, ${options.layoutId ?? 1}, ${setter}, ${uuid}, '', 'p1r12', true, ${options.isDraft ?? false},
            ${options.userId ?? null}, 1, ${boardType === 'kilter' ? '{10}' : null}::int[])
  `);
}

describe('playlistSetters (real DB, #6651)', () => {
  beforeAll(async () => {
    await db.execute(sql`TRUNCATE TABLE playlist_climbs, playlist_ownership, playlists RESTART IDENTITY CASCADE`);
    await db
      .insert(users)
      .values([OWNER, STRANGER].map((id) => ({ id, email: `${id}@test.invalid` })))
      .onConflictDoNothing();
    await db.execute(sql`DELETE FROM user_favorites WHERE user_id = ${OWNER}`);

    // alice: two Kilter climbs and a Tension one; bob two; dora two drafts of
    // the owner's; bob_x and bobby one each; two climbs with no setter.
    await seedClimb('ps-1', 'alice');
    await seedClimb('ps-2', 'alice');
    await seedClimb('ps-t1', 'alice', { boardType: 'tension', layoutId: 9 });
    await seedClimb('ps-3', 'bob');
    await seedClimb('ps-4', 'bob');
    await seedClimb('ps-d1', 'dora', { isDraft: true, userId: OWNER });
    await seedClimb('ps-d2', 'dora', { isDraft: true, userId: OWNER });
    await seedClimb('ps-5', 'bob_x');
    await seedClimb('ps-6', 'bobby');
    await seedClimb('ps-7', null);
    await seedClimb('ps-8', '');

    await db.execute(sql`
      INSERT INTO playlists (id, uuid, board_type, layout_id, name, is_public)
      VALUES (1, ${PUBLIC_PLAYLIST}, 'kilter', 1, 'Setters', true),
             (2, ${PRIVATE_PLAYLIST}, 'kilter', 1, 'Private', false),
             (3, ${CROWDED_PLAYLIST}, 'kilter', 1, 'Crowded', true)
    `);
    await db
      .insert(playlistOwnership)
      .values([1, 2, 3].map((playlistId) => ({ playlistId: BigInt(playlistId), userId: OWNER, role: 'owner' })));
    const members = ['ps-1', 'ps-2', 'ps-t1', 'ps-3', 'ps-4', 'ps-d1', 'ps-d2', 'ps-5', 'ps-6', 'ps-7', 'ps-8'];
    for (const [position, climbUuid] of members.entries()) {
      await db.execute(sql`
        INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
        VALUES (1, ${climbUuid}, 40, ${position}), (2, ${climbUuid}, 40, ${position})
      `);
    }

    // 205 climbs by 205 setters, for the cap.
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed, is_draft, frames_count)
      SELECT 'ps-crowd-' || n, 'kilter', 1, 'crowd-' || lpad(n::text, 3, '0'), 'crowd', '', 'p1r12', true, false, 1
      FROM generate_series(1, 205) AS n
    `);
    await db.execute(sql`
      INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
      SELECT 3, 'ps-crowd-' || n, 40, n FROM generate_series(1, 205) AS n
    `);

    // The owner's Liked Climbs: two of alice's and one of bob's.
    await db.execute(sql`
      INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle) VALUES
        (${OWNER}, 'kilter', 'ps-1', 40), (${OWNER}, 'tension', 'ps-t1', 30), (${OWNER}, 'kilter', 'ps-3', 40)
    `);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM user_favorites WHERE user_id = ${OWNER}`);
  });

  it('counts each setter’s climbs, most first, and leaves out climbs with no setter', async () => {
    const result = await setters({ playlistId: PUBLIC_PLAYLIST }, owner);
    expect(result.slice(0, 3)).toEqual([
      { username: 'alice', climbCount: 3 },
      { username: 'bob', climbCount: 2 },
      { username: 'dora', climbCount: 2 },
    ]);
    // The two single-climb setters tie; their order is the database's username order.
    expect(
      result
        .slice(3)
        .map((setter) => setter.username)
        .sort(),
    ).toEqual(['bob_x', 'bobby']);
    expect(result.every((setter) => setter.username !== '')).toBe(true);
  });

  it('leaves out drafts for everyone but their author', async () => {
    for (const ctx of [stranger, anonymous]) {
      const result = await setters({ playlistId: PUBLIC_PLAYLIST }, ctx);
      expect(result.map((setter) => setter.username)).not.toContain('dora');
      expect(result[0]).toEqual({ username: 'alice', climbCount: 3 });
    }
  });

  it('keeps the specific-board scope: the Tension climb drops out on the Kilter', async () => {
    const result = await setters({ playlistId: PUBLIC_PLAYLIST, boardName: 'kilter', layoutId: 1, sizeId: 10 });
    expect(result.slice(0, 2)).toEqual([
      { username: 'alice', climbCount: 2 },
      { username: 'bob', climbCount: 2 },
    ]);
  });

  it('a private playlist answers its owner and refuses everyone else', async () => {
    expect((await setters({ playlistId: PRIVATE_PLAYLIST }, owner))[0]).toEqual({ username: 'alice', climbCount: 3 });
    await expect(setters({ playlistId: PRIVATE_PLAYLIST }, stranger)).rejects.toThrow();
    await expect(setters({ playlistId: PRIVATE_PLAYLIST }, anonymous)).rejects.toThrow();
  });

  it('each username filters the list to exactly its count', async () => {
    for (const [ctx, boardFields] of [
      [owner, {}],
      [stranger, {}],
      [stranger, { boardName: 'kilter', layoutId: 1, sizeId: 10 }],
    ] as const) {
      for (const { username, climbCount } of await setters({ playlistId: PUBLIC_PLAYLIST, ...boardFields }, ctx)) {
        const page = await playlistQueries.playlistClimbs(
          null,
          { input: { playlistId: PUBLIC_PLAYLIST, ...boardFields, view: { setter: [username] }, pageSize: 100 } },
          ctx,
        );
        expect(page.totalCount, username).toBe(climbCount);
        expect(page.climbs.every((climb) => climb.setter_username === username)).toBe(true);
      }
    }
  });

  it('search is a case-insensitive prefix, and an underscore in it is literal', async () => {
    expect(
      (await setters({ playlistId: PUBLIC_PLAYLIST, search: 'BOB' })).map((setter) => setter.username).sort(),
    ).toEqual(['bob', 'bob_x', 'bobby']);
    expect(await setters({ playlistId: PUBLIC_PLAYLIST, search: 'bob_' })).toEqual([
      { username: 'bob_x', climbCount: 1 },
    ]);
    expect(await setters({ playlistId: PUBLIC_PLAYLIST, search: 'lice' })).toEqual([]);
  });

  it('returns at most 200 setters', async () => {
    const result = await setters({ playlistId: CROWDED_PLAYLIST });
    expect(result).toHaveLength(200);
    expect(result[0]).toEqual({ username: 'crowd-001', climbCount: 1 });
  });

  it('lists a logbook smart list’s setters, matching its setter filter', async () => {
    const result = await setters({ smartType: 'LIKED_CLIMBS', userId: OWNER });
    expect(result).toEqual([
      { username: 'alice', climbCount: 2 },
      { username: 'bob', climbCount: 1 },
    ]);
    for (const { username, climbCount } of result) {
      const page = await playlistQueries.smartPlaylist(
        null,
        { input: { type: 'LIKED_CLIMBS', userId: OWNER, view: { setter: [username] }, pageSize: 100 } },
        stranger,
      );
      expect(page.totalCount, username).toBe(climbCount);
    }
    expect(await setters({ smartType: 'LIKED_CLIMBS', userId: OWNER, boardName: 'tension' })).toEqual([
      { username: 'alice', climbCount: 1 },
    ]);
  });

  it('refuses a recommendation, and input that names no list or two', async () => {
    await expect(setters({ smartType: 'RECOMMENDED_FRESH', userId: OWNER }, owner)).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
    await expect(setters({})).rejects.toThrow();
    await expect(setters({ playlistId: PUBLIC_PLAYLIST, smartType: 'LIKED_CLIMBS', userId: OWNER })).rejects.toThrow();
    await expect(setters({ smartType: 'LIKED_CLIMBS' })).rejects.toThrow();
    await expect(setters({ smartType: 'LIKED_CLIMBS', userId: OWNER, layoutId: 1 })).rejects.toThrow();
  });
});
