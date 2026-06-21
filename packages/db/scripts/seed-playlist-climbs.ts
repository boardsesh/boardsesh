/**
 * Seed (and backfill) real climbs into the test user's playlists.
 *
 * Two entry points share one deterministic selection helper:
 *   - `create-test-user.ts` calls `seedPlaylistClimbs()` per playlist while
 *     building the dev-DB image, so a freshly built image already has full
 *     playlists.
 *   - Running THIS file directly is a stopgap: it backfills climbs into the
 *     test user's existing playlists against an already-running dev-DB
 *     container, so we don't have to rebuild the docker image to get content
 *     onto the Discover / play screens. Once the dev-db image is rebuilt with
 *     create-test-user.ts running this logic at build time, the standalone
 *     run becomes unnecessary.
 *
 * Scope: this backfills CLIMBS only. Playlist visibility (`isPublic`, which
 * decides what Discover shows) is owned by `create-test-user.ts`. On an existing
 * container built from an older image, re-run `create-test-user.ts` (its upsert
 * now converges `isPublic`) — or rebuild the dev-DB image — so the public
 * Tension/Kilter playlists actually surface in Discover.
 *
 * Run the stopgap: `node --import tsx packages/db/scripts/seed-playlist-climbs.ts`
 *
 * Determinism: selection is `ORDER BY ascensionist_count DESC NULLS LAST,
 * uuid ASC` (uuid is the stable tie-breaker) and the per-playlist count is
 * derived from the playlist row id — no randomness, no Date.now(). The dev DB
 * is a pre-built image, so the seed must be byte-stable across rebuilds.
 */
import { pathToFileURL } from 'node:url';
import { and, asc, eq, sql } from 'drizzle-orm';
import { createScriptDb, getScriptDatabaseUrl } from './db-connection.js';
import { playlists, playlistClimbs, playlistOwnership } from '../src/schema/app/playlists.js';
import { boardClimbs, boardClimbStats } from '../src/schema/boards/unified.js';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

// Angle the playlist climbs are stored at. 40° is the canonical default the
// rest of the app falls back to, so the play/board screens render consistent
// holds without a per-climb angle lookup.
const DEFAULT_PLAYLIST_ANGLE = 40;

// Bounds for the deterministic per-playlist climb count (inclusive). Varying
// the size between playlists makes the Discover/library grid look real instead
// of every card reading the same number.
export const MIN_CLIMBS_PER_PLAYLIST = 8;
export const MAX_CLIMBS_PER_PLAYLIST = 20;

type ScriptDb = ReturnType<typeof createScriptDb>['db'];

type PlaylistClimbTarget = {
  playlistId: bigint;
  boardType: string;
  layoutId: number | null;
};

/**
 * Deterministic climb count for a playlist, derived from its row id so the
 * same playlist always gets the same number of climbs (8–20) across rebuilds.
 */
export function climbCountForPlaylist(playlistId: bigint): number {
  const span = MAX_CLIMBS_PER_PLAYLIST - MIN_CLIMBS_PER_PLAYLIST + 1;
  // playlistId is a bigint; reduce it into the span without precision loss.
  const offset = Number(((playlistId % BigInt(span)) + BigInt(span)) % BigInt(span));
  return MIN_CLIMBS_PER_PLAYLIST + offset;
}

/**
 * Select a deterministic set of real, displayable climb UUIDs for a playlist.
 *
 * Filters to listed, non-draft climbs that have a `board_climb_stats` row at
 * the default angle (so difficulty / quality / stars render). Matches the
 * playlist's boardType and — when set — its layoutId. Aurora-synced playlists
 * have `layoutId === null`; those match on boardType only (the resolver and
 * hydrate path don't constrain those climbs to a layout).
 *
 * Ordered by ascensionist_count DESC (popular climbs make better screenshots)
 * with uuid ASC as the stable tie-breaker, so the result is byte-stable.
 */
async function selectClimbUuids(db: ScriptDb, target: PlaylistClimbTarget, limit: number): Promise<string[]> {
  const conditions = [
    eq(boardClimbs.boardType, target.boardType),
    eq(boardClimbs.isListed, true),
    eq(boardClimbs.isDraft, false),
  ];
  if (target.layoutId != null) {
    conditions.push(eq(boardClimbs.layoutId, target.layoutId));
  }

  // The inner join is 1:1 (board_climb_stats PK is board_type+climb_uuid+angle,
  // and board_climbs.uuid is unique), so each climb yields exactly one row —
  // no DISTINCT needed.
  const rows = await db
    .select({
      uuid: boardClimbs.uuid,
      ascensionistCount: boardClimbStats.ascensionistCount,
    })
    .from(boardClimbs)
    .innerJoin(
      boardClimbStats,
      and(
        eq(boardClimbStats.boardType, boardClimbs.boardType),
        eq(boardClimbStats.climbUuid, boardClimbs.uuid),
        eq(boardClimbStats.angle, DEFAULT_PLAYLIST_ANGLE),
      ),
    )
    .where(and(...conditions))
    // ascents DESC for popular climbs; uuid ASC is the deterministic
    // tie-breaker. NULLS LAST keeps any stat-less rows from sorting first.
    .orderBy(sql`${boardClimbStats.ascensionistCount} DESC NULLS LAST`, asc(boardClimbs.uuid))
    .limit(limit);

  return rows.map((row) => row.uuid);
}

/**
 * Insert deterministic playlist_climbs rows for a single playlist.
 * Idempotent via onConflictDoNothing on the (playlist_id, climb_uuid) unique
 * index, so re-running (image rebuild or stopgap) never duplicates rows.
 * Returns the number of climb refs selected for this playlist.
 */
export async function seedPlaylistClimbs(db: ScriptDb, target: PlaylistClimbTarget): Promise<number> {
  const limit = climbCountForPlaylist(target.playlistId);
  const climbUuids = await selectClimbUuids(db, target, limit);
  if (climbUuids.length === 0) {
    // Most likely: the board/layout has no board_climb_stats row at
    // DEFAULT_PLAYLIST_ANGLE (40°), so the inner join matched nothing. Flag it so
    // a silently-empty playlist on a newly-added layout is distinguishable from
    // an intentional skip. Validated layouts (Kilter/Tension) have 40° stats.
    console.warn(
      `No displayable climbs at ${DEFAULT_PLAYLIST_ANGLE}° for playlist ${target.playlistId} ` +
        `(boardType=${target.boardType}, layoutId=${target.layoutId ?? 'null'}); leaving it empty.`,
    );
    return 0;
  }

  await db
    .insert(playlistClimbs)
    .values(
      climbUuids.map((climbUuid, position) => ({
        playlistId: target.playlistId,
        climbUuid,
        angle: DEFAULT_PLAYLIST_ANGLE,
        position,
      })),
    )
    .onConflictDoNothing({ target: [playlistClimbs.playlistId, playlistClimbs.climbUuid] });

  return climbUuids.length;
}

/**
 * Stopgap entry point: backfill climbs into the test user's existing playlists
 * against an already-running dev DB. Looks up the playlists the test user owns
 * and seeds each one. Safe to re-run.
 */
async function backfillTestUserPlaylistClimbs(): Promise<void> {
  const databaseUrl = getScriptDatabaseUrl();
  const dbHost = databaseUrl.split('@')[1]?.split('/')[0] || 'unknown';
  console.info(`Backfilling playlist climbs on: ${dbHost}`);

  const { db, close } = createScriptDb(databaseUrl);

  try {
    const ownedPlaylists = await db
      .select({
        playlistId: playlists.id,
        boardType: playlists.boardType,
        layoutId: playlists.layoutId,
      })
      .from(playlists)
      .innerJoin(playlistOwnership, eq(playlistOwnership.playlistId, playlists.id))
      .where(and(eq(playlistOwnership.userId, TEST_USER_ID), eq(playlistOwnership.role, 'owner')))
      .orderBy(asc(playlists.id));

    let totalClimbs = 0;
    for (const playlist of ownedPlaylists) {
      totalClimbs += await seedPlaylistClimbs(db, {
        playlistId: playlist.playlistId,
        boardType: playlist.boardType,
        layoutId: playlist.layoutId,
      });
    }

    console.info(`Backfilled ${totalClimbs} climbs across ${ownedPlaylists.length} test-user playlists.`);
    await close();
    process.exit(0);
  } catch (error) {
    console.error('Failed to backfill playlist climbs:', error);
    await close();
    process.exit(1);
  }
}

// Only run the stopgap when invoked directly, not when imported by
// create-test-user.ts. `import.meta.url` resolves to this file's URL; compare it
// to the process entrypoint via pathToFileURL so paths with spaces or special
// characters still match (a bare `file://${argv[1]}` template doesn't encode them).
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void backfillTestUserPlaylistClimbs();
}
