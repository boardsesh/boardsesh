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
| `['similarClimbs', …]`                                                                   | SQLite (local-only)         | Holds index; never the network for non-admins — see below          |
| `['logbook', board, …]`                                                                  | SQLite                      | `boardsesh_ticks`; reader missing                                  |
| `['localTicks', …]`                                                                      | SQLite                      | Pending-write badge, reads local already                           |
| `['userPlaylists']`, `['playlistClimbs', …]`, `['playlist', uuid]`                       | SQLite                      | `playlists` + `playlist_climbs`; reader missing                    |
| `['favoriteStatus', …]`                                                                  | SQLite                      | `user_favorites`; reader missing                                   |
| `['followers', id]`, `['following', id]`                                                 | SQLite                      | `user_follows`; reader missing                                     |
| `getSprayWallLocal(layoutId)` — no query key                                             | SQLite                      | `spray_walls`; read back through the SW-07 registry, not React Query, which is why its `invalidateKeys` entry is deliberately empty |
| `['profile']`                                                                            | Persisted cache             | No table, one row                                                  |
| `['myBoards', …]`                                                                        | Persisted cache             | Behind the live query, ahead of the `offlineBoardsV1` MMKV cards   |
| `['myGyms']`                                                                             | Persisted cache             | Small, identity-shaped                                             |
| `['grades', board]`, `['angles', board, layout]`                                         | Persisted cache             | Config, changes ~never                                             |
| `['publicProfile', selfId]`                                                              | Persisted cache             | Own profile only, 24 h                                             |
| `['userTicks', userId]`                                                                  | Neither (for now)           | See "Deliberately deferred"                                        |
| `['activityFeed']`, `['sessionGroupedFeed']`, `['sessionDetail', …]`                     | Neither                     | "Now" semantics                                                    |
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

### Spray walls are board data that has to be scoped like user data

A wall is a photograph of somebody's garage, not a public catalogue, so `spray_walls` (#5448) is the one board
reference table gated at all — and its three layers are not the three above:

1. **The server gate is the real decision.** `syncSprayWalls` applies the by-layout visibility rule — owner, gym member, or a public wall — so a wall the climber may not see never lands in the local database at all. Nothing on the device can leak what was never downloaded, and no local predicate could reconstruct that rule anyway.
2. **Owner stamp.** Board reference data normally survives sign-out as a shared cache, which is right for a Kilter catalogue and wrong for a wall, so `spray_walls` is the one reference table in `USER_DATA_TABLES_TO_CLEAR`, and `getSprayWallLocal` refuses to serve unless `assertLocalUserDataOwner` answers `'ok'`. It refuses on `unstamped` too: there is no wall row a device with no known owner should hand out. The photographs go with the rows — `clearStoredSprayPhotos` runs on both sign-out branches, because deleting the rows alone would leave the previous account's picture decodable on a shared phone with nothing left on disk to say whose it was.
3. **No row predicate is possible.** A wall carries no user column; its visibility is a join through `user_boards` and `gym_members` that only the server can evaluate. That is why layers 1 and 2 have to be strict — the same position `playlists` is in, and the same answer.

The wall's **climbs** are wiped on the same argument. A `spray_walls` row is not the only private thing a mirrored wall leaves on disk: its `board_climbs`, `board_climb_stats` and `board_climb_grades` rows carry the climb names, descriptions, frames and grades of somebody's garage, and `searchClimbsLocal` reads board reference data with no owner stamp — deliberately, because a Kilter catalogue is a shared cache. So the selective wipe also deletes those three tables' `board_type = 'spray'` rows (`SPRAY_SCOPED_BOARD_TABLES` in `connection.ts`), together with every spray scope's markers so no cursor outlives its rows. The catalogue boards stay, which is the whole point of the selective wipe.

The read is deliberately **not** gated on `isUserDataComplete`. That marker is about the user tables having reached their tail, and a downloaded wall is board data — gating on it would refuse a wall that is fully on disk.

The persisted cache adds its own layer on top: the blob carries a `userId` stamp validated against resolved auth on every transition, it is deleted inside the single `clearPersistedUserStores` call site rather than by a parallel delete, and `needsFullCleanup` has to fire on a logged-out cold start **when a blob exists** — the "the cache is empty" comment that justifies skipping cleanup today is only true because nothing hydrates yet.

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

- **Only complete scopes.** A scope is indexed only once its `scope-complete:` marker exists. The builder checks the marker again under each write lock, so it cannot write into a scope that a teardown is removing.
- **One watermark per scope.** Progress is stored in the `holds-index:<scopeKey>` row of `sync_meta`, compared on `sync_seq` only. The watermark is per scope, not per layout, because a second size of a layout brings climbs with older `sync_seq` values.
- **First build.** With no watermark, the builder records the scope's `MAX(sync_seq)`. It then walks the scope in `uuid` order in 2,000-climb transactions that write hold sets only; the uuid order makes new ids append instead of scatter. Next it rebuilds the layout's postings from every hold set of that layout, and finally stamps the watermark. An interrupted first build starts over. Nothing is lost, because hold-set writes skip unchanged rows and the rebuild reads the truth.
- **Incremental.** Climbs past the watermark are re-derived 500 at a time. Each chunk edits only the postings its climbs enter or leave, and moves the watermark in the same short transaction.
- **Which climbs are indexed.** Only listed, published, not-hidden climbs. Hiding a climb bumps its `sync_seq`, and the next pass takes it out.
- **Postings are per layout.** Every downloaded size of a layout shares them, so builds run one at a time per layout.
- **Teardown generations.** Every clear of the index bumps a counter in `sync_meta` (`holds-index-generation:<board>:<layout>`, and `holds-index-generation:<board>` for a board-wide clear). A build reads the counter when it starts and re-reads it under each write lock. A teardown that lands mid-build, even one of a sibling size that leaves this scope's own markers alone, therefore stops the build before it writes rows from a read that predates the wipe.
- **Re-checked under the lock.** Each chunk re-reads its climbs' `sync_seq` under the write lock. A climb that a tombstone deleted since the unlocked read is skipped, and so is one that changed; a later pass derives the new version.
- **Yields between chunks.** The builder hands the JS thread back between chunks, and builds each posting list in a growable `Uint32Array`.
- **When it runs.** `pullSync` builds the index for each scope at the end of every cycle, after the completion markers are written, so it never holds up a download. A build failure is reported through `holdIndex.onError` and never fails the cycle. The mobile similar-climbs and heatmap readers, which ship in later PRs, will also call `ensureHoldIndex` before they query.
- **Cleanup.** A `board_climbs` tombstone takes the climb out of its postings and drops its hold set. Scope teardown clears the whole layout's index and every sibling scope's watermark, and a surviving sibling rebuilds on its next cycle. After a snapshot import, the orphan sweep deletes hold sets whose climb is gone and rebuilds that layout's postings. The spray sign-out wipe clears spray's hold sets, postings and watermarks. It also clears every hold set whose climb is already gone, then every local id that no hold set still uses, so no spray uuid is left behind. The explicit sign-out wipe clears all three tables.

`board_climbs` and `board_climb_hold_sets` both invalidate `['similarClimbs']`. `['holdHeatmap']` will join them when the heatmap's local reader ships; until then the drift test would reject a key that nothing reads.

### Expensive catalogue reads are local-only

Similar climbs is the first read registered with `networkPolicy: 'local-only'` (`packages/mobile/src/lib/graphql/offline-request.ts`). Its server resolver scans every hold row of the layout, so the server serves it to admins only. A local-only op never calls `getHttpClient()`: when the downloaded board can serve it, it reads SQLite (online or offline); when it cannot, it returns the op's empty fallback and records the unavailable reason, online included. There is no network-error rescue either, because there is no network request to fail. Without this, a non-admin whose board is not downloaded would fall through to the admin-gated resolver and see an auth error.

The caller picks the source with `useCatalogQuerySource(scope)` (`packages/mobile/src/lib/offline/use-catalog-query-source.ts`):

| Source | When | What the play drawer does |
| --- | --- | --- |
| `local` | the exact `(board, layout, size)` scope is in `syncEnabledBoards` and has its `scope-complete:` marker — the same check `isBoardDownloadedLocally` makes before its row probe | `offlineAwareRequest`; the first read builds the holds index, and the strip shows "Preparing similar climbs…" meanwhile |
| `network` | not downloaded, and the viewer is an admin (`useIsAdmin`) | `getHttpClient().request` directly, bypassing the interceptor |
| `download` | everyone else | no query; the section offers the download (`OfflineNudgeCard`, nudge surface `similar_climbs`, trigger `similar_climbs`, source `play_drawer`) for the active board when it is the drawer's exact board, and the plain empty state for a climb from any other board |

Supporters become one more branch next to the admin check. The hold heatmap will use the same hook and policy.

## Local-first while online, and when not to be

`offlineAwareRequest` currently serves local **while online** whenever the offline engine flag is on (`if (!isOnline || isOfflineEngineEnabled())`), and that flag is at 100%. For board reference data that is right — a local query beats a round trip and the background sync keeps it fresh.

For the logbook it is wrong. `GET_TICKS` selects `upvotes`, `downvotes`, `commentCount`, `effectiveQuality`, `boardseshDifficulty` and `boardseshConfidence`; `boardsesh_ticks.localColumns` has none of them. Most of that is harmless — the only consumer maps through `toLogbookEntry`, which drops `boardseshDifficulty`/`boardseshConfidence` outright and already falls back `effectiveQuality: tick.effectiveQuality ?? tick.quality` by design. The real degradation is exactly three fields: **`upvotes`, `downvotes` and `commentCount` read 0**. Serving that to a user with full signal is a regression, not an optimization.

So `OfflineOperation` gains `localFirstWhileOnline`, defaulting to `true` so today's five registrations keep their behaviour byte for byte. The logbook, playlists and favorites register with `false`: local is consulted only when the network is genuinely down. The trade is deliberate — those surfaces get no online latency win from a downloaded board, in exchange for never showing a degraded row to a connected user.

**If [#4312](https://github.com/boardsesh/boardsesh/issues/4312) removes the flag conditional, it must preserve the per-op opt-out.** Without it, `!isOnline || isOfflineEngineEnabled()` collapses to unconditional local-first and the online logbook silently starts showing zeroed social counts. This is the highest-risk cross-workstream interaction in the epic.

## Documented offline degradations

Two, both bounded and both deliberate:

- **Social counts read 0** on locally-served logbook rows. Offline only, because of `localFirstWhileOnline: false`.
- **Aurora twin collapse is an approximation.** The server's `ticks` resolver filters `notAuroraTwinDuplicate`; `syncTicks` does not, and it omits the `aurora_*`/`kilter_*` bookkeeping columns the predicate needs, so local rows include twins. Rather than sync five more columns and port a 60-line predicate, the local reader collapses rows sharing the full natural key **and** an identical payload, keeping `MIN(uuid)`. It under-collapses in the locally-edited case (shows two rows the server shows as one) and could over-collapse a byte-identical pair one second apart, which the rule's own documentation calls physically impossible. Blast radius: `aurora-twin-dedup.ts` measures 11 groups / 25 rows fleet-wide, and it is offline-only.

## Cache invalidation

A completed sync has to tell the UI. Today it mostly does not: `TABLE_CONFIGS[*].invalidateKeys` points at `['ticks']`, `['playlists']`, `['favorites']`, `['setterFollows']` and `['playlistFollows']`, none of which any reader uses, and the mutation drainer carries a near-duplicate map with the same dead keys. There is now **one** `TABLE_INVALIDATE_KEYS` map in `@boardsesh/offline-sync`, consumed by both, with a drift test that fails when a key has no reader.

Invalidation stays gated on rows actually landing (`if (totalProcessed > 0)`), and `invalidateQueries` refetches active queries only, so the cost of correcting the keys is bounded to whatever is on screen when rows genuinely moved.

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
