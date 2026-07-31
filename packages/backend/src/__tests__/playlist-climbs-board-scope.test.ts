import { describe, it, expect, beforeAll } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';

// Seeds use raw `sql` rather than `db.insert(...)` because the integration test
// DB is built from a minimal hand-maintained DDL (schema-sql.ts), not the full
// Drizzle schema — the query builder emits every default-bearing column which
// that DDL omits, so a builder insert fails. Naming only the columns the test
// DDL declares is the genuine raw-SQL exception.

// Integration test (real DB) for #3891: specific-board mode size-filters the
// climb join on `compatible_size_ids`. MoonBoard has one fixed product size, so
// its climbs carry NULL there — and the old `sizeId = ANY(NULL)` predicate is
// NULL, never true, so every MoonBoard row was dropped. A MoonBoard playlist
// therefore returned zero climbs to the play drawer's queue-replacement fetch
// while the (all-boards-mode) detail list looked fine, and swiping in the drawer
// had a one-item queue to walk.
//
// The pair "MoonBoard climbs come back" + "a size-incompatible Kilter climb is
// still excluded" is load-bearing: either alone is satisfied by deleting the
// predicate outright.
//
// Once MoonBoard rows reach this join they also have to be scoped to the hold sets
// the wall actually has, which is what `required_set_ids` encodes for MoonBoard's
// optional wooden / screw-on add-ons — so the set-filtering cases below run against
// the real query too, not a predicate rebuilt in the test.

const MOONBOARD_PLAYLIST_UUID = 'pl-board-scope-moon';
const KILTER_PLAYLIST_UUID = 'pl-board-scope-kilter';
const MOONBOARD_SETS_PLAYLIST_UUID = 'pl-board-scope-moon-sets';
const MOONBOARD_SIZE_ID = 1;
const KILTER_SIZE_ID = 25;

// Stand-ins for a MoonBoard's base grid plus its optional add-on sets. A wall
// built without the wooden holds sends only `MOONBOARD_BASE_SET_ID`.
const MOONBOARD_BASE_SET_ID = 20;
const MOONBOARD_WOODEN_SET_ID = 21;

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    isAuthenticated: false,
    userId: null,
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    ...overrides,
  } as ConnectionContext;
}

async function seedClimb(
  boardType: string,
  uuid: string,
  name: string,
  layoutId: number,
  compatibleSizeIds: number[] | null,
  requiredSetIds: number[] | null = null,
) {
  // Bind the array as a Postgres array literal cast to int[] — a JS array bound
  // directly is expanded into a `(a, b, c)` record by the driver.
  const sizeIdsLiteral = compatibleSizeIds === null ? null : `{${compatibleSizeIds.join(',')}}`;
  const setIdsLiteral = requiredSetIds === null ? null : `{${requiredSetIds.join(',')}}`;
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed, compatible_size_ids, required_set_ids)
    VALUES (${uuid}, ${boardType}, ${layoutId}, 'setter', ${name}, '', 'p1r1', true, ${sizeIdsLiteral}::int[], ${setIdsLiteral}::int[])
  `);
}

async function seedStats(boardType: string, uuid: string, angle: number) {
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, difficulty_average, quality_average, ascensionist_count, benchmark_difficulty)
    VALUES (${boardType}, ${uuid}, ${angle}, 18, 18, 3.0, 10, 0)
  `);
}

describe('playlistClimbs — board-scoped size and hold-set filtering (real DB)', () => {
  beforeAll(async () => {
    // Playlist tables aren't in the global per-file reset list, so own the cleanup.
    await db.execute(sql`TRUNCATE TABLE playlist_climbs, playlist_ownership, playlists RESTART IDENTITY CASCADE`);

    // MoonBoard: one fixed size, so the ingest leaves compatible_size_ids NULL.
    await seedClimb('moonboard', 'moon-1', 'Moon One', 7, null);
    await seedClimb('moonboard', 'moon-2', 'Moon Two', 7, null);
    await seedStats('moonboard', 'moon-1', 40);
    await seedStats('moonboard', 'moon-2', 40);

    // Kilter: real size variants. `kilter-fits` is climbable on the queried size
    // (among others), `kilter-other` is not.
    await seedClimb('kilter', 'kilter-fits', 'Fits This Size', 1, [7, KILTER_SIZE_ID, 28]);
    await seedClimb('kilter', 'kilter-other', 'Different Size Only', 1, [99]);
    await seedStats('kilter', 'kilter-fits', 40);
    await seedStats('kilter', 'kilter-other', 40);

    // MoonBoard hold sets: the base grid is always installed, the wooden add-on
    // only on some walls. `moon-sets-null` stands for a row the required-set-ids
    // backfill hasn't reached yet.
    await seedClimb('moonboard', 'moon-sets-base', 'Base Holds Only', 7, null, [MOONBOARD_BASE_SET_ID]);
    await seedClimb('moonboard', 'moon-sets-wooden', 'Needs Wooden Holds', 7, null, [
      MOONBOARD_BASE_SET_ID,
      MOONBOARD_WOODEN_SET_ID,
    ]);
    await seedClimb('moonboard', 'moon-sets-null', 'Not Backfilled Yet', 7, null, null);
    await seedStats('moonboard', 'moon-sets-base', 40);
    await seedStats('moonboard', 'moon-sets-wooden', 40);
    await seedStats('moonboard', 'moon-sets-null', 40);

    // Explicit ids keep the playlist_climbs FK references trivial; the TRUNCATE
    // ... RESTART IDENTITY above frees ids 1, 2 and 3.
    await db.execute(sql`
      INSERT INTO playlists (id, uuid, board_type, layout_id, name, is_public)
      VALUES (1, ${MOONBOARD_PLAYLIST_UUID}, 'moonboard', 7, 'Minimoon circuit', true),
             (2, ${KILTER_PLAYLIST_UUID}, 'kilter', 1, 'Kilter sizes', true),
             (3, ${MOONBOARD_SETS_PLAYLIST_UUID}, 'moonboard', 7, 'Wooden hold session', true)
    `);
    await db.execute(sql`
      INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
      VALUES (1, 'moon-1', 40, 0), (1, 'moon-2', 40, 1),
             (2, 'kilter-fits', 40, 0), (2, 'kilter-other', 40, 1),
             (3, 'moon-sets-base', 40, 0), (3, 'moon-sets-wooden', 40, 1), (3, 'moon-sets-null', 40, 2)
    `);
  });

  it('returns a MoonBoard playlist’s climbs in board-scoped mode, in position order', async () => {
    const result = await playlistQueries.playlistClimbs(
      null,
      {
        input: {
          playlistId: MOONBOARD_PLAYLIST_UUID,
          boardName: 'moonboard',
          layoutId: 7,
          sizeId: MOONBOARD_SIZE_ID,
          angle: 40,
        },
      },
      makeCtx(),
    );

    // Before the fix this was `[]` while totalCount said 2 — the play drawer then
    // built a one-item queue and prev/next had nowhere to go.
    expect(result.climbs.map((climb) => climb.uuid)).toEqual(['moon-1', 'moon-2']);
    expect(result.totalCount).toBe(2);
  });

  it('still excludes a Kilter climb that does not fit the requested size', async () => {
    const result = await playlistQueries.playlistClimbs(
      null,
      {
        input: {
          playlistId: KILTER_PLAYLIST_UUID,
          boardName: 'kilter',
          layoutId: 1,
          sizeId: KILTER_SIZE_ID,
          angle: 40,
        },
      },
      makeCtx(),
    );

    // The size filter must still bite on size-scoped boards: `kilter-other` is
    // only climbable on size 99. Deleting the predicate (rather than gating it on
    // board type) would make the MoonBoard case above pass and break this one.
    expect(result.climbs.map((climb) => climb.uuid)).toEqual(['kilter-fits']);
    // #4000: totalCount must respect the same size filter as `climbs`. The
    // playlist has 2 rows in `playlist_climbs` (`kilter-fits` + `kilter-other`),
    // but only 1 fits this size — before the fix totalCount reported 2, so a
    // paginating client would expect a second page that could never arrive.
    expect(result.totalCount).toBe(1);
  });

  it('keeps a size-compatible Kilter climb whose array holds several sizes', async () => {
    // Pins the array-containment direction of the `= ANY(...)` → `@> ARRAY[...]`
    // rewrite: the requested size is one element of a multi-element array, not the
    // whole array.
    const result = await playlistQueries.playlistClimbs(
      null,
      { input: { playlistId: KILTER_PLAYLIST_UUID, boardName: 'kilter', layoutId: 1, sizeId: 7, angle: 40 } },
      makeCtx(),
    );

    expect(result.climbs.map((climb) => climb.uuid)).toEqual(['kilter-fits']);
  });

  it('drops a MoonBoard climb needing a hold set the wall does not have', async () => {
    // A MoonBoard without the wooden add-on sends only the base set. `moon-sets-wooden`
    // needs both, so queueing it would light a problem with holes in it.
    const result = await playlistQueries.playlistClimbs(
      null,
      {
        input: {
          playlistId: MOONBOARD_SETS_PLAYLIST_UUID,
          boardName: 'moonboard',
          layoutId: 7,
          sizeId: MOONBOARD_SIZE_ID,
          setIds: String(MOONBOARD_BASE_SET_ID),
          angle: 40,
        },
      },
      makeCtx(),
    );

    // `moon-sets-null` rides along: NULL required sets means "not backfilled", not
    // "needs nothing installed", and a hand-curated playlist shouldn't lose a climb
    // over missing denormalised data.
    expect(result.climbs.map((climb) => climb.uuid)).toEqual(['moon-sets-base', 'moon-sets-null']);
    // #4000: the playlist has 3 rows, but `moon-sets-wooden` fails the hold-set
    // filter, so totalCount must be 2 to match `climbs`, not the raw row count.
    expect(result.totalCount).toBe(2);
  });

  it('keeps every MoonBoard climb once the wooden holds are installed', async () => {
    // Same playlist, same climbs, wooden set selected — the pair with the test above
    // is what stops the filter being satisfied by a predicate that always excludes.
    const result = await playlistQueries.playlistClimbs(
      null,
      {
        input: {
          playlistId: MOONBOARD_SETS_PLAYLIST_UUID,
          boardName: 'moonboard',
          layoutId: 7,
          sizeId: MOONBOARD_SIZE_ID,
          setIds: `${MOONBOARD_BASE_SET_ID},${MOONBOARD_WOODEN_SET_ID}`,
          angle: 40,
        },
      },
      makeCtx(),
    );

    expect(result.climbs.map((climb) => climb.uuid)).toEqual(['moon-sets-base', 'moon-sets-wooden', 'moon-sets-null']);
    expect(result.totalCount).toBe(3);
  });

  it('leaves the playlist whole when the caller sends no set ids', async () => {
    // Web's all-boards list and any caller that omits setIds must not start losing
    // climbs — the filter only applies to a caller that told us what is installed.
    const result = await playlistQueries.playlistClimbs(
      null,
      {
        input: {
          playlistId: MOONBOARD_SETS_PLAYLIST_UUID,
          boardName: 'moonboard',
          layoutId: 7,
          sizeId: MOONBOARD_SIZE_ID,
          angle: 40,
        },
      },
      makeCtx(),
    );

    expect(result.climbs.map((climb) => climb.uuid)).toEqual(['moon-sets-base', 'moon-sets-wooden', 'moon-sets-null']);
    expect(result.totalCount).toBe(3);
  });

  it('keeps Kilter climbs whose required sets have not been backfilled', async () => {
    // The deliberate divergence from climb search, which excludes NULL required sets
    // on Aurora boards. Here a NULL means the denormalisation hasn't run, and the
    // climber put this climb in the list themselves.
    const result = await playlistQueries.playlistClimbs(
      null,
      {
        input: {
          playlistId: KILTER_PLAYLIST_UUID,
          boardName: 'kilter',
          layoutId: 1,
          sizeId: KILTER_SIZE_ID,
          setIds: '1,20',
          angle: 40,
        },
      },
      makeCtx(),
    );

    expect(result.climbs.map((climb) => climb.uuid)).toEqual(['kilter-fits']);
  });

  it('agrees with all-boards mode about which MoonBoard climbs are in the playlist', async () => {
    // The user-visible invariant behind the bug report: the detail list
    // (all-boards mode) and the play drawer's queue fetch (board-scoped mode)
    // must contain the same climbs, however each is implemented.
    const boardScoped = await playlistQueries.playlistClimbs(
      null,
      {
        input: {
          playlistId: MOONBOARD_PLAYLIST_UUID,
          boardName: 'moonboard',
          layoutId: 7,
          sizeId: MOONBOARD_SIZE_ID,
          angle: 40,
        },
      },
      makeCtx(),
    );
    const allBoards = await playlistQueries.playlistClimbs(
      null,
      { input: { playlistId: MOONBOARD_PLAYLIST_UUID, activeBoardName: 'moonboard', activeAngle: 40 } },
      makeCtx(),
    );

    expect(new Set(boardScoped.climbs.map((climb) => climb.uuid))).toEqual(
      new Set(allBoards.climbs.map((climb) => climb.uuid)),
    );
  });
});
