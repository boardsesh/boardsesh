import { and, eq, inArray, ne, notExists, type SQL } from 'drizzle-orm';
import { QueryBuilder, type PgDatabase, type PgQueryResultHKT } from 'drizzle-orm/pg-core';

import { playlists, playlistOwnership } from '../../schema/app/playlists';

type OwnerQueryDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * The only two columns these helpers may key on. Narrower than `PgColumn` on
 * purpose: a bare column type also accepts `playlists.id` (and types the
 * selected value as `unknown`), which would compile fine and silently look up
 * the wrong thing.
 */
type UpstreamIdColumn = typeof playlists.kilterId | typeof playlists.auroraId;

/**
 * Shared ownership arbitration for playlists that carry an UPSTREAM circuit id
 * (`playlists.kilter_id` / `playlists.aurora_id`).
 *
 * Both columns are backed by a GLOBAL unique index (`playlists_kilter_id_idx`,
 * `playlists_aurora_id_idx`) — a given upstream circuit uuid lives on at most
 * one playlist row table-wide, with no user scoping. Fine while one upstream
 * account maps to one Boardsesh user, actively dangerous once it doesn't: an
 * `ON CONFLICT (kilter_id) DO UPDATE` run for user B lands on user A's row, and
 * the ownership insert that follows hands B an `owner` edge on A's playlist
 * (#3526).
 *
 * Lives here rather than in either sync package because FOUR writers need the
 * identical guard: kilter-sync's applyCircuits, aurora-sync's user-sync
 * circuits case, aurora-sync's json-import, and the legacy web proxy route.
 * The decision logic itself is drizzle-free and lives in
 * `@boardsesh/sync-runtime`; this module is just the SQL half.
 */

/** How many upstream ids to probe per statement — see selectUpstreamPlaylistOwners. */
const OWNER_LOOKUP_CHUNK = 500;

/**
 * `ON CONFLICT (<upstream id>) DO UPDATE … WHERE` guard: "nobody OTHER than
 * this user holds an `owner` edge on the conflicting playlist".
 *
 * Correlated to `playlists.id`, which inside a DO UPDATE resolves to the
 * EXISTING row — that is what makes it a valid statement-time re-check. It is
 * the SQL-level twin of the JS decision gate each caller runs first, and closes
 * the window the JS check can't: two daemons syncing two Boardsesh users on the
 * same upstream account both read "no playlist yet", both INSERT, and the
 * loser's ON CONFLICT adopts the winner's row. #3539 (no cross-instance mutual
 * exclusion for sync daemons) widens that window, so this is load-bearing until
 * that lands.
 *
 * When it bites, DO UPDATE matches nothing and `.returning()` comes back empty
 * — every caller must handle the empty-array case.
 *
 * Built with a standalone `QueryBuilder`: it only renders, it never executes,
 * so it needs no connection, and unit tests can drive it through `PgDialect`
 * without a database.
 */
export function foreignPlaylistOwnerGuard(userId: string): SQL {
  return notExists(
    new QueryBuilder()
      .select({ userId: playlistOwnership.userId })
      .from(playlistOwnership)
      .where(
        and(
          eq(playlistOwnership.playlistId, playlists.id),
          eq(playlistOwnership.role, 'owner'),
          ne(playlistOwnership.userId, userId),
        ),
      ),
  );
}

/**
 * Correlated probe for "THIS user holds an `owner` edge on the playlist".
 * Pair it with `exists(...)` and `foreignPlaylistOwnerGuard` to express
 * sole ownership in a statement's WHERE clause.
 */
export function myPlaylistOwnerEdge(userId: string) {
  return new QueryBuilder()
    .select({ userId: playlistOwnership.userId })
    .from(playlistOwnership)
    .where(
      and(
        eq(playlistOwnership.playlistId, playlists.id),
        eq(playlistOwnership.role, 'owner'),
        eq(playlistOwnership.userId, userId),
      ),
    );
}

/**
 * upstream circuit id → the user ids holding an `owner` edge on the matching
 * playlist. Feed the result straight into `resolveUpstreamPlaylistWrite`.
 *
 * `upstreamIdColumn` is `playlists.kilterId` or `playlists.auroraId`.
 *
 * `role = 'owner'` is the filter on purpose: `editor` / `viewer` rows must
 * never block the owner's sync. The join is LEFT so a playlist with no
 * ownership row at all still comes back with an empty owner list — that's an
 * orphan, which is claimable, not foreign.
 */
export async function selectUpstreamPlaylistOwners(
  db: OwnerQueryDb,
  upstreamIdColumn: UpstreamIdColumn,
  upstreamIds: string[],
): Promise<Map<string, string[]>> {
  const ownersByUpstreamId = new Map<string, string[]>();
  // drizzle's inArray([]) emits invalid `IN ()` SQL that throws at the DB.
  if (upstreamIds.length === 0) return ownersByUpstreamId;

  // Chunked so one enormous circuit batch can't push the statement past
  // Postgres' 65535-parameter ceiling — the same bound the playlist_climbs
  // insert respects. Sequential, not Promise.all: callers may hand us a
  // transaction handle, and a Drizzle transaction rides a single connection
  // that PgBouncer (transaction pooling, our prod shape) cannot multiplex.
  for (let offset = 0; offset < upstreamIds.length; offset += OWNER_LOOKUP_CHUNK) {
    const chunk = upstreamIds.slice(offset, offset + OWNER_LOOKUP_CHUNK);
    // Awaits the SAME expression the tests render — see
    // upstreamPlaylistOwnersQuery. Deliberately not a hand-written copy of the
    // query alongside a lookalike test double: an identical-by-inspection twin
    // drifts the moment someone edits one side, and the drift tests would miss
    // is exactly the dangerous one (dropping `role = 'owner'`, or turning the
    // LEFT JOIN into an INNER JOIN, silently empties or widens the owner set).
    const rows = await upstreamPlaylistOwnersQuery(db, upstreamIdColumn, chunk);

    for (const row of rows) {
      if (typeof row.upstreamId !== 'string') continue;
      let owners = ownersByUpstreamId.get(row.upstreamId);
      if (!owners) {
        owners = [];
        ownersByUpstreamId.set(row.upstreamId, owners);
      }
      if (typeof row.ownerUserId === 'string') owners.push(row.ownerUserId);
    }
  }

  return ownersByUpstreamId;
}

/**
 * The owner lookup for one chunk. `selectUpstreamPlaylistOwners` awaits exactly
 * this — it is the executed query, not a test double.
 *
 * Split out so unit tests can render it. The sync packages drive the select
 * through hand-rolled stubs that ignore SQL entirely, so without a seam like
 * this the `role = 'owner'` filter, the LEFT JOIN and the upstream column have
 * no coverage at all: deleting any of them keeps every stub-based test green.
 * A test passes a driverless drizzle handle and calls `.toSQL()`.
 */
export function upstreamPlaylistOwnersQuery(
  db: OwnerQueryDb,
  upstreamIdColumn: UpstreamIdColumn,
  upstreamIds: string[],
) {
  return db
    .select({ upstreamId: upstreamIdColumn, ownerUserId: playlistOwnership.userId })
    .from(playlists)
    .leftJoin(
      playlistOwnership,
      and(eq(playlistOwnership.playlistId, playlists.id), eq(playlistOwnership.role, 'owner')),
    )
    .where(inArray(upstreamIdColumn, upstreamIds));
}
