/**
 * The ONE table → React Query invalidation-key map.
 *
 * Two consumers, one source: `sync/table-config.ts` (a completed pull of a table)
 * and `mutation-queue/drainer.ts` (a queued write for that table reaching the
 * server). They used to carry near-duplicate copies and both drifted the same
 * way — `['ticks']`, `['playlists']`, `['favorites']`, `['setterFollows']` and
 * `['playlistFollows']` are keys **no reader ever used**, so a completed sync
 * silently refreshed almost nothing. `invalidate-keys-drift.test.ts` now fails
 * when a key here has no reader, and asserts both consumers import this module.
 *
 * A key is a **prefix**: `invalidateQueries({ queryKey: ['logbook'] })` matches
 * every `['logbook', boardName, …]`. And `invalidateQueries` refetches ACTIVE
 * queries only, so the cost of a correct key is bounded to what is on screen.
 * The pull client already gates the whole loop on `totalProcessed > 0`, so a
 * cycle that moved zero rows invalidates nothing at all.
 */
export type InvalidateKeys = readonly (readonly string[])[];

export const TABLE_INVALIDATE_KEYS: Record<string, InvalidateKeys> = {
  // ['logbook'] — the climb-detail / climb-list logbook accumulator
  // (logbook-keys.ts builds ['logbook', boardName, …]).
  // ['localTicks'] — the "waiting to sync" badge clears once a tick lands.
  // ['climb'] — the detail's server-side ascent + vote counts.
  // ['userTicks'] — the You tab's per-board tick fan-out (use-you-data.ts).
  // ['searchClimbs'] / ['infiniteSearchClimbs'] / ['searchClimbsCount'] — a tick
  //   at a new angle grades a stats row server-side; the drainer fires these
  //   once the tick lands so the list refetches (the pull path is already
  //   covered by the board_climb_stats entry below).
  boardsesh_ticks: [
    ['logbook'],
    ['localTicks'],
    ['climb'],
    ['userTicks'],
    ['searchClimbs'],
    ['infiniteSearchClimbs'],
    ['searchClimbsCount'],
  ],

  // ['userPlaylists'] — the owned-playlist list (use-mobile-climb-actions-data).
  // ['playlistClimbs'] — a playlist's climb rows (@boardsesh/playlists-react).
  // ['playlist'] — the detail row, which also carries isPinnedByMe /
  //   isFollowedByMe / followerCount.
  playlists: [['userPlaylists'], ['playlistClimbs'], ['playlist']],
  playlist_climbs: [['userPlaylists'], ['playlistClimbs'], ['playlist']],
  user_playlist_pins: [['userPlaylists'], ['playlist']],

  // ['searchClimbs'] / ['infiniteSearchClimbs'] — the heart on each list row.
  // ['favoriteStatus'] — the per-climb heart, which must refetch AFTER a queued
  //   favorite lands: the optimistic write at enqueue time can otherwise be
  //   overwritten by a network refetch that raced the drain.
  user_favorites: [['searchClimbs'], ['infiniteSearchClimbs'], ['favoriteStatus']],

  // Follow changes affect Following searches on every board. This platform-neutral
  // table map knows query prefixes, not each client's filter-bearing key shape,
  // so it deliberately invalidates unfiltered searches too. Only active queries
  // refetch; inactive searches are marked stale until the next visit.
  user_follows: [
    ['publicProfile'],
    ['searchUsers'],
    ['followers'],
    ['following'],
    ['followedAuthors'],
    ['crewFeed'],
    ['setterStats'],
    ['searchClimbs'],
    ['infiniteSearchClimbs'],
    ['searchClimbsCount'],
  ],

  // Following-only catalogue reads, Crew and the complete author snapshot.
  // Setter identities can be accountless OR linked: followSetter/unfollowSetter
  // also insert/delete user_follows for a linked Boardsesh account. Keep profile
  // and user-follow queries fresh after that server-side side effect lands.
  setter_follows: [
    ['publicProfile'],
    ['followers'],
    ['following'],
    ['searchUsers'],
    ['followedAuthors'],
    ['crewFeed'],
    ['setterStats'],
    ['searchClimbs'],
    ['infiniteSearchClimbs'],
    ['searchClimbsCount'],
  ],

  // Playlist follow state is a field on the playlist detail row
  // (isFollowedByMe + followerCount on ['playlist', uuid]), not its own query.
  playlist_follows: [['playlist']],

  // Board reference data: the list, the count, the detail, and the setter picker
  // (#5407 made ['setterStats'] a local read too — a sync that adds/removes
  // climbs changes who's set on the board, so it must refresh alongside search).
  //
  // ['similarClimbs'] — answered on device from board_climbs joined to the
  // derived holds index (holds-index/), so a climb arriving, changing or being
  // hidden changes the strip. (['holdHeatmap'] joins it once the heatmap's
  // reader exists: the drift test refuses a key nobody reads.)
  board_climbs: [
    ['searchClimbs'],
    ['infiniteSearchClimbs'],
    ['searchClimbsCount'],
    ['climb'],
    ['setterStats'],
    ['similarClimbs'],
  ],
  // The setter picker reads stats too, on Woods only: a climb set at another angle
  // counts toward its setter at the browsed angle once it has a stats row there
  // (the browsed-angle restriction, #5642), so a stats pull can change a count.
  board_climb_stats: [['searchClimbs'], ['infiniteSearchClimbs'], ['searchClimbsCount'], ['climb'], ['setterStats']],
  // The stats keys plus the two grade-specific keys the play-drawer grade
  // section and the by-angle chart read.
  board_climb_grades: [
    ['searchClimbs'],
    ['infiniteSearchClimbs'],
    ['searchClimbsCount'],
    ['climb'],
    ['boardseshGrade'],
    ['boardseshGradesForAngles'],
  ],

  // The device-derived holds index (holds-index/hold-index.ts). Not a synced
  // table — nothing pulls or drains it — but the index builder invalidates
  // through this map after a chunk changed rows, so it lives here with the rest.
  board_climb_hold_sets: [['similarClimbs']],

  // Deliberately empty — not a placeholder.
  //
  // A wall's holds and photo are read back through the spray wall registry
  // (`packages/mobile/src/lib/spray/spray-wall-registry.ts`, SW-07 / #5440),
  // which is a plain map the render path reads synchronously and which carries
  // its own subscription — there is no query key to bust. The climb-facing
  // halves of a reset (the badge, the Intact / Lost-holds filter) ride on
  // `board_climbs.missing_hold_count` and are already covered by that table's
  // keys above. Give this real keys if a wall ever grows a React Query surface.
  spray_walls: [],
};

/**
 * Keys to invalidate for `tableName`, or `null` when the table is not mapped at
 * all. `null` is the "someone added a table and forgot the UI" signal; an empty
 * array is a deliberate "nothing reads this yet", and callers must tell them
 * apart rather than warning on both.
 */
export function invalidateKeysForTable(tableName: string): InvalidateKeys | null {
  return TABLE_INVALIDATE_KEYS[tableName] ?? null;
}
