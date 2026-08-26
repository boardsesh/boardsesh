import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { playlistMutations } from '../graphql/resolvers/playlists/mutations';

// #4015: addClimbToPlaylist only checked ownership, not board/layout
// compatibility, so a cross-board add would insert a playlist_climbs row
// successfully — then the board-scoped membership refetch
// (playlistsForClimb / playlistsForClimbs, which filter on
// board_type = X AND (layout_id = Y OR layout_id IS NULL)) would silently
// exclude it, making the UI checkmark vanish. #4268 fixed the mobile picker
// to stop offering mismatched playlists as targets; this guard is the
// server-side backstop that mirrors the membership query's exact rule.
//
// FIXTURE_RUN_ID keeps rows unique across parallel test workers sharing the
// worker DB (see the "Backend tests: shared worker DBs" note) — no TRUNCATE
// of shared tables, only scoped INSERT/DELETE by uuid prefix.

// Short: climbUuid goes through ExternalUUIDSchema (max 50 chars), so keep
// every generated climb uuid well under that ceiling.
const FIXTURE_RUN_ID = crypto.randomUUID().slice(0, 8);
const OWNER_ID = `bg4015-owner-${FIXTURE_RUN_ID}`;

const KILTER_LAYOUT_8_PLAYLIST = `bg4015-kilter-l8-${FIXTURE_RUN_ID}`;
const KILTER_NULL_LAYOUT_PLAYLIST = `bg4015-kilter-null-${FIXTURE_RUN_ID}`;
const GRASSHOPPER_LAYOUT_8_PLAYLIST = `bg4015-grasshopper-l8-${FIXTURE_RUN_ID}`;

const KILTER_L8_CLIMB = `bg4015-ck8-${FIXTURE_RUN_ID}`;
const KILTER_L9_CLIMB = `bg4015-ck9-${FIXTURE_RUN_ID}`;
const TENSION_L8_CLIMB = `bg4015-ct8-${FIXTURE_RUN_ID}`;
const GRASSHOPPER_L8_CLIMB = `bg4015-cg8-${FIXTURE_RUN_ID}`;
const UNKNOWN_CLIMB = `bg4015-cunk-${FIXTURE_RUN_ID}`;

const ALIAS_UUID = `bg4015-calias-${FIXTURE_RUN_ID}`;
const ALIAS_CANONICAL_KILTER_L8 = KILTER_L8_CLIMB;

// One alias uuid carrying a row under BOTH boards — the alias PK is
// (board_type, alias_uuid), so this is representable and each row can point at
// a different canonical climb.
const AMBIGUOUS_ALIAS_UUID = `bg4015-camb-${FIXTURE_RUN_ID}`;

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: `bg4015-${FIXTURE_RUN_ID}`,
    isAuthenticated: true,
    userId: OWNER_ID,
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    ...overrides,
  } as ConnectionContext;
}

async function playlistIdByUuid(playlistUuid: string): Promise<number> {
  const result = await db.execute(sql`SELECT id FROM playlists WHERE uuid = ${playlistUuid}`);
  const rows = Array.from(result as Iterable<{ id: number }>);
  return rows[0].id;
}

async function climbUuidsInPlaylist(playlistUuid: string): Promise<string[]> {
  const playlistId = await playlistIdByUuid(playlistUuid);
  const result = await db.execute(sql`
    SELECT climb_uuid FROM playlist_climbs WHERE playlist_id = ${playlistId}
  `);
  return Array.from(result as Iterable<{ climb_uuid: string }>).map((row) => row.climb_uuid);
}

describe('addClimbToPlaylist — board-compatibility guard (#4015)', () => {
  beforeAll(async () => {
    await db.execute(sql`
      INSERT INTO users (id, email, name)
      VALUES (${OWNER_ID}, ${`${OWNER_ID}@test.invalid`}, 'Board guard owner')
      ON CONFLICT (id) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, is_listed)
      VALUES
        (${KILTER_L8_CLIMB}, 'kilter', 8, 'setter', 'Kilter layout 8 climb', 'p1', true),
        (${KILTER_L9_CLIMB}, 'kilter', 9, 'setter', 'Kilter layout 9 climb', 'p1', true),
        (${TENSION_L8_CLIMB}, 'tension', 8, 'setter', 'Tension layout 8 climb', 'p1', true),
        (${GRASSHOPPER_L8_CLIMB}, 'grasshopper', 8, 'setter', 'Grasshopper layout 8 climb', 'p1', true)
      ON CONFLICT (uuid) DO NOTHING
    `);

    // A non-canonical alias pointing at the Kilter layout-8 climb, on the
    // same board — this is what board_climb_aliases dedup rows look like.
    await db.execute(sql`
      INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
      VALUES
        ('kilter', ${ALIAS_UUID}, ${ALIAS_CANONICAL_KILTER_L8}, 'kilter'),
        ('kilter', ${AMBIGUOUS_ALIAS_UUID}, ${KILTER_L8_CLIMB}, 'kilter'),
        ('tension', ${AMBIGUOUS_ALIAS_UUID}, ${TENSION_L8_CLIMB}, 'aurora')
      ON CONFLICT (board_type, alias_uuid) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO playlists (uuid, board_type, layout_id, name, is_public)
      VALUES
        (${KILTER_LAYOUT_8_PLAYLIST}, 'kilter', 8, 'Kilter layout 8 playlist', false),
        (${KILTER_NULL_LAYOUT_PLAYLIST}, 'kilter', NULL, 'Kilter any-layout playlist', false),
        (${GRASSHOPPER_LAYOUT_8_PLAYLIST}, 'grasshopper', 8, 'Grasshopper layout 8 playlist', false)
      ON CONFLICT (uuid) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id, role)
      SELECT id, ${OWNER_ID}, 'owner' FROM playlists
      WHERE uuid IN (${KILTER_LAYOUT_8_PLAYLIST}, ${KILTER_NULL_LAYOUT_PLAYLIST}, ${GRASSHOPPER_LAYOUT_8_PLAYLIST})
      ON CONFLICT (playlist_id, user_id) DO NOTHING
    `);
  });

  afterAll(async () => {
    // playlist_climbs.playlist_id is declared `onDelete: 'cascade'`
    // (packages/db/src/schema/app/playlists.ts), so dropping the playlists
    // takes every membership row these tests added with them.
    await db.execute(
      sql`DELETE FROM playlists WHERE uuid IN (${KILTER_LAYOUT_8_PLAYLIST}, ${KILTER_NULL_LAYOUT_PLAYLIST}, ${GRASSHOPPER_LAYOUT_8_PLAYLIST})`,
    );
    await db.execute(sql`DELETE FROM board_climb_aliases WHERE alias_uuid IN (${ALIAS_UUID}, ${AMBIGUOUS_ALIAS_UUID})`);
    await db.execute(
      sql`DELETE FROM board_climbs WHERE uuid IN (${KILTER_L8_CLIMB}, ${KILTER_L9_CLIMB}, ${TENSION_L8_CLIMB}, ${GRASSHOPPER_L8_CLIMB})`,
    );
    await db.execute(sql`DELETE FROM users WHERE id = ${OWNER_ID}`);
  });

  it('accepts a same-board, same-layout add', async () => {
    const result = (await playlistMutations.addClimbToPlaylist(
      null,
      { input: { playlistId: KILTER_LAYOUT_8_PLAYLIST, climbUuid: KILTER_L8_CLIMB, angle: 40 } },
      makeCtx(),
    )) as { climbUuid: string };

    expect(result.climbUuid).toBe(KILTER_L8_CLIMB);
    expect(await climbUuidsInPlaylist(KILTER_LAYOUT_8_PLAYLIST)).toContain(KILTER_L8_CLIMB);
  });

  it('rejects -5 when the stored playlist is Kilter', async () => {
    await expect(
      playlistMutations.addClimbToPlaylist(
        null,
        { input: { playlistId: KILTER_LAYOUT_8_PLAYLIST, climbUuid: KILTER_L8_CLIMB, angle: -5 } },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('accepts -5 when the stored playlist is Grasshopper', async () => {
    const result = (await playlistMutations.addClimbToPlaylist(
      null,
      {
        input: {
          playlistId: GRASSHOPPER_LAYOUT_8_PLAYLIST,
          climbUuid: GRASSHOPPER_L8_CLIMB,
          angle: -5,
        },
      },
      makeCtx(),
    )) as { climbUuid: string };

    expect(result.climbUuid).toBe(GRASSHOPPER_L8_CLIMB);
  });

  it('rejects a cross-board add (different boardType)', async () => {
    // The code matters as much as the message: clients branch on
    // BAD_USER_INPUT to tell "you picked the wrong playlist" apart from a
    // server failure they should retry.
    await expect(
      playlistMutations.addClimbToPlaylist(
        null,
        { input: { playlistId: KILTER_LAYOUT_8_PLAYLIST, climbUuid: TENSION_L8_CLIMB, angle: 40 } },
        makeCtx(),
      ),
    ).rejects.toMatchObject({
      message: 'This playlist is for a different board',
      extensions: { code: 'BAD_USER_INPUT' },
    });

    expect(await climbUuidsInPlaylist(KILTER_LAYOUT_8_PLAYLIST)).not.toContain(TENSION_L8_CLIMB);
  });

  it('rejects a same-board layout mismatch when the playlist has a specific layoutId', async () => {
    await expect(
      playlistMutations.addClimbToPlaylist(
        null,
        { input: { playlistId: KILTER_LAYOUT_8_PLAYLIST, climbUuid: KILTER_L9_CLIMB, angle: 40 } },
        makeCtx(),
      ),
    ).rejects.toThrow('This playlist is for a different board');

    expect(await climbUuidsInPlaylist(KILTER_LAYOUT_8_PLAYLIST)).not.toContain(KILTER_L9_CLIMB);
  });

  it('accepts any layout of its own board when the playlist has a NULL layoutId', async () => {
    const resultL8 = (await playlistMutations.addClimbToPlaylist(
      null,
      { input: { playlistId: KILTER_NULL_LAYOUT_PLAYLIST, climbUuid: KILTER_L8_CLIMB, angle: 40 } },
      makeCtx(),
    )) as { climbUuid: string };
    const resultL9 = (await playlistMutations.addClimbToPlaylist(
      null,
      { input: { playlistId: KILTER_NULL_LAYOUT_PLAYLIST, climbUuid: KILTER_L9_CLIMB, angle: 40 } },
      makeCtx(),
    )) as { climbUuid: string };

    expect(resultL8.climbUuid).toBe(KILTER_L8_CLIMB);
    expect(resultL9.climbUuid).toBe(KILTER_L9_CLIMB);
    const members = await climbUuidsInPlaylist(KILTER_NULL_LAYOUT_PLAYLIST);
    expect(members).toContain(KILTER_L8_CLIMB);
    expect(members).toContain(KILTER_L9_CLIMB);
  });

  it('rejects a different board even when the playlist has a NULL layoutId', async () => {
    await expect(
      playlistMutations.addClimbToPlaylist(
        null,
        { input: { playlistId: KILTER_NULL_LAYOUT_PLAYLIST, climbUuid: TENSION_L8_CLIMB, angle: 40 } },
        makeCtx(),
      ),
    ).rejects.toThrow('This playlist is for a different board');

    expect(await climbUuidsInPlaylist(KILTER_NULL_LAYOUT_PLAYLIST)).not.toContain(TENSION_L8_CLIMB);
  });

  it('fails open (allows the add) when the climb uuid has no board_climbs row and no alias', async () => {
    const result = (await playlistMutations.addClimbToPlaylist(
      null,
      { input: { playlistId: KILTER_LAYOUT_8_PLAYLIST, climbUuid: UNKNOWN_CLIMB, angle: 40 } },
      makeCtx(),
    )) as { climbUuid: string };

    expect(result.climbUuid).toBe(UNKNOWN_CLIMB);
    expect(await climbUuidsInPlaylist(KILTER_LAYOUT_8_PLAYLIST)).toContain(UNKNOWN_CLIMB);
  });

  it('resolves an alias uuid to its canonical board and accepts a same-board add', async () => {
    const result = (await playlistMutations.addClimbToPlaylist(
      null,
      { input: { playlistId: KILTER_LAYOUT_8_PLAYLIST, climbUuid: ALIAS_UUID, angle: 40 } },
      makeCtx(),
    )) as { climbUuid: string };

    expect(result.climbUuid).toBe(ALIAS_UUID);
    expect(await climbUuidsInPlaylist(KILTER_LAYOUT_8_PLAYLIST)).toContain(ALIAS_UUID);
  });

  it('resolves an alias uuid to its canonical layout and rejects a layout mismatch', async () => {
    // ALIAS_UUID resolves to a Kilter layout-8 canonical climb; the
    // null-layout playlist above is Kilter (would accept it), so exercise
    // the reject path against a Kilter *layout-9* playlist instead — the
    // canonical climb's board matches but its layout doesn't.
    const specificLayoutPlaylist = `bg4015-kilter-l9-playlist-${FIXTURE_RUN_ID}`;
    await db.execute(sql`
      INSERT INTO playlists (uuid, board_type, layout_id, name, is_public)
      VALUES (${specificLayoutPlaylist}, 'kilter', 9, 'Kilter layout 9 playlist', false)
    `);
    const [{ id: specificLayoutPlaylistId }] = Array.from(
      (await db.execute(sql`SELECT id FROM playlists WHERE uuid = ${specificLayoutPlaylist}`)) as Iterable<{
        id: number;
      }>,
    );
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id, role)
      VALUES (${specificLayoutPlaylistId}, ${OWNER_ID}, 'owner')
    `);

    try {
      await expect(
        playlistMutations.addClimbToPlaylist(
          null,
          { input: { playlistId: specificLayoutPlaylist, climbUuid: ALIAS_UUID, angle: 40 } },
          makeCtx(),
        ),
      ).rejects.toThrow('This playlist is for a different board');

      expect(await climbUuidsInPlaylist(specificLayoutPlaylist)).not.toContain(ALIAS_UUID);
    } finally {
      await db.execute(sql`DELETE FROM playlists WHERE uuid = ${specificLayoutPlaylist}`);
    }
  });

  // An alias uuid with a row under two boards resolves to two candidate
  // scopes. The guard accepts when ANY of them fits, so the verdict can't flip
  // with whichever row Postgres returns first — this test would be a coin flip
  // against an unordered LIMIT 1 lookup.
  it('accepts an alias uuid that resolves under two boards when one of them fits the playlist', async () => {
    const result = (await playlistMutations.addClimbToPlaylist(
      null,
      { input: { playlistId: KILTER_LAYOUT_8_PLAYLIST, climbUuid: AMBIGUOUS_ALIAS_UUID, angle: 40 } },
      makeCtx(),
    )) as { climbUuid: string };

    expect(result.climbUuid).toBe(AMBIGUOUS_ALIAS_UUID);
    expect(await climbUuidsInPlaylist(KILTER_LAYOUT_8_PLAYLIST)).toContain(AMBIGUOUS_ALIAS_UUID);
  });

  it('rejects an alias uuid whose every resolved board disagrees with the playlist', async () => {
    // Both of AMBIGUOUS_ALIAS_UUID's canonical climbs sit on layout 8, so a
    // Kilter layout-9 playlist matches neither.
    const layout9Playlist = `bg4015-amb-l9-${FIXTURE_RUN_ID}`;
    await db.execute(sql`
      INSERT INTO playlists (uuid, board_type, layout_id, name, is_public)
      VALUES (${layout9Playlist}, 'kilter', 9, 'Kilter layout 9 playlist', false)
    `);
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id, role)
      SELECT id, ${OWNER_ID}, 'owner' FROM playlists WHERE uuid = ${layout9Playlist}
    `);

    try {
      await expect(
        playlistMutations.addClimbToPlaylist(
          null,
          { input: { playlistId: layout9Playlist, climbUuid: AMBIGUOUS_ALIAS_UUID, angle: 40 } },
          makeCtx(),
        ),
      ).rejects.toThrow('This playlist is for a different board');

      expect(await climbUuidsInPlaylist(layout9Playlist)).not.toContain(AMBIGUOUS_ALIAS_UUID);
    } finally {
      await db.execute(sql`DELETE FROM playlists WHERE uuid = ${layout9Playlist}`);
    }
  });
});
