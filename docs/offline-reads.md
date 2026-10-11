# Offline reads: where a screen's data comes from

Decision record for [#4002](https://github.com/boardsesh/boardsesh/issues/4002) — "persist the React Query cache, or keep extending per-surface offline reads?"

The answer is **both, split by one rule**, not either. This document is the rule, the per-key assignment it produces, the auth-scoping contract every local read has to satisfy, and the alternatives that were rejected.

## The provenance rule

> **If a row has a local table, SQLite owns it. If it has no table and is small and identity-shaped, an allowlisted persisted cache owns it. If it has "now" semantics or is unbounded, neither owns it and the screen says so.**

Three buckets fall out of that, and every query key belongs to exactly one. The rule is what stops the two mechanisms competing: nothing is ever served by both, so there is never a merge question.

### Bucket 1 — SQLite (`offlineAwareRequest`)

Anything already in `TABLE_CONFIGS` (`packages/shared/offline-sync/src/sync/table-config.ts`): climbs, stats, grades, ticks/logbook, playlists and playlist climbs, favorites, follows, and the mirrored spray wall (`spray_walls`, #5448).

The expensive half of this shipped a year ago. `pullSync` syncs every `USER_DATA_TABLES` entry on each cycle for every authenticated user with the engine on — unconditionally, not gated on any board being downloaded (`pull-client.ts`, the `USER_DATA_TABLES` loop). The rows are on disk today. What is missing is **readers**: `offlineAwareRequest` (`packages/mobile/src/lib/graphql/offline-request.ts`) has six registrations, all of them board reference data.

SQLite wins this bucket for a reason a cache can never match: it answers for data you have **never looked at**. A downloaded Kilter layout is roughly 40,000 climbs. A persisted query cache can only ever replay the handful you scrolled past, which is the opposite of what a board download is for.

### Bucket 2 — an allowlisted, user-scoped persisted query cache

Only for keys that have no local table and do not deserve one: `['profile']`, `['myBoards', …]`, `['myGyms']`, `['grades', board]`, `['angles', board, layout]`, `['publicProfile', selfId]`.

`profile` is the fatal one. `useProfile` is a plain network query, and `/boards/manage` renders a hard "Something went wrong" when `currentUserId` is missing. Giving that one row a SQLite table means a schema entry, a backend `syncProfile` query, a checkpoint, and a deletions rule. Two hundred bytes of allowlisted JSON is the proportionate answer.

Budgets: target under 100 KB serialized, hard cap 512 KB with lowest-priority-first eviction, 64 KB per entry, `maxAge` 14 days for identity and config keys and 24 hours for `publicProfile`.

### Bucket 3 — honest offline states, no storage at all

Feeds (`crewFeed`, `sessionGroupedFeed`, `activityFeed`), session detail, board presence, `searchUsers`, `bulkVoteSummaries`, `comments`, `gymMembers`, `nearbyBoards`/`nearbyGyms`, `betaLinkPreview`.

`crewFeed` is viewer-scoped and live: it mixes followed climbers' sessions with recently published climbs by followed authors. It is not persisted or replayed offline, even though follows and author metadata are stored locally for climb search.

These have "now" semantics or are unbounded, so a stale copy is worse than an honest gap. They used to be worse than that: `networkMode: 'offlineFirst'` (`query-provider.tsx`) means an offline network-only query fires once, fails, then **pauses**, and a *hung* request never even failed. Since #4862 the interactive GraphQL client has a 20 s deadline and, while the connectivity store says the app is effectively offline (device offline, backend unreachable, or offline mode), the fetch chokepoint rejects instantly with a `BackendUnavailableError` that React Query does not retry — so these queries settle in `status: 'error'` within milliseconds instead of spinning, and `useOfflineQueryState` / `OfflineState` render the honest placard for the right reason ("No signal" vs "Can't reach Boardsesh right now" vs "Offline mode is on"). See `docs/offline-sync-plan.md` → "Backend reachability".

## Per-key assignment

| Query key                                                                                | Owner                       | Notes                                                              |
| ---------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------ |
| `['searchClimbs']`, `['infiniteSearchClimbs']`, `['searchClimbsCount']`                  | SQLite                      | Registered today                                                   |
| `['climb', …]`                                                                           | SQLite                      | Registered today                                                   |
| `['setterStats', …]`                                                                     | SQLite                      | Registered today (#5407)                                           |
| `['boardseshGrade']`, `['boardseshGradesForAngles']`                                     | SQLite                      | Registered today                                                   |
| `['climbStatsHistory', board, uuid]`                                                     | SQLite                      | `board_climb_stats`, once a scope the climb belongs to (its layout, at a size it fits) finished downloading; server otherwise |
| `['similarClimbs', …]`                                                                   | SQLite (local-only)         | Holds index; never the network for non-admins — see below          |
| `['holdHeatmap', …]`                                                                     | SQLite (local-only)         | Holds index ⋈ the list's filters; never the network for non-admins |
| `['logbook', board, …]`                                                                  | SQLite                      | `boardsesh_ticks`; reader missing (the play drawer's placeholder below is not it) |
| `['localTicks', …]`                                                                      | SQLite                      | Pending-write badge, the climber's own grade, and the play drawer Logbook card's placeholder rows; all read local already |
| `['userPlaylists']`, `['playlistClimbs', …]`, `['playlist', uuid]`                       | SQLite                      | `playlists` + `playlist_climbs`; reader missing                    |
| `['favoriteStatus', …]`                                                                  | SQLite                      | `user_favorites`; reader missing                                   |
| `['followers', id]`, `['following', id]`                                                 | SQLite                      | `user_follows`; reader missing                                     |
| `getSprayWallLocal(layoutId)` — no query key                                             | SQLite                      | `spray_walls`; read back through the SW-07 registry, not React Query, which is why its `invalidateKeys` entry is deliberately empty |
| `['profile']`                                                                            | Persisted cache             | No table, one row                                                  |
| `['myBoards', …]`                                                                        | Persisted cache             | Behind the live query, ahead of the `offlineBoardsV1` MMKV cards   |
| `['myGyms']`                                                                             | Persisted cache             | Small, identity-shaped                                             |
| `['grades', board]`, `['angles', board, layout]`                                         | Persisted cache             | Config, changes ~never                                             |
| `['publicProfile', selfId]`                                                              | Persisted cache             | Own profile only, 24 h                                             |
| `['userTicks', userId]`                                                                  | Neither (for now)           | See "Deliberately deferred". Refetches only on focus after a tick invalidation, or past 30 min |
| `['activityFeed']`, `['sessionGroupedFeed']`, `['sessionDetail', …]`                     | Neither                     | "Now" semantics                                                    |
| `['climbLostHolds', …]`                                                                  | Neither, by design          | Where a remixed spray climb's lost holds were, for the editor's grey rings (`GET_CLIMB_LOST_HOLDS`). Network only: the mirror keeps `missing_hold_count` but not the hold history. Offline it fails at once and the editor draws no rings, so Save is not held back |
| `sprayWallHoldUsage` — no query key                                                      | Neither, by design          | Asked once per hold-editor save that takes holds off a live wall. Network only; a failed read still shows the "Remove a hold that climbs use?" confirm, in its generic wording |
| `GET_SPRAY_WALL_ARCHIVE` — no query key                                                  | MMKV for archived walls     | The archive answer is cached in memory for the revalidation window. Offline, a downloaded wall's archive time comes from `offlineSprayWallArchiveV1` (archived walls only, cleared at the account boundary); a live wall reads as live |
| `['followingClimbLogs', viewerId, board, uuid]`                                          | Neither, by design          | Other climbers' logs on a climb (play drawer "Climber logs"). Network only, never persisted, no local reader: the server decides per request who may see a spray wall's logs. Offline shows a placard in the card |
| `['climbLogs', ...]`, `['climbLogsPreview', ...]`                                        | Neither, by design          | Everyone's logs on a climb (the "Everyone" section of the Climber logs list, and the card's fall-through rows). Same rule as the row above: network only, never persisted. Offline, the list shows no Everyone section and sends no request |
| `['crewFeed', viewerId]`                                                               | Neither                     | Viewer-scoped live feed; no persisted cache                        |
| `['searchUsers', …]`, `['gymMembers', …]`, `['comments', …]`, `['bulkVoteSummaries', …]` | Neither                     | Unbounded or live                                                  |
| `['nearbyBoards']`, `['nearbyGyms']`, `['betaLinkPreview', …]`                           | Neither                     | Location/link-scoped, useless stale                                |
| `['activeBoard']`                                                                        | Neither (already persisted) | AsyncStorage-backed in `use-active-board.ts` — do not double-store |

## The auth-scoping contract

A cross-user leak is the failure mode that would end this feature's credibility, and the SQLite path is where the exposure already lives — it holds a whole logbook, not 100 KB of profile JSON.

Sign-out already wipes the user tables: `clearLocalOfflineUserData` → `clearUserData` with `USER_DATA_TABLES_TO_CLEAR` (`packages/mobile/src/db/connection.ts`), wired into `runSignedOutCleanup`. But the call swallows failures with a dev-only warning, and `handleSignedOutTransition` skips it entirely on a logged-out cold start. One failed wipe — a locked database (#4314), a crash mid-sign-out — and the next account reads the previous one's rows. That is not hypothetical: the **already-shipped** local search reads ticks with no user predicate at all (`search-climbs-local.ts`, the `ticksExists` fragment), so a failed wipe already shows user A's send and attempt glyphs to user B.

So every user-scoped local read must satisfy all three of these, not one of them:

1. **Owner stamp.** `sync_meta` carries a `local_user_id` row, written by `OfflineSyncBridge` as soon as the signed-in climber resolves (before any local read, not after the first successful pull). Every user-scoped reader calls `assertLocalUserDataOwner(db, currentUserId)` first; a mismatch declines to serve, re-runs the wipe, and reports to Sentry. This is the **only** defence available for `playlists` and `playlist_climbs`, whose sync is an ownership join server-side and which therefore carry no user column locally — so it has to be a global guard, not per-table columns.
2. **Row predicate.** `boardsesh_ticks` and `user_favorites` reads filter `(user_id = ? OR user_id IS NULL)`, bound to the stamp rather than the live session id — the stamp _is_ the device's record of whose rows these are, and layer 1 is what checks it against the signed-in climber. With no stamp the predicate binds NULL, degrading the read to this device's own unsynced writes. The `IS NULL` arm is mandatory: the offline dual-write (`use-offline-mutations.ts`) does not stamp `user_id`, so a strict equality predicate would hide the user's own offline-logged ticks. The writer starts stamping it, and the `OR` covers rows already on disk.
3. **Completeness gate.** Serving from local requires a `checkpoint:user_data_complete` marker written by `pullSync` once every `USER_DATA_TABLES` entry has reached its tail. A checkpoint alone proves only that the first page landed — the same reasoning `markScopeDownloadComplete` already documents for board scopes. The marker lives under the `checkpoint:` prefix deliberately, so `deleteUserCheckpoints` clears it on sign-out for free.

Note what the gate is **not**: it is not "is this board downloaded". User tables sync independently of board downloads, so gating a tick read on a board download would refuse to answer from a fully synced table.

### What a board answers while its protected rows are replayed

A privacy change deletes other climbers' authored climbs from the device and replays the protected sync streams (`docs/privacy.md` → "Reads, live updates and downloaded copies"). The `scope-complete:` marker stays, so "downloaded" alone no longer says the board holds everything the viewer may see. `packages/mobile/src/db/queries/board-download-status.ts` adds two rules:

- **A catalogue board keeps serving from the device.** It still holds its whole reference catalogue and the climber's own climbs; what is missing for a few seconds is other climbers' authored climbs. Offline, that is the best answer there is.
- **A spray wall does not.** It has no reference rows, so without its protected rows there is no wall. `isBoardDownloadedLocally`, `isBoardTypeDownloadedLocally` and `isClimbLayoutDownloadedLocally` answer false for a spray scope until `isScopeProtectedComplete`, and the read falls back to its "not downloaded" branch.
- **Online, the server answers.** `offlineAwareRequest` takes the local-first branch only when `isBoardTypeProtectedSettled(boardType)` holds: every downloaded, enabled scope of that board type has its protected streams at the tail. During a replay an online read goes to the network, which is what the privacy doc promises ("online authenticated reads continue immediately through the server"). Offline the rule does not apply.

All three sit behind the catalogue read gate, which is closed for the whole revalidation: they cover the time between the deletion committing and the replay finishing.

### Spray walls are board data that has to be scoped like user data

A wall is a photograph of somebody's garage, not a public catalogue, so `spray_walls` (#5448) is the one board
reference table gated at all — and its three layers are not the three above:

1. **The server gate is the real decision.** `syncSprayWalls` applies the by-layout visibility rule — owner, gym member, or a public wall — so a wall the climber may not see never lands in the local database at all. Nothing on the device can leak what was never downloaded, and no local predicate could reconstruct that rule anyway.
2. **Owner stamp.** Board reference data normally survives sign-out as a shared cache, which is right for a Kilter catalogue and wrong for a wall, so `spray_walls` is the one reference table in `USER_DATA_TABLES_TO_CLEAR`, and `getSprayWallLocal` refuses to serve unless `assertLocalUserDataOwner` answers `'ok'`. It refuses on `unstamped` too: there is no wall row a device with no known owner should hand out. The photographs go with the rows — `clearStoredSprayPhotos` runs on both sign-out branches, because deleting the rows alone would leave the previous account's picture decodable on a shared phone with nothing left on disk to say whose it was.
3. **No row predicate is possible.** A wall carries no user column; its visibility is a join through `user_boards` and `gym_members` that only the server can evaluate. That is why layers 1 and 2 have to be strict — the same position `playlists` is in, and the same answer.

The wall's **climbs** are wiped on the same argument. A `spray_walls` row is not the only private thing a mirrored wall leaves on disk: its `board_climbs`, `board_climb_stats` and `board_climb_grades` rows carry the climb names, descriptions, frames and grades of somebody's garage, and `searchClimbsLocal` reads board reference data with no owner stamp — deliberately, because a Kilter catalogue is a shared cache. So the selective wipe also deletes those three tables' `board_type = 'spray'` rows (`SPRAY_SCOPED_BOARD_TABLES` in `connection.ts`), together with every spray scope's markers so no cursor outlives its rows. The catalogue boards stay, which is the whole point of the selective wipe.

### Which copy of a wall photograph is read

A wall photo is immutable per object key (`spray-walls/<wallUuid>/<photoId>.jpg`, a fresh random id per upload, never overwritten), so the phone keys its files on the object and never on the 15-minute signed URL. Three files can hold one, and each read takes the first that exists:

| Copy | Where | Who has it | Read by |
| --- | --- | --- | --- |
| Durable offline photo | `Paths.document/spray-wall-photos/<flattened key>` | Downloaded walls only (the walls whose climbs are in SQLite), which always include the climber's own walls | The renderer first (memoised against the store's delete epoch), online or off; the offline cold-start loader |
| Renderer cache | `Paths.cache/spray-walls/<layoutId>-v<versionId>.jpg` | Any wall drawn this fortnight that is not downloaded; deleted once the store holds the photo and no surface in this process was handed it | The renderer, when there is no durable copy |
| Kept full-resolution copy | `Paths.cache/spray-walls/<layoutId>-full-<photoId>.jpg` | Photos the climber zoomed past 3x in the hold editor | The hold editor only |

The climber's own walls are downloaded without the switch (`OwnedSprayWallsOfflinePin`, `docs/spray-walls.md` → "Your own walls are always downloaded"); they go through the same scope, sync and teardown as a wall downloaded by hand, so nothing in the auth scoping below changes for them. The renderer finds the durable copy through the registered wall's signed URL, which ends its path in the object key, so a downloaded wall is never fetched twice; a download adopts the renderer's file when the climber opened the wall first. The auth scoping does not change: every copy is under a spray directory that sign-out deletes whole, per-wall withdrawal deletes the wall's renderer files (the full copy included), a tombstone or a removed download deletes the durable one, and the renderer only resolves a file for a wall registered under the current viewer generation. No signed wall photo goes through expo-image's own disk cache: every surface that loads one passes `cachePolicy="memory"` (moderation passes `"none"`), because that cache is shared, keyed on the signed URL unless told otherwise, LRU-evicted against a 150 MB iOS cap shared with feed photos and avatars (Glide's default disk cache on Android), and outlives sign-out. `docs/spray-walls.md` → "One download per photograph" has the reasoning.

### Revoked spray-wall downloads (#5490)

The owner's deletion tombstone is owner-scoped. A gym member or a climber who
downloaded a public wall does not receive it, so the pull also checks for revoked
access when an explicitly scoped `syncSprayWalls` page is empty and that wall
still exists locally.

An empty delta is not proof of revoked access: an unchanged wall returns the same
page. A cursor-free sync request is ambiguous too, because recently edited rows
are excluded by sync's 30-second stability window. The client confirms with the
existing `sprayWallByLayout(layoutId) { uuid }` query, through the network fetch
seam rather than a cached or offline read. Only an explicit `null` confirms that
the wall is unavailable. Failed or malformed confirmations fail the cycle and
preserve the download; they do not skip just the affected wall.

Confirmed removals wait until the cycle finishes successfully. One guarded
transaction then removes the wall, its downloaded climbs, stats, grades and
derived holds index, together with the scope's checkpoints and download markers.
A failed cycle or an interruption before commit does not retire the download.
The deleted-row sink removes the stored photograph after commit and clears its
pending-photo retry marker; an in-flight photograph must not recreate the file or
retry bookkeeping after removal.

The mobile sink also unregisters the wall's render geometry, removes cached
photograph versions, and cancels and removes the wall's React Query entries.
Pending render and editor loads are fenced by the wall's removal generation, so
a response started before revocation cannot register the wall again afterwards.

Personal ticks, unrelated board downloads, the global deletions cursor and the
enabled-board setting remain. If access returns, the cleared markers allow a
fresh download. This is device-cache removal: server walls continue to use soft
deletion and retain the existing recovery window. Owner tombstones still take
their existing path, and a wall already removed by a tombstone is not retired
again.

Reference-safe reaping of unreferenced server records is tracked separately in
[#5951](https://github.com/boardsesh/boardsesh/issues/5951). The existing server
photo reaper and its 30-day recovery window remain in place.

The read is deliberately **not** gated on `isUserDataComplete`. That marker is about the user tables having reached their tail, and a downloaded wall is board data — gating on it would refuse a wall that is fully on disk.

The persisted cache adds its own layer on top: the blob carries a `userId` stamp validated against resolved auth on every transition, it is deleted inside the single `clearPersistedUserStores` call site rather than by a parallel delete, and `needsFullCleanup` has to fire on a logged-out cold start **when a blob exists** — the "the cache is empty" comment that justifies skipping cleanup today is only true because nothing hydrates yet.

### Climb versions are read from the phone, even for a network answer

A tick records which version of the climb it was logged on (#6023, `docs/spray-walls.md` → "Which revision a tick was logged on"). The documents that would carry the numbers (`SearchClimbs`, `GetClimb`, `GetTicks`, the queue documents) are pinned by the App Store screenshot fixtures and cannot select them yet, so the phone's own tables answer instead. Three reads, all in `packages/mobile/src/db/queries/climb-revisions-local.ts`:

| Read | Table | Gate |
| --- | --- | --- |
| `fillClimbRevisionNumbersLocal`: fills `holdsRevisionNumber` on a **network** `SearchClimbs` page or `GetClimb` answer (`OfflineOperation.enrichNetworkResponse`) | `board_climbs`, by primary key, one statement per page | None on ownership: board reference data, the same rows `searchClimbsLocal` serves. Skipped when the offline engine is off or there is no handle. Races a 150 ms budget (`NETWORK_ENRICHMENT_BUDGET_MS`); past it, or on a throw, the network answer goes out as it came |
| `readTickRevisionsLocal` (`BoardAdapter.readLocalTickRevisions`): which version each of the climber's own ticks was on, joined onto the `GetTicks` rows by tick uuid | `boardsesh_ticks`, through `idx_ticks_climb`, one statement per logbook batch, with a `pending_mutations` probe for rows that have no version | Row predicate only (`user_id = ? OR user_id IS NULL`, bound to the stamp). No owner assertion and no completeness gate, and that is deliberate: the map is only ever joined onto ticks the server just returned for the signed-in climber, by a uuid that is unique across accounts, so a row another account left behind cannot match one. An incomplete table costs a missing version, never a wrong row |
| `tickOnCurrentHoldsLocalSql`: the "logged on the holds the climb has now" predicate inside `searchClimbsLocal` | `boardsesh_ticks` ⋈ `board_climbs` | The search's existing ones. It only narrows the tick subqueries that were already there |

None of the three is a new answer to "what did this climber do": the rows themselves still come from the server or from the readers documented above. They add one number to rows that already passed their own gate.

**The phone's row is one past state of the climb.** The climb on screen can be another (a network answer newer than the last pull, a queue item from before an edit, unsaved work in the editor). `holdsRevisionNumber` is filled anyway: it is a threshold that only rises, so the phone's older value can count a send that should have been dropped and can never drop one that counts. The climb's own `revisionNumber` is not filled: nothing on the phone reads it.

What a missing number means, by reader:

- **Stamping a tick.** The app never sends `climbRevision`; the server stores the version that was live when the climb was climbed. The local `boardsesh_ticks` row is stamped from the phone's `board_climbs.revision_number` (`writeTickLocal`), NULL when the phone has no row or the row has no number.
- **Counting a tick as sent in local search.** Both columns are on rows the phone holds, so a NULL is "the server delivered this row without one" and reads as version 1 on both sides. Every tick counts on a climb with no holds version, exactly as before the columns existed.
- **Counting a tick as sent on a list row** (the sent glyph, from the `GetTicks` logbook). Three cases, kept apart:

  | What the join found for the tick | Reads as | On a climb whose holds moved |
  | --- | --- | --- |
  | A row with a version | That version | Counts when at or above the holds version |
  | A row the server delivered, with no version | 1 | Does not count |
  | No row, or this phone's own write that is still in `pending_mutations` and has no version | Not known | Counts |

  The last case is a fresh sign-in or a second phone, where `GetTicks` lands before the tick pull has written the row. It used to read as version 1, which turned a send on the current holds into "not sent" until restart.

**When a later read knows more.** The join runs each time a logbook batch is fetched. A completed tick pull invalidates `['logbook']` (`TABLE_INVALIDATE_KEYS`), which refetches the batches on screen, and `mergeLogbookEntries` gives a row already in the accumulated cache the version the later read has. It only ever adds knowledge: a number replaces anything, "has none" replaces "not known", and nothing is replaced by "not known". A batch that is not on screen when the pull lands is read again the next time one of its climbs is opened. A tick saved on this phone has no version in the logbook cache when it is saved, so it counts; the next read joins the version its local row was stamped with.

A tick this phone logged on a climb it holds is stamped with that row's version, which is never below the row's holds version, so against the phone's own copy it reads as sent from the moment it is written. On the phone a climb's holds version only ever comes from `board_climbs` (no client document selects `holdsRevisionNumber`; a queue item carries the number its source row had), so a tick logged with no local climb row is NULL-stamped against a climb that has no holds version either, and it counts. One window is left: a NULL-stamped tick whose climb row lands (a board download finishing) before the tick itself is pulled back. Until then it reads as version 1, and on a climb whose holds moved it reads unsent. Ticks are pulled before the board tables in a sync cycle, so once the tick has drained the window lasts at most one cycle.

### The holds index is derived on the device, not synced

The on-device similar-climbs and hold-heatmap queries need to go from holds to climbs. The phone builds that index from the `frames` string every downloaded climb already has (`ensureHoldIndex`, `packages/shared/offline-sync/src/holds-index/hold-index.ts`). It uses the same rule Postgres uses: the first entry per hold wins across frames, and unknown role codes are dropped (`parseFramesToHoldRows` in `@boardsesh/board-constants`). The engine takes the parser as a parameter, and mobile passes it in from `packages/mobile/src/offline/hold-index-parser.ts`.

It is three tables of packed blobs (schema v10), not one row per hold. One row per hold measured 3.8M rows and 370 MB for one Kilter download.

| Table | One row per | Contents |
| --- | --- | --- |
| `holds_index_climbs` | climb uuid | a stable local integer id; only ever `INSERT OR IGNORE`d, and `AUTOINCREMENT` so a deleted id is never reissued |
| `board_climb_hold_sets` | indexed climb | its holds, sorted by hold id, 5 bytes each (uint32 hold id + uint8 role: 0 start, 1 hand, 2 foot, 3 finish, 255 other) |
| `board_climb_hold_postings` | (board, layout, hold) | sorted uint32 local ids of the climbs that use the hold; `WITHOUT ROWID` |

Readers never decode bytes themselves. `holds-index/query.ts` provides `getHoldSet`, `findSimilarClimbCandidates` (overlap counting over postings, then Jaccard) and `aggregateHoldUsage` (the heatmap's per-hold counts over hold sets). On the real `kilter:1` artifact, one download's index is 67 MB on disk, and a candidate query takes 3–5 ms in node.

None of the three is a synced table. They have no `TABLE_CONFIGS` entry, no checkpoint and no tombstones, and they never ship in a snapshot artifact (`DEVICE_ONLY_TABLES`). The rules:

- **Only complete scopes.** A scope is indexed only once its `scope-complete:` marker exists and its protected streams are at their tail (`isScopeProtectedComplete`). The builder checks both again under each write lock, so it cannot write into a scope that a teardown is removing, or index a board while a privacy event's replay is still bringing its authored climbs back. Until then `ensureHoldIndex` answers `not-downloaded`, and the similar-climbs and heatmap readers throw so React Query retries.
- **One watermark per scope.** Progress is stored in the `holds-index:<scopeKey>` row of `sync_meta`, compared on `sync_seq` only. The watermark is per scope, not per layout, because a second size of a layout brings climbs with older `sync_seq` values.
- **First build.** With no watermark, the builder records the scope's `MAX(sync_seq)`. It then walks the scope in `uuid` order in 2,000-climb transactions that write hold sets only; the uuid order makes new ids append instead of scatter. Next it rebuilds the layout's postings from every hold set of that layout, and finally stamps the watermark. An interrupted first build starts over. Nothing is lost, because hold-set writes skip unchanged rows and the rebuild reads the truth.
- **Incremental.** Climbs past the watermark are re-derived 500 at a time. Each chunk edits only the postings its climbs enter or leave, and moves the watermark in the same short transaction.
- **Which climbs are indexed.** Only listed, published, not-hidden climbs. Hiding a climb bumps its `sync_seq`, and the next pass takes it out.
- **Postings are per layout.** Every downloaded size of a layout shares them, so builds run one at a time per layout.
- **Teardown generations.** Every clear of the index bumps a counter in `sync_meta` (`holds-index-generation:<board>:<layout>`, and `holds-index-generation:<board>` for a board-wide clear). A build reads the counter when it starts and re-reads it under each write lock. A teardown that lands mid-build, even one of a sibling size that leaves this scope's own markers alone, therefore stops the build before it writes rows from a read that predates the wipe.
- **Re-checked under the lock.** Each chunk re-reads its climbs' `sync_seq` under the write lock. A climb that a tombstone deleted since the unlocked read is skipped, and so is one that changed; a later pass derives the new version.
- **Yields between chunks.** The builder hands the JS thread back between chunks, and builds each posting list in a growable `Uint32Array`.
- **When it runs.** `pullSync` builds the index for each scope at the end of every cycle, after the completion markers are written, so it never holds up a download. A build failure is reported through `holdIndex.onError` and never fails the cycle. The mobile similar-climbs and heatmap readers, which ship in later PRs, will also call `ensureHoldIndex` before they query.
- **Privacy events.** The revalidation deletes the hold set and local id of every climb it withdraws, in its own transaction. A layout that lost an indexed climb also loses its postings and every scope watermark, and rebuilds once its protected rows are back; that pass re-reads the layout's frames but rewrites only the hold sets that changed. A layout that lost nothing the index held keeps its index. The watermark is `sync_seq` only, so a protected climb that arrives at or below it would never be indexed: a protected page that delivers an indexable climb with no hold set at or below the watermark drops the scope's watermarks, and the next pass picks it up.
- **Cleanup.** A `board_climbs` tombstone takes the climb out of its postings and drops its hold set. Scope teardown clears the whole layout's index and every sibling scope's watermark, and a surviving sibling rebuilds on its next cycle. After a snapshot import, the orphan sweep deletes hold sets whose climb is gone and rebuilds that layout's postings. The spray sign-out wipe clears spray's hold sets, postings and watermarks. It also clears every hold set whose climb is already gone, then every local id that no hold set still uses, so no spray uuid is left behind. The explicit sign-out wipe clears all three tables.

`board_climbs` and `board_climb_hold_sets` both invalidate `['similarClimbs']` and `['holdHeatmap']`. `board_climb_stats` invalidates `['holdHeatmap']` as well: stats colour the grade mode and also decide the climb set under `minAscents`, `minRating` and a grade range. `staleTime` never triggers a refetch on its own, so without that key the overlay would keep old numbers until it was switched off and on. `invalidateQueries` refetches active queries only, so the key costs nothing while the overlay is hidden.

Both keys are **board-scoped** (`scopedInvalidateFilters` in `sync/invalidate-keys.ts`): a pull of a per-board table, and a holds-index build, invalidate them with a predicate that matches only query keys naming that board's `boardName`/`boardType` + `layoutId`. A key that names no board is always refreshed. The holds-index build also passes `cancelRefetch: false`, because the heatmap's own `queryFn` joins the very build that finishes (it calls `ensureHoldIndex` first); a cancelling refetch would throw that answer away and run the aggregate again.

### Android binary-read safety

The index remains packed BLOBs on disk, but every hold-set and posting reader projects
`hex(column)` and uses the shared `decodeSqliteBlobHex` helper to allocate JavaScript-owned
bytes. Expo SQLite's Android BLOB result path creates a JNI global reference for each native
buffer. The October 2, 2026 bug report contained 25 crashes at the 51,200-reference ceiling,
with roughly 50,000 `DirectByteBuffer` entries and `SQLiteModule.getAll` on the crashing stack.
This affects background index rebuilding during sessions as well as interactive readers;
reducing a query's batch size alone does not guarantee collection of prior native buffers.
Text transport avoids that result-buffer path without a schema or native dependency change.

The local heatmap folds 1,000 climbs per page into one numeric aggregate and yields between
pages. One query selects matching numeric climb IDs through the board/filter indexes;
the fixed candidate list bounds the read during concurrent imports. Each page looks up at
most 1,000 candidate IDs through the hold-set primary key, so unrelated downloaded boards
are not scanned and sparse filters do not trigger a global hold-set scan. Only numeric IDs
and the aggregate are retained between pages; decoded hold sets are not accumulated.
Account changes, scope removal, or index teardown invalidate the in-flight
result. Ordinary sync edits are eventually refreshed by the existing scoped invalidation;
the paged aggregate is not a database snapshot and takes no long write transaction.

### Expensive catalogue reads are local-only

Similar climbs is the first read registered with `networkPolicy: 'local-only'` (`packages/mobile/src/lib/graphql/offline-request.ts`). It is kept off the live resolver by policy: similar climbs are an offline feature for non-admins. The server's live scan (every hold row of the layout) is admin-only after #5766, and non-admins would otherwise get the nightly neighbour index. A local-only op never calls `getHttpClient()`: when the downloaded board can serve it, it reads SQLite (online or offline); when it cannot, it returns the op's empty fallback. The unavailable reason is recorded only while offline, as on the local-first path, because online the `download` audience never runs the query. There is no network-error rescue either, because there is no network request to fail.

The caller picks the source with `useCatalogQuerySource(scope)` (`packages/mobile/src/lib/offline/use-catalog-query-source.ts`):

| Source | When | What the play drawer does |
| --- | --- | --- |
| `local` | the exact `(board, layout, size)` scope is in `syncEnabledBoards` and has its `scope-complete:` marker — the same check `isBoardDownloadedLocally` makes before its row probe (the holds index adds its own protected-complete gate, see above) | `offlineAwareRequest`; the first read builds the holds index, and the strip shows "Preparing similar climbs…" meanwhile |
| `network` | not downloaded, and the viewer is an admin (`useIsAdmin`) | `getHttpClient().request` directly, bypassing the interceptor |
| `download` | everyone else | no query; the section offers the download (`OfflineNudgeCard`, nudge surface `similar_climbs`, trigger `similar_climbs`, source `play_drawer`) for the active board when it is the drawer's exact board, and a neutral "download this board to see similar climbs" line whenever no card shows (a climb from another board, the card dismissed, or offline downloads unavailable) |

Supporters become one more branch next to the admin check.

The hold heatmap (`HOLD_HEATMAP_QUERY`, surface `hold_heatmap`) uses the same hook and policy. Its `canServeLocal` is the climbs list's own gate (`isOfflineSearchSupported` + `isBoardDownloadedLocally` + the followed-authors check), and its local reader (`packages/mobile/src/db/queries/get-hold-heatmap-local.ts`) builds its climb set with the list's `buildJoinAndWhere`, owner stamp and followed-authors condition included, so the personal-progress filters obey the auth-scoping contract above. It joins that set to `board_climb_hold_sets` and folds the packed blobs in JS with `aggregateHoldUsage`. A board-scoped admin looking at a board outside their scope gets "Couldn't load" from the admin-gated resolver, the same as similar climbs. The heatmap lives on two surfaces only: the hold filter screen (`app/(tabs)/climbs/holds.tsx`) and the create board. On the hold filter it counts the filter sheet's draft, handed over as the `heatmapSearch` route param, minus its hold picks (`withoutHoldPicks`): those picks are what the screen edits, so the heat shows where the climbs matching everything else go. Any filter SQLite cannot run (drafts, beta videos, a zone box) declines, and the scope chip offers the whole board. The count modes (Climbs, Starts & finishes, and every create-board brush) pass `withStats: false`, a local-only variable that skips the grade and ascent columns; the grade mode passes `true` and has its own cache entry. The local answer also carries `climbCount`, the number of climbs it folded, for the legend's scope count; the admin network answer has none, so the legend leaves it out. For a board that is not downloaded both surfaces show one line with a Download button in the legend's slot (`HeatmapDownloadLine`; nudge surface and trigger `hold_heatmap`, source `hold_filter` on the hold filter screen), and the flame stays lit. On the create board that line sits where the autosave note does, because toasts draw behind its native sheet.

How the heat is drawn (heatmap v2): the per-hold counts are ranked by mid-rank percentile, nothing below the 20th percentile is drawn, and the rest fall into five buckets (`heatmap-buckets.ts`). The buckets travel to the native renderer as synthetic hold-state codes 900–904 (910+ for grade colours) through `useNativeClimbRender`'s `extraHoldStates`, drawn with the Aura `fill` mark (`markStyleOverride`) and no veil, as one cached image in the board's `underOverlay` slot. JS only: no renderer or native change, so the OTA fingerprint is untouched. A binary that cannot draw the fill gets small RN dots instead.

## Local-first while online, and when not to be

`offlineAwareRequest` currently serves local **while online** whenever the offline engine flag is on (`if (!isOnline || isOfflineEngineEnabled())`), and that flag is at 100%. For board reference data that is right — a local query beats a round trip and the background sync keeps it fresh.

For the logbook it is wrong. `GET_TICKS` selects `upvotes`, `downvotes`, `commentCount`, `effectiveQuality`, `boardseshDifficulty` and `boardseshConfidence`; `boardsesh_ticks.localColumns` has none of them. Most of that is harmless — the only consumer maps through `toLogbookEntry`, which drops `boardseshDifficulty`/`boardseshConfidence` outright and already falls back `effectiveQuality: tick.effectiveQuality ?? tick.quality` by design. The real degradation is exactly three fields: **`upvotes`, `downvotes` and `commentCount` read 0**. Serving that to a user with full signal is a regression, not an optimization.

So `OfflineOperation` gains `localFirstWhileOnline`, defaulting to `true` so today's five registrations keep their behaviour byte for byte. The logbook, playlists and favorites register with `false`: local is consulted only when the network is genuinely down. The trade is deliberate — those surfaces get no online latency win from a downloaded board, in exchange for never showing a degraded row to a connected user.

One surface shows local logbook rows to a connected user, and it does not break that rule. The play drawer's own Logbook card (#5986) fills itself from `boardsesh_ticks` while its `GET_TICKS` request is in flight, through `useLocalClimbTicks` (`packages/mobile/src/hooks/use-local-climb-ticks.ts`). A cold request to the server can take seconds, and the phone already holds the climber's ticks. The rows are a placeholder: `GET_TICKS` is still sent, never through `offlineAwareRequest`, and its answer replaces them the moment it lands. So `upvotes`, `downvotes` and `commentCount` read 0 only in between, and the twin collapse described under "Documented offline degradations" (the same `MIN(uuid)` rule, which this read is the first to implement) is only an approximation for that long. The table is only as current as the last sync: a tick deleted elsewhere since, such as from the You tab, which deletes on the server, can show as a ghost row until the answer lands. The read satisfies all three layers of the auth-scoping contract (`canServeLocalUserData`, then the row predicate bound to the stamp); when the gate declines, the card keeps its spinner. It is display only. Whether a new ascent is a flash is still decided from the server-backed logbook, which does not count a climb as fetched until the server has answered. It also does not run with no signal or after a failed request: that card already says why the history is missing. The full `localFirstWhileOnline` reader for `['logbook', board, …]` ([#4352](https://github.com/boardsesh/boardsesh/issues/4352)) is still open.

**If [#4312](https://github.com/boardsesh/boardsesh/issues/4312) removes the flag conditional, it must preserve the per-op opt-out.** Without it, `!isOnline || isOfflineEngineEnabled()` collapses to unconditional local-first and the online logbook silently starts showing zeroed social counts. This is the highest-risk cross-workstream interaction in the epic.

## Documented offline degradations

Two, both bounded and both deliberate. They describe the offline logbook reader ([#4352](https://github.com/boardsesh/boardsesh/issues/4352)), which is not built yet. The only code that reads logbook rows from `boardsesh_ticks` today is the play drawer's placeholder (see "Local-first while online, and when not to be"). It runs online only, is off with no signal, and shows both effects just until the server answers.

- **Social counts read 0** on locally-served logbook rows. Offline only, because of `localFirstWhileOnline: false`.
- **Aurora twin collapse is an approximation.** The server's `ticks` resolver filters `notAuroraTwinDuplicate`; `syncTicks` does not, and it omits the `aurora_*`/`kilter_*` bookkeeping columns the predicate needs, so local rows include twins. Rather than sync five more columns and port a 60-line predicate, the local reader collapses rows sharing the full natural key **and** an identical payload, keeping `MIN(uuid)`. It under-collapses in the locally-edited case (shows two rows the server shows as one) and could over-collapse a byte-identical pair one second apart, which the rule's own documentation calls physically impossible. Blast radius: `aurora-twin-dedup.ts` measures 11 groups / 25 rows fleet-wide, and it is offline-only.

One more is not specific to the logbook. When the running bundle is older than the one that migrated the database (a reverted canary OTA, or a climber leaving the early-updates track), the app refuses the file for the session: every Bucket 1 read behaves as if nothing were downloaded, so it comes from the network while online and renders the usual placard with no signal. Nothing is deleted, and the downloads come back with the next update. See `docs/offline-sync-plan.md` → "Older JS on a newer database".

## Cache invalidation

A completed sync has to tell the UI. Today it mostly does not: `TABLE_CONFIGS[*].invalidateKeys` points at `['ticks']`, `['playlists']`, `['favorites']`, `['setterFollows']` and `['playlistFollows']`, none of which any reader uses, and the mutation drainer carries a near-duplicate map with the same dead keys. There is now **one** `TABLE_INVALIDATE_KEYS` map in `@boardsesh/offline-sync`, consumed by both, with a drift test that fails when a key has no reader.

Invalidation stays gated on rows actually landing (`if (totalProcessed > 0)`), and `invalidateQueries` refetches active queries only, so the cost of correcting the keys is bounded to whatever is on screen when rows genuinely moved.

"On screen" still has a price. A climb list is an infinite query: one invalidation re-reads every page it has loaded, in sequence, cancels a next-page fetch in flight, and holds paging back until it settles. Seven tables carry the climb-search keys, and a cycle that invalidated once per table refetched the list on screen once for each. With nine spray walls pinned for offline, a cold launch refetched a Kilter list twelve times in twenty seconds (#6302). Three rules bound it:

- **One batch per cycle, flushed per phase.** The pull client queues its invalidations in an `InvalidationBatch` (`sync/invalidation-batch.ts`), so a key is invalidated once for everything a phase changed. The flushes: after the tombstones and the user tables together; after each board scope; after each scope's refresh replay; after a wall retirement; and in the cycle's `finally`, so rows committed before a throw or a teardown still reach the UI. The coverage reset and a snapshot import flush at once, as they always did. Two flushes are placed after a completion marker on purpose (`user_data_complete`, `scope-complete:`): the refetch they start must find the marker that opens the local read.
- **The search keys are scoped to the board that changed.** `searchClimbs`, `infiniteSearchClimbs` and `searchClimbsCount` are in `BOARD_SCOPED_KEY_HEADS` with the heatmap and similar climbs. A list reads SQLite only when its own `boardName:layoutId:sizeId` is a downloaded scope, so rows for another board cannot change it. The scope is the layout, not the size. User tables name no board and refresh every list.
- **A board tombstone that removed nothing says nothing.** Board tombstones reach every device for every board. Only one that deleted a local row invalidates, scoped to the climb's board when the climb is still on the device to say which. A user-table tombstone always invalidates: those are the climber's own rows, and one can be on screen from the network without ever having been pulled.

In an ordinary cycle that leaves a list at most two refetches: one if a user table or a tombstone moved, one when its own board's rows moved. Three cases add to that. A first download refreshes its board at the import, at the grades import, and again at completion. Two pinned sizes of one layout are two scopes, and each refreshes that layout's lists. A refresh replay adds one for its scope.

A scope that completes for the first time queues its board's keys even when the delta pull moved no rows, which is the case for a download a snapshot satisfied outright. The import's own refresh ran while the scope was still closed to local reads, so without this the list stays on the network read it made then.

What this gives up: a board that is not downloaded is read from the network, and a board pull or a board tombstone no longer refreshes its lists (the user tables still do, for every board). A climb deleted there stays in the list, and on its detail screen, until the query goes stale (5 minutes) and is next mounted or the app next comes to the front. Before, the tombstone refreshed it at the next sync. New and edited climbs on such a board never had a signal.

The mutation drainer does not use the batch yet: it still invalidates once per drained mutation.

## Deliberately deferred

**The You-tab logbook (`GET_USER_TICKS`) cannot be served locally.** `boardsesh_ticks.localColumns` has no `layout_id`, and `use-you-data.ts` needs a `layoutId` per entry; joining `board_climbs` only covers downloaded scopes. Fixing it needs a local schema column plus a backend `syncTicks` selectList change, so it gets its own issue and stays on the honest-empty-state path for now.

## Rejected alternatives

**Persist the whole React Query cache.** Two sources of truth for rows `offlineAwareRequest` already serves authoritatively, with no merge rule. It only ever replays what you already viewed. The biggest objects in the cache — `['infiniteSearchClimbs']` pages, `['userTicks']` — are exactly the tempting ones. Stock `PersistQueryClientProvider` gates first paint on an async restore. And query keys carry no user dimension while sign-out cleanup is best-effort: persist first, scope later is how you leak a logbook.

**Per-surface SQLite for everything.** `profile`, `myGyms`, `grades` and `angles` do not each deserve a table plus a backend sync query plus a checkpoint plus a deletions rule, and per-surface work is O(surfaces) forever — the next "offline shows nothing" screen starts from zero.

**`@tanstack/react-query-persist-client` + `@tanstack/query-async-storage-persister`.** Everything needed is already exported by the pinned `@tanstack/react-query@5.101.4` (`dehydrate`, `hydrate`, `IsRestoringProvider`, `useIsRestoring`), so the dependency buys about 150 lines and costs `packages/mobile/package.json` + `pnpm-lock.yaml` churn — which per [#4122](https://github.com/boardsesh/boardsesh/issues/4122) trips the OTA "native change" check as a false positive. It also does not give us three things we need: the allowlist as a hard gate on the dehydrate path, a `userId` stamp validated at the auth boundary, and a synchronous MMKV restore with no `isRestoring` frame on native. And it dehydrates mutations by default — `pending_mutations` in SQLite is the outbox, so a second persisted outbox is a double-submit hazard. Ours hard-codes `shouldDehydrateMutation: () => false` with a test.

**MMKV for the persisted blob on Expo web.** MMKV's web build is `localStorage`, same origin as the Next app. Web writes through AsyncStorage (IndexedDB per `CLAUDE.md`) and validates the blob's own `userId` stamp against resolved auth, since web restore is async anyway. No auth token is ever persisted on either platform.

## Delivery

| Step                                                                     | State                                                                                                                                                     |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| This decision                                                            | shipped                                                                                                                                                   |
| Honest offline states on network-only screens                            | shipped                                                                                                                                                   |
| One invalidation map for sync and the drainer                            | shipped                                                                                                                                                   |
| User scoping: owner stamp, completeness marker, row predicates           | shipped                                                                                                                                                   |
| `localFirstWhileOnline` + the local logbook, playlists and likes readers | [#4352](https://github.com/boardsesh/boardsesh/issues/4352) — ordering constraint against [#4312](https://github.com/boardsesh/boardsesh/issues/4312)     |
| The allowlisted persisted cache                                          | [#4353](https://github.com/boardsesh/boardsesh/issues/4353) — follows the logout-wipe work in [#3621](https://github.com/boardsesh/boardsesh/issues/3621) |
