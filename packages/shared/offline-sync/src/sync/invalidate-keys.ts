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
  //   Personal grades (#4828) add a second reason, and it holds on BOTH
  //   consumers: a tick can carry the climber's own grade, and that grade is
  //   what the list filters and sorts by, so a pulled or drained tick moves
  //   climbs between grade bands. Without these keys the list keeps showing a
  //   re-graded climb in the band it just left.
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

  user_follows: [['followers'], ['following']],

  // Deliberately empty, not a placeholder key. Nothing on mobile reads a setter's
  // follow state yet — the setter surface shows ['setterStats'], which this table
  // does not feed. The old ['setterFollows'] key looked like coverage and was
  // not. Give this real keys when a follow-a-setter surface ships.
  setter_follows: [],

  // Playlist follow state is a field on the playlist detail row
  // (isFollowedByMe + followerCount on ['playlist', uuid]), not its own query.
  playlist_follows: [['playlist']],

  // Board reference data: the list, the count, and the detail.
  board_climbs: [['searchClimbs'], ['infiniteSearchClimbs'], ['searchClimbsCount'], ['climb']],
  board_climb_stats: [['searchClimbs'], ['infiniteSearchClimbs'], ['searchClimbsCount'], ['climb']],
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
