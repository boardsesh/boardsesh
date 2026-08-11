import { describe, it, expect, beforeEach, afterAll } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';

// Integration test (real DB) for #4011: offset-paginated playlist listing
// queries (discoverPlaylists, searchPlaylists, allUserPlaylists) previously
// ordered only by columns that tie in the common case (nightly recommendation
// batch upserts share createdAt; most playlists share a climb count), so rows
// could repeat or vanish across pages. Fixed by appending playlists.id as a
// final deterministic tiebreak. Also covers the discoverPlaylists name filter
// and playlistCreators searchQuery LIKE-escaping fix (search.ts already
// escaped; discover.ts did not).

const OWNER_ID = 'user-123'; // seeded by setup.ts
const CREATOR_PERCENT_ID = 'user-creator-percent';
const CREATOR_X_ID = 'user-creator-x';
const TIED_TIMESTAMP = '2026-08-01T00:00:00Z';

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    isAuthenticated: true,
    userId: OWNER_ID,
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    ...overrides,
  } as ConnectionContext;
}

/** Seed `count` public playlists that all tie on createdAt/updatedAt and climb count. */
async function seedTiedPublicPlaylists(count: number, namePrefix: string): Promise<string[]> {
  const uuids: string[] = [];
  for (let i = 0; i < count; i++) {
    const uuid = `${namePrefix}-${i}`;
    uuids.push(uuid);
    const result = await db.execute(sql`
      INSERT INTO playlists (uuid, board_type, layout_id, name, is_public, created_at, updated_at)
      VALUES (${uuid}, 'kilter', 1, ${`${namePrefix} ${i}`}, true, ${TIED_TIMESTAMP}, ${TIED_TIMESTAMP})
      RETURNING id
    `);
    const playlistId = (result as unknown as { id: number | bigint }[])[0].id;
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id, role)
      VALUES (${playlistId}, ${OWNER_ID}, 'owner')
    `);
    await db.execute(sql`
      INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
      VALUES (${playlistId}, 'climb-shared', 40, 0)
    `);
  }
  return uuids;
}

describe('playlist listing pagination stability — real DB (#4011)', () => {
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE playlist_climbs, playlist_ownership, playlists RESTART IDENTITY CASCADE`);
    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES
        (${CREATOR_PERCENT_ID}, 'creator-percent@test.com', 'Bob%Percent', now(), now()),
        (${CREATOR_X_ID}, 'creator-x@test.com', 'BobXPercent', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
  });

  afterAll(async () => {
    await db.execute(sql`TRUNCATE TABLE playlist_climbs, playlist_ownership, playlists RESTART IDENTITY CASCADE`);
    // Deliberately not deleting the fixture creator users here: this table is
    // shared across test files in the worker DB (see setup.ts's TABLES_TO_RESET),
    // and a targeted DELETE racing another file's TRUNCATE ... CASCADE on `users`
    // deadlocks. Mirror setup.ts's user-123 pattern instead — leave these rows
    // in place; the ON CONFLICT DO NOTHING insert above makes reseeding idempotent.
  });

  describe('discoverPlaylists', () => {
    it('pages a fully-tied set (same createdAt/updatedAt/climbCount) with no repeats or gaps', async () => {
      const seededUuids = await seedTiedPublicPlaylists(6, 'discover-tied');
      const ctx = makeCtx({ isAuthenticated: false, userId: undefined });

      const seenUuids: string[] = [];
      for (let page = 0; page < 3; page++) {
        const result = await playlistQueries.discoverPlaylists(
          null,
          { input: { pageSize: 2, page, sortBy: 'recent' } },
          ctx,
        );
        const rows = result.playlists as { uuid: string }[];
        expect(rows.length).toBe(2);
        seenUuids.push(...rows.map((row) => row.uuid));
        expect(result.hasMore).toBe(page < 2);
      }

      expect(new Set(seenUuids).size).toBe(6);
      expect(seenUuids.sort()).toEqual([...seededUuids].sort());
    });

    it('pages a tied set under sortBy popular with no repeats or gaps', async () => {
      const seededUuids = await seedTiedPublicPlaylists(6, 'discover-popular-tied');
      const ctx = makeCtx({ isAuthenticated: false, userId: undefined });

      const seenUuids: string[] = [];
      for (let page = 0; page < 3; page++) {
        const result = await playlistQueries.discoverPlaylists(
          null,
          { input: { pageSize: 2, page, sortBy: 'popular' } },
          ctx,
        );
        const rows = result.playlists as { uuid: string }[];
        seenUuids.push(...rows.map((row) => row.uuid));
      }

      expect(new Set(seenUuids).size).toBe(6);
      expect(seenUuids.sort()).toEqual([...seededUuids].sort());
    });

    it('treats % in the name filter as a literal character, not a wildcard', async () => {
      const percentUuid = 'discover-literal-percent';
      const otherUuid = 'discover-literal-other';
      for (const [uuid, name] of [
        [percentUuid, 'a%b'],
        [otherUuid, 'axyzb'],
      ] as const) {
        const result = await db.execute(sql`
          INSERT INTO playlists (uuid, board_type, layout_id, name, is_public, created_at, updated_at)
          VALUES (${uuid}, 'kilter', 1, ${name}, true, ${TIED_TIMESTAMP}, ${TIED_TIMESTAMP})
          RETURNING id
        `);
        const playlistId = (result as unknown as { id: number | bigint }[])[0].id;
        await db.execute(sql`
          INSERT INTO playlist_ownership (playlist_id, user_id, role) VALUES (${playlistId}, ${OWNER_ID}, 'owner')
        `);
        await db.execute(sql`
          INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
          VALUES (${playlistId}, 'climb-shared', 40, 0)
        `);
      }

      const ctx = makeCtx({ isAuthenticated: false, userId: undefined });
      const result = await playlistQueries.discoverPlaylists(null, { input: { name: 'a%b' } }, ctx);
      const rows = result.playlists as { uuid: string }[];

      expect(rows.map((row) => row.uuid)).toEqual([percentUuid]);
    });

    it('treats _ in the name filter as a literal character, not a single-char wildcard', async () => {
      const underscoreUuid = 'discover-literal-underscore';
      const otherUuid = 'discover-literal-underscore-other';
      for (const [uuid, name] of [
        [underscoreUuid, 'c_d'],
        [otherUuid, 'ced'],
      ] as const) {
        const result = await db.execute(sql`
          INSERT INTO playlists (uuid, board_type, layout_id, name, is_public, created_at, updated_at)
          VALUES (${uuid}, 'kilter', 1, ${name}, true, ${TIED_TIMESTAMP}, ${TIED_TIMESTAMP})
          RETURNING id
        `);
        const playlistId = (result as unknown as { id: number | bigint }[])[0].id;
        await db.execute(sql`
          INSERT INTO playlist_ownership (playlist_id, user_id, role) VALUES (${playlistId}, ${OWNER_ID}, 'owner')
        `);
        await db.execute(sql`
          INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
          VALUES (${playlistId}, 'climb-shared', 40, 0)
        `);
      }

      const ctx = makeCtx({ isAuthenticated: false, userId: undefined });
      const result = await playlistQueries.discoverPlaylists(null, { input: { name: 'c_d' } }, ctx);
      const rows = result.playlists as { uuid: string }[];

      expect(rows.map((row) => row.uuid)).toEqual([underscoreUuid]);
    });
  });

  describe('playlistCreators', () => {
    it('treats % in searchQuery as a literal character, not a wildcard', async () => {
      for (const [uuid, ownerId] of [
        ['creator-search-percent', CREATOR_PERCENT_ID],
        ['creator-search-x', CREATOR_X_ID],
      ] as const) {
        const result = await db.execute(sql`
          INSERT INTO playlists (uuid, board_type, layout_id, name, is_public, created_at, updated_at)
          VALUES (${uuid}, 'kilter', 1, ${uuid}, true, ${TIED_TIMESTAMP}, ${TIED_TIMESTAMP})
          RETURNING id
        `);
        const playlistId = (result as unknown as { id: number | bigint }[])[0].id;
        await db.execute(sql`
          INSERT INTO playlist_ownership (playlist_id, user_id, role) VALUES (${playlistId}, ${ownerId}, 'owner')
        `);
        await db.execute(sql`
          INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
          VALUES (${playlistId}, 'climb-shared', 40, 0)
        `);
      }

      const ctx = makeCtx({ isAuthenticated: false, userId: undefined });
      const results = (await playlistQueries.playlistCreators(
        null,
        { input: { boardType: 'kilter', layoutId: 1, searchQuery: 'Bob%Percent' } },
        ctx,
      )) as { userId: string }[];

      expect(results.map((row) => row.userId)).toEqual([CREATOR_PERCENT_ID]);
    });
  });

  describe('searchPlaylists', () => {
    it('pages a fully-tied set (same createdAt/climbCount) with no repeats or gaps', async () => {
      const seededUuids = await seedTiedPublicPlaylists(6, 'search-tied');
      const ctx = makeCtx({ isAuthenticated: false, userId: undefined });

      const seenUuids: string[] = [];
      for (let offset = 0; offset < 6; offset += 2) {
        const result = await playlistQueries.searchPlaylists(
          null,
          { input: { query: 'search-tied', limit: 2, offset } },
          ctx,
        );
        const rows = result.playlists as { uuid: string }[];
        expect(rows.length).toBe(2);
        seenUuids.push(...rows.map((row) => row.uuid));
      }

      expect(new Set(seenUuids).size).toBe(6);
      expect(seenUuids.sort()).toEqual([...seededUuids].sort());
    });

    it('treats % in the query as a literal character, not a wildcard', async () => {
      const percentUuid = 'search-literal-percent';
      const otherUuid = 'search-literal-other';
      for (const [uuid, name] of [
        [percentUuid, 'search-a%b'],
        [otherUuid, 'search-axyzb'],
      ] as const) {
        const result = await db.execute(sql`
          INSERT INTO playlists (uuid, board_type, layout_id, name, is_public, created_at, updated_at)
          VALUES (${uuid}, 'kilter', 1, ${name}, true, ${TIED_TIMESTAMP}, ${TIED_TIMESTAMP})
          RETURNING id
        `);
        const playlistId = (result as unknown as { id: number | bigint }[])[0].id;
        await db.execute(sql`
          INSERT INTO playlist_ownership (playlist_id, user_id, role) VALUES (${playlistId}, ${OWNER_ID}, 'owner')
        `);
        await db.execute(sql`
          INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
          VALUES (${playlistId}, 'climb-shared', 40, 0)
        `);
      }

      const ctx = makeCtx({ isAuthenticated: false, userId: undefined });
      const result = await playlistQueries.searchPlaylists(null, { input: { query: 'search-a%b' } }, ctx);
      const rows = result.playlists as { uuid: string }[];

      expect(rows.map((row) => row.uuid)).toEqual([percentUuid]);
    });
  });

  describe('allUserPlaylists', () => {
    it('pages a fully-tied set (same lastAccessedAt/updatedAt) with no repeats or gaps', async () => {
      const seededUuids = await seedTiedPublicPlaylists(6, 'library-tied');
      const ctx = makeCtx();

      const seenUuids: string[] = [];
      for (let page = 0; page < 3; page++) {
        const result = await playlistQueries.allUserPlaylists(null, { input: { pageSize: 2, page } }, ctx);
        const rows = result.playlists as { uuid: string }[];
        expect(rows.length).toBe(2);
        seenUuids.push(...rows.map((row) => row.uuid));
        expect(result.hasMore).toBe(page < 2);
      }

      expect(new Set(seenUuids).size).toBe(6);
      expect(seenUuids.sort()).toEqual([...seededUuids].sort());
    });
  });
});
