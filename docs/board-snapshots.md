# Board Snapshots

Canonical reference and ops runbook for the pre-built board-catalog snapshots that speed up first-time
offline sync on mobile. Code: `packages/backend/src/scripts/export-board-snapshots.ts` (export job),
`packages/shared/offline-sync/src/sync/{snapshot-manifest,snapshot-bootstrap,pull-client,checkpoints}.ts`
(shared client engine), `packages/mobile/src/offline/snapshot-source.ts` (mobile platform I/O).

The snapshots are also usable as a plain downloadable dataset — manifest URL, schema, and
consumption guidance live in `board-snapshots-dataset.md`.

## Why

Enabling a board offline means downloading its whole reference catalog: `board_climbs` +
`board_climb_stats` for every set at that layout, 200k+ rows on the bigger boards. Without a snapshot,
that catalog comes down as serial, authenticated GraphQL pages of 500 rows each (`PAGE_LIMIT` in
`pull-client.ts`) — 400+ round trips per user, every time someone enables a board for the first time.

The snapshot turns that into one CDN-cached `GET` of a pre-built SQLite file per `(boardType, layoutId)`,
followed by a normal incremental pull that only has to cover the gap between the snapshot's build time and
now. Once that gap reaches one full 500-row GraphQL page, a live-prefix threshold scan republishes the
affected layout so a bulk gap does not remain in the first-download path.

## Architecture

### Nightly export and live threshold refresh

`.github/workflows/export-board-snapshots.yml` runs `export-board-snapshots.ts` at **07:15 UTC** daily
for the full export and at **:07, :22, :37, and :52 every hour** for a bounded live-prefix scan
(`workflow_dispatch` also available), with `environment: Production` so it gets the Production secrets.
`concurrency.group: export-board-snapshots` with `cancel-in-progress: false` means overlapping runs queue
instead of stepping on each other. `queue: max` is important: GitHub's default single pending slot lets a
newer scan replace an older pending run, which could otherwise displace the nightly full export. The
offset avoids GitHub's busiest quarter-hour schedule boundary.

**Dual-publish.** The nightly runs the export **twice**, targeting two prefixes via `--key-prefix`
(default `board-snapshots/v1`):

- `board-snapshots/v1-gzip` — `--gzip`, ~2.6× smaller (`kilter:1` 271 MB → 103 MB as of 2026-07-27).
  **This is what the fleet reads**: every mobile workflow's `EXPO_PUBLIC_SNAPSHOT_BASE_URL` points here.
- `board-snapshots/v1` — **identity**-encoded, exactly the pre-gzip run. Nothing points at it any more; it
  stays live as the one-revert rollback target and as the public dataset base
  (`docs/board-snapshots-dataset.md`).

Each prefix is a self-contained, single-encoding manifest: the merge and prune logic below scope entirely
to whichever prefix the run targets, so a gzip run never reads or prunes the identity prefix. A later
cleanup drops the identity pass and deletes the `v1` prefix (see Rollout plan).

**Live threshold refresh.** The 15-minute schedule targets only `board-snapshots/v1-gzip`, the prefix the
fleet reads, with `--refresh-threshold 500`. For every discovered layout it reads the published manifest
watermark and runs a bounded cursor probe for `board_climbs`, `board_climb_stats`, and
`board_climb_grades`:

```sql
SELECT 1
FROM <table>
WHERE <layout scope and stability window>
  AND (<cursor timestamp>, sync_seq) > (<manifest timestamp>, <manifest seq>)
LIMIT 500;
```

The cursor timestamp is `updated_at` for climbs/stats and `computed_at` for grades. These are index-backed
`LIMIT` probes, never full `COUNT(*)` scans: a 300k-row catalog rewrite stops after finding row 500. A
layout is rebuilt when any table reaches 500 stable rows, when its manifest entry is missing, or when an
existing main/grades artifact has an older client schema. If the optional grades artifact is absent, the
grades probe starts at epoch and still requires 500 rows, so grade-less MoonBoard layouts remain a no-op.

Selected layouts go through the same repeatable-read build and artifact-first/manifest-last publish path
as the nightly. Layouts below threshold ride through the manifest byte-for-byte. If no layout is stale,
the command returns without uploading an artifact, rewriting `generatedAt`, invalidating the five-minute
manifest cache, or pruning. Threshold runs never prune or drop vanished entries because they are partial
by design. The full nightly remains responsible for the identity rollback prefix, removing vanished
layouts, and pruning old objects. Thus a genuine bulk catalog refresh reaches the CDN on the next scan
(scheduled every 15 minutes on a best-effort basis), followed by export time and up to five minutes of
manifest caching, instead of making every phone issue hundreds of authenticated requests indefinitely.

For every `(board_type, layout_id)` pair with at least one climb (`discoverLayoutPairs`), each pass:

1. Opens a `node:sqlite` file and applies DDL derived from the shared client `MIGRATIONS` — every
   migration statement that touches `board_climbs` or `board_climb_stats`, in version order, plus a
   `snapshot_meta` table (`boardSnapshotDdlStatements`). No hand-maintained DDL: a column added to the
   client schema shows up in the next artifact automatically.
2. Inside one Postgres `REPEATABLE READ` transaction, streams both tables through the **same row shaping**
   the live sync resolvers use (`row-normalize.ts` + `toSqliteValue`), so an artifact row is byte-identical
   to what an incremental `syncClimbs`/`syncClimbStats` pull would have written. `snapshot-export-golden.test.ts`
   pins that equivalence by running both paths against the same seeded rows and diffing them.
3. Excludes rows younger than `SYNC_STABILITY_WINDOW_SECONDS` (default 30s, same env var the resolvers
   read) — a row still inside its write-transaction's commit window is left for the incremental pull rather
   than risking a watermark that covers it before it's actually visible.
4. Computes each table's watermark — the max `(updated_at, sync_seq)` over the exported rows — from the
   **same transaction snapshot** as the row stream, and writes it into `snapshot_meta` alongside
   `row_count`, `schema_version` (`LATEST_SCHEMA_VERSION`), and `format_version`. The transaction also
   captures a conservative tombstone boundary into a metadata-only `sync_deletions` row: the oldest of
   run `builtAt`, export-transaction start minus `SYNC_STABILITY_WINDOW_SECONDS`, and the oldest active
   same-role transaction start. A second primary-pool connection samples `pg_stat_activity` while the
   export transaction is open but before its first artifact SELECT fixes the `REPEATABLE READ` snapshot.
   That ordering covers a delete transaction that began before the snapshot but committed after it.
   The row is omitted (clients use the legacy scoped-watermark fallback) if the pool has fewer than two
   connections, the activity probe fails, another-role client or prepared transaction exists in the
   database, activity tracking/visibility is incomplete, or any timestamp is invalid. Every per-layout
   build/upload log carries `deletionsReplayFrom` and `deletionsReplayFallbackReason`: success is a
   timestamp plus a null reason; fallback is a null timestamp plus one stable, low-cardinality reason.
5. Uploads the SQLite file to `<keyPrefix>/<boardType>/<layoutId>/<builtAt-colon-free>.db` — identity by
   default, or `gzip` (with `Content-Encoding: gzip`) under `--gzip`. The manifest's `contentEncoding`
   field records which, so the client stays agnostic.
6. After every artifact for the run has landed, writes `<keyPrefix>/manifest.json` **last**, so a
   reader only ever sees a fully-consistent old-or-new manifest, never a manifest pointing at an artifact
   that hasn't finished uploading.

#### Why the primary, never a replica

The sync cursor `(updated_at, sync_seq)` is **write-time** ordered, but an async replica's snapshot is
**commit-order** consistent. A row that commits late (or replicates late) can carry a lower cursor than
rows already visible on the replica — so a replica read can produce a watermark that covers a row the
artifact never actually contains. Every client that bootstraps from that artifact resumes strictly past
the watermark and **loses that row forever** (the strict `>` delta pull never revisits it). The stability
window only absorbs primary write→commit delay; replica lag stacks on top of it. The export always reads
the primary pool (`createPool()` from `@boardsesh/db/client`) for this reason — see the long comment at
`runExport`'s pool call site in `export-board-snapshots.ts`.

#### Merge semantics

The job fetches the currently-published manifest **before** touching S3 (`fetchPreviousManifest`), so a
bad read aborts the whole run with zero uploads. `mergeManifestEntries` then merges this run's fresh
entries over the previous manifest's, keyed by `(boardType, layoutId)`:

- A **filtered run** (`--board`/`--layout`) only rebuilds a subset, so every entry it didn't touch is kept
  verbatim — otherwise a filtered run would silently drop every other board from the manifest.
- A **threshold refresh** is also a partial run: only entries whose post-manifest delta reaches the
  threshold are rebuilt; all others are preserved verbatim. A clean scan performs no manifest write.
- Only an **unfiltered** run has the full picture, so only it may drop an entry whose layout no longer has
  climbs (passes `livePairs`; filtered runs pass `null` and keep everything).
- A layout whose export **failed** this run keeps its previous (still-valid, immutable) artifact entry —
  failures don't block the other layouts' refresh, and the whole run only fails at the very end, after
  every layout has been attempted.

Previous-manifest failure matrix (`fetchPreviousManifest`), because the merge above needs those entries to
avoid dropping data on a broken read:

| Previous manifest state        | Filtered or threshold refresh                           | Full unfiltered run                                                                                                                |
| ------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Missing (404/NoSuchKey)        | proceed, merge against empty (legitimately a first run) | same                                                                                                                               |
| S3 read error (anything else)  | **THROW**, no upload happens                            | **THROW**, no upload happens                                                                                                       |
| Present but invalid JSON/shape | **THROW** (can't reconstruct entries it would drop)     | warn + merge against empty (rebuilds every live layout anyway; only vanished layouts' entries are lost, and those drop regardless) |

### Storage layout and cache headers

- Artifacts: `<keyPrefix>/<boardType>/<layoutId>/<builtAt>.db`, `Content-Type: application/x-sqlite3`. The
  `v1` prefix uploads `contentEncoding: 'identity'`; the `v1-gzip` prefix (`--gzip`) uploads with
  `Content-Encoding: gzip` and records `contentEncoding: 'gzip'` in its manifest. `Content-Type` stays
  `application/x-sqlite3` either way — encoding is layered on top of type. Gzip artifacts are published in
  parallel so the fleet can be cut over only after iOS **and** Android both prove the downloaded file is
  decompressed on disk (see Rollout plan). No explicit `cacheControl` is passed to `uploadToS3`, so
  artifacts get the storage layer's default: `public, max-age=31536000, immutable`. Content-addressed by
  build timestamp — safe to cache forever, a new build gets a new key.
- Grades artifacts: `<keyPrefix>/<boardType>/<layoutId>/<builtAt>-grades.db`, same `Content-Type`, always
  gzip, and **published only in the `v1-gzip` pass** (issue #4310). Same content-addressed immutability as
  the whole-layout artifact. Referenced from the layout's manifest entry through the optional `grades`
  block, never as its own `entries` element — `findSnapshotEntry` first-matches on `(boardType, layoutId)`,
  so a sibling entry could be imported by an older client as if it carried the whole layout, stamping
  checkpoints past rows it never imported. Layouts with no grade rows (every MoonBoard layout: MoonBoard is
  deliberately outside `CROWD_MEAN_BOARDS`, see `docs/boardsesh-grade.md`) publish nothing.
- Manifest: `<keyPrefix>/manifest.json`, `Content-Type: application/json`,
  `Cache-Control: public, max-age=300`. Mutable and cheap to refetch, written last so it's the only object
  in the whole scheme that changes in place. Each prefix has its own manifest.

### Pruning

Artifacts superseded by a newer build for the same `(boardType, layoutId)` are deleted by
`pruneStaleArtifacts`, but only when **all** of the following hold:

- the run was **unfiltered** (a filtered run doesn't have the full manifest picture to prune safely), and
- the run was a **full export**, not a threshold refresh (a threshold scan intentionally leaves most
  entries untouched), and
- the run had **zero layout failures** (a failed night just defers pruning to the next green run).

An object is eligible for deletion when it's under the prefix the run targets (`board-snapshots/v1/` for
the identity pass, `board-snapshots/v1-gzip/` for the gzip pass) and NOT referenced by the manifest
just written — where "referenced" includes every surviving entry's `grades.key`, which is not in `entries`
and would otherwise be swept out from under live clients — **and** its `lastModified` is older than a **14-day grace window**
(`PRUNE_GRACE_MS`). The grace window exists because the manifest is CDN-cached for up to 5 minutes and a
client may hold a fetched manifest (with a now-superseded artifact URL) far longer than that before it
actually starts the download. Pruning is defensive by design: any failure (per-object or the whole scan) is
logged and swallowed, never fails the run.

## Artifact format

The whole-layout `.db` file carries exactly two **data tables** — `board_climbs` and `board_climb_stats` —
plus `snapshot_meta`. That data-table list has not changed since the first release and must not: every
shipped binary verifies its required metadata rows by table name and throws
`snapshot_meta missing row for <table>` when one is absent. The additive `sync_deletions` metadata row is
safe because old clients ignore rows they do not query; it does not add a data table. Boardsesh grades ride
in a separate file for exactly that reason (see "Grades artifact" below).

```sql
CREATE TABLE snapshot_meta (
  table_name TEXT PRIMARY KEY,
  watermark_updated_at TEXT,
  watermark_sync_seq TEXT,   -- decimal string; a Postgres bigint must never round-trip through a JS number
  row_count INTEGER,
  built_at TEXT,
  schema_version INTEGER,
  format_version INTEGER
);
```

There is one required row per data table (`board_climbs`, `board_climb_stats`) plus a metadata-only
`sync_deletions` row in newly-built whole-layout artifacts. The latter has `row_count = 0`,
`watermark_sync_seq = '0'`, and uses `watermark_updated_at` for the conservative deletion replay boundary.

These rows are artifact-level metadata for the whole `(boardType, layoutId)` artifact. A client importing
one narrower size scope uses them to validate the file, then computes its checkpoint watermarks from the
exact scoped rows it imports. This avoids stamping a size-scoped cursor past rows that were present in the
layout artifact but intentionally outside the enabled size.

- **`format_version`** — the shape of the manifest/artifact contract itself (currently `1`,
  `SNAPSHOT_MANIFEST_FORMAT_VERSION` in `snapshot-manifest.ts`). Bump this only on a breaking shape change
  (new required manifest field, changed meaning of an existing one) — see the runbook procedure below. It
  is a separate axis from the S3 key prefix's `v1` — see "Format-version bump" below for how the two relate
  in practice.
- **`schema_version`** — the on-device client schema version the artifact's DDL was built against
  (`LATEST_SCHEMA_VERSION` from `@boardsesh/offline-sync`'s migrations). An artifact whose schema is newer
  than the client is tolerated: bootstrap only imports columns present in both tables (`sharedColumns` in
  `snapshot-bootstrap.ts`), dropping artifact-only columns. An artifact **staler** than the client
  (`schema_version < LATEST_SCHEMA_VERSION`) is rejected client-side (`SnapshotSchemaStaleError`) rather
  than imported, because importing it would NULL-fill the client's newer columns and then stamp the resume
  cursor _past_ those rows — the strict `>` delta pull would never backfill them. A staler artifact is a
  **permanent miss for that run, no bootstrap attempt burned** — the scope falls back to the always-correct
  paged crawl, and the next live threshold scan rebuilds the stale-schema artifact.

### The two artifact sizes in a manifest entry

A manifest entry carries the artifact's size twice, and the two diverge once `--gzip` ships:

| Field               | What it is                                    | Who reads it                                                                                                                                                              |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bytes`             | Stored object size — what comes down the wire | **Every user-facing number.** The My Boards confirm-dialog size quote (`estimateScopeDownload`) and the download progress row both use it, so the two can never disagree. |
| `uncompressedBytes` | Decoded size — the SQLite file that hits disk | Internals only: the progress denominator on downloaders that write decoded bytes with no usable reported total, and the exact free-disk-space precheck. Never rendered.   |

Under `--gzip` the decoded size runs several times `bytes` (Kilter layout 1: ~103 MB stored, ~271 MB
decoded). Showing the decoded figure in the progress row would contradict the number the user just accepted
in the confirm dialog, so it never reaches the UI.

`uncompressedBytes` is **optional and additive** — no `format_version` bump, since an old client simply
ignores the key. Every entry published before the field existed omits it, and the merge path carries those
entries through untouched, so a reader must handle `undefined`. It only starts appearing on the first
export run after the field ships: the nightly runs at 07:15 UTC, or dispatch
`.github/workflows/export-board-snapshots.yml` manually to fill it in sooner.

### Grades artifact (issue #4310)

`board_climb_grades` is a per-board table the scope-completion gate waits on, but the whole-layout artifact
never carried it — so every Kilter and Tension download paid hundreds of serial authenticated GraphQL
pages for grades after the artifact had already landed. The natural experiment: `moonboard:2` (20.0 MB,
93,939 climbs, **zero** grade rows) has a p50 of 14.5s, while `tension:9` (17.1 MB, 72,051 climbs, ~79k
grade rows) takes 1m27s. Same bytes, same import shape, ~6x the duration.

The fix is a second, standalone artifact per layout:

- Contents: the `board_climb_grades` DDL from the shared MIGRATIONS, that layout's grade rows, and a
  **one-row** `snapshot_meta`.
- Scope: the same correlated `EXISTS` over `board_climbs` that `syncClimbGrades` uses, plus the stability
  window — cursored on **`computed_at`**, not `updated_at`. Grades have no `updated_at` column. The cursor
  column is declared once in `TABLE_CONFIGS[...].cursorColumn` (`@boardsesh/offline-sync`) and read from
  there by both the export and the client, so the two cannot disagree about which column a watermark
  covers.
- Consistency: written inside the **same** `REPEATABLE READ` transaction as the whole-layout artifact, so
  the grade rows and the climbs they hang off come from one database snapshot.
- Kill switch: publish a manifest with no `grades` anywhere (or roll back to the identity `v1` prefix,
  which never carries grades) and every client reverts to today's crawl with no deploy.

Client side (`bootstrapScopeGradesFromSnapshot`), the grades file is imported in its **own** exclusive
transaction immediately after the climbs/stats one, not merged into it. Merging would close a crash window
but lengthen a single `BEGIN EXCLUSIVE` hold on a database the app is also reading (issue #4314); splitting
keeps each hold short, and the worst case is exactly today's behaviour — no grades checkpoint gets stamped
and the scope crawls grades as it always did. There is no reconcile step: `board_climb_grades` has no
delete trigger at all, so `INSERT OR REPLACE` is the whole import, and `rewindDeletionsCheckpoint` stays
`min(climbs, stats)`.

Two entry points, both free to fail:

1. Straight after a successful whole-layout import.
2. **Retro-fit** — a scope whose climb catalog is already COMPLETE (`bootstrap-done:<scope>`: the
   whole-layout artifact landed, or `scope-complete:<scope>`: the paged crawl reached every table's tail)
   but whose `checkpoint:board_climb_grades:<scope>` is ABSENT. An absent grades checkpoint proves no grade
   page was ever consumed (`syncTable` checkpoints per page), so importing and stamping at the artifact's
   watermark cannot skip a row the crawl already had. This is what rescues every scope downloaded before
   grades artifacts existed. The completeness gate is load-bearing: the import filters the artifact's grades
   through `main.board_climbs`, so over a half-crawled catalog it would stamp the grades cursor past every
   grade row whose climb has not been fetched yet, and the strict `>` delta never revisits those.

Grades failures use their own budget (`grades-bootstrap-attempts:<scope>`, cap 2) and never touch
`bootstrap-attempts` — losing the grades fast path must never cost a scope its snapshot fast path. A
download that returns `null` counts against that budget exactly as a throw does; otherwise a source that
signals failure by returning `null` would re-fetch the artifact every cycle forever.

## Client bootstrap flow

Implemented in `snapshot-bootstrap.ts` (the ATTACH/import/verify mechanics) and orchestrated from
`pull-client.ts`'s `runBootstrapPhase`, which runs **before** the deletions phase of every sync cycle.

**Connectivity gate**: `pullSync` returns immediately when the injected `isOnline()` probe says the device
is offline, mirroring `drainMutationQueue`'s entry guard. The probe defaults to `() => true`, so only the
mobile adapter (React Query's `onlineManager`, wired to NetInfo) actually gates anything; web is unchanged.
Without it, every offline launch ran the whole bootstrap phase and emitted one Sentry event per
enabled-but-undownloaded scope (issue #4238). The scheduler's offline→online edge re-runs the skipped cycle.

**Eligibility** (`evaluateBootstrapEligibility` in `sync/bootstrap-retry.ts`, called by BOTH
`runBootstrapPhase` and `estimateScopeDownload` so the size the UI quotes can never disagree with what the
engine does). A board scope (`boardType:layoutId:sizeId`) qualifies in one of two ways:

- **fresh** — no checkpoint on either snapshot-backed table (`board_climbs`, `board_climb_stats`).
- **heal-over-partial** — it HAS checkpoints, has **not** reached `scope-complete:`, has not already
  imported an artifact, and can jump the rest of the climbs/stats crawl from an artifact. Failure history
  is not required: an older launch could begin the 500-row crawl before its snapshot flag/source resolved,
  leaving a checkpoint but no recorded snapshot failure. The automatic heal is still restricted to an
  unmetered link and the watermark-regression guard below prevents it from moving progress backwards. If
  the climber explicitly re-enables the scope and accepts the size-disclosing dialog, that consent arms the
  same one-shot `userRequested` override as **Try the fast download again**, including on a metered link.

Both also require that neither retry budget is spent and that any scheduled cooldown has elapsed. A
`scope-complete:` scope is never healed — it already serves the whole catalog locally, so ~100 MB buys it
nothing. The ordinary paged sync still downloads `board_climb_grades` before a scope is reported complete
(it is not in `SNAPSHOT_TABLES`), so a heal removes part of the slow path, not all of it. One artifact
download is shared across every size of the same `(boardType, layoutId)` within a cycle.

**Failure taxonomy and budgets** (issue #4313). Before this, `MAX_BOOTSTRAP_ATTEMPTS = 2` conflated retry
frequency with the total-spend bound. The artifact GET is still not resumable, but failed transfers now
retry on a scheduler alarm rather than waiting for an unrelated foreground/reconnect. Because a dropped
connection at the DOWNLOAD stage burned the same counter as a corrupt artifact, two bad-reception launches
condemned a board to the 400+-round-trip crawl for the life of the install. Kind-specific budgets bound
total spend; the cooldown ladder and scheduler alarm bound frequency.

| Kind                  | Raised by                                                                            | Budget                                | Cooldown ladder      | Re-armed by a new `builtAt`?                         |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------------------------- | -------------------- | ---------------------------------------------------- |
| `transport`           | network/DNS/TLS/timeout, short body, or iOS background-session decode interruption   | `MAX_TRANSPORT_DOWNLOAD_FAILURES` = 3 | 2 min → 15 min → 2 h | no                                                   |
| `structural-artifact` | anything raised inside the import (`quick_check`, `snapshot_meta` mismatch, throw)   | `MAX_BOOTSTRAP_ATTEMPTS` = 2          | 6 h → 24 h           | yes, `MAX_STRUCTURAL_REARMS` = 1 per scope, lifetime |
| `structural-device`   | every other non-transport cause (disk space, cache dir, CDN non-2xx, unclassifiable) | `MAX_BOOTSTRAP_ATTEMPTS` = 2          | 6 h → 24 h           | **no**                                               |

A successful download resets `transportFailures` to 0 and drops its cooldown. Every manifest failure is
cap-exempt because the manifest is one global object shared by all enabled scopes: charging a per-scope
budget for one malformed or unavailable response could terminal every board on the device. A 404 or an
unsupported manifest format fails open to the paged path. Network, HTTP, malformed JSON, and malformed
current-format responses skip the fresh crawl and schedule another manifest attempt in 30 seconds. After
two consecutive waits, the third failure starts the paged crawl and schedules a lower-frequency five-minute
probe; this keeps the fast path recoverable without leaving every fresh board empty during a broken publish.
The consecutive counter is process-local and keyed to the database's global wipe epoch, so it cannot write
after sign-out or carry one account's state into another. A new process gets the same two-attempt grace.
The mobile manifest request itself aborts after 15 seconds, so a native fetch that never resolves cannot
hold the scheduler's global single-flight latch indefinitely.
Everything after manifest resolution is charged normally. The `structural-device` default is deliberately
conservative: a plain downloader error cannot be told apart from a disk-full or cache-dir fault.

**Worst-case lifetime spend per scope: 7 artifact downloads** — 3 transport + 2 structural + 2 for the
single re-armed structural round — each separated by at least one cooldown rung. A test in
`snapshot-bootstrap.test.ts` drives 40 cycles against an injected clock and pins that count, so any future
loosening shows up in a diff.

When either budget is spent the scope is **terminal**: `bootstrap-paged-fallback:` is stamped and the
manifest is not even fetched for it (cheaper than the pre-#4313 over-cap path, which consulted it every
cycle). The one exception is a terminal scope whose last failure was `structural-artifact` and which has a
re-arm left — that one still reads the manifest, because a differently built artifact is exactly what could
fix it. Terminal is cleared by scope teardown or by the user tapping **Try the fast download again** in My
Boards, which restores both budgets behind the same size-disclosing confirm dialog the enable toggle uses.

**Cooldowns and scheduler alarms.** A persisted `retryAfter` is also registered with
`startSyncScheduler`, including when it is first observed after a cold launch. The earliest absolute
deadline wakes a drain+pull cycle; later scope deadlines remain armed, ad-hoc download triggers feed the
same coordinator, and scheduler cleanup cancels its alarms. The paged skip is still a grace window: only a
FRESH, non-terminal scope whose retry lands within 30 minutes waits for it. Past that window the crawl runs,
and a scope that already holds rows keeps crawling while a failed heal cools down. Failures outside snapshot
bootstrap (queue drain, deletions, paged GraphQL, or SQLite) arm a separate 30-second cycle retry, so a
foregrounded connected app does not depend on a later reconnect or foreground event to resume.

**The metered-network probe.** `SyncOptions.isOnUnmeteredNetwork` (default `() => true`, so web and every
existing caller are unchanged) gates ONE decision: the automatic heal of a partly-crawled scope, which is a
~100 MB download the user did not ask for that day. On a metered link the heal defers 6 hours and burns
nothing. A fresh bootstrap (they just confirmed the size) ignores it, and so does a user-requested retry:
`restoreBootstrapRetryBudget` arms a `userRequested` flag on the persisted state, `runBootstrapPhase` skips
the defer while it is set, and the flag is spent the instant the download starts (one tap, one artifact).
The ordinary enable dialog does the same for an incomplete checkpointed scope whenever it quotes the
snapshot size, keeping the UI promise and the engine's transport decision aligned.
That last part matters — a settled scope has always crawled, so it can only ever come back as a
heal-over-partial, and without the flag "Try the fast download again" was a silent 6-hour deferral on
cellular. A recovery on that path reports `trigger: 'user-request'`.

**The watermark-regression guard.** `bootstrapScopeFromSnapshot` takes the scope's current board-table
checkpoints on the heal path and throws `SnapshotWatermarkRegressionError` — before opening the exclusive
transaction, so nothing at all is written — when either table's artifact watermark compares older than the
local checkpoint. That covers both hazards at once: an artifact whose scope filter matches no rows
(`tableWatermark` returns the epoch, reachable for a size whose `compatible_size_ids` never matches or
after any export/client filter drift), and a crawl that already ran past the artifact. Without it the
import would lower `checkpoint:board_climbs:<scope>` — destroying exactly the progress the heal exists to
rescue — and rewind the single global deletions cursor with it. It is reported at full severity
(`expected: false`) because it means the export's scope filter and the client's disagree.

The refusal **burns the structural-artifact budget**, like any other import failure. That is not bookkeeping
pedantry: the refusal is deterministic for a given artifact (local checkpoints only move forward), so a
refusal that recorded nothing left the scope exactly as eligible as before and pulled the whole ~100 MB
again on every single sync cycle, forever. Charged, it costs at most 2 downloads (6 h then 24 h apart) plus
the one re-armed round a genuinely newer `builtAt` can grant.

With `W ≥ C` enforced the coverage argument is simple: rows ≤ C are already local, the artifact supplies
every scoped row ≤ W, `reconcileScope` removes local scoped rows ≤ W absent from the artifact, and the
checkpoint moves forward to W with the strict-`>` delta covering (W, head].

**Rollback safety: the legacy dual-write.** `bootstrap-retry:<scopeKey>` (a JSON `BootstrapRetryState`) is
the source of truth, but `writeBootstrapRetryState` also mirrors the legacy `bootstrap-attempts:` /
`bootstrap-attempts-healed:` / `bootstrap-paged-fallback:` rows and **never deletes them**. Production
branch rollback and `pr-<n>` preview branches are live paths here: an older bundle that read no legacy row
would re-arm a fresh 2-attempt round plus another one-shot heal. Reads reconcile the other way too — if the
legacy counter moved past what we last mirrored (`mirroredAttempts`), an older bundle counted something
real and the difference is folded back into `structuralFailures`. On first touch,
`migrateLegacyBootstrapMarkers` derives a state from the legacy rows and grants one clean pass under the
new taxonomy (the old counter conflated transport with structural, which is the bug); a scope that already
holds rows gets a `retryAfter` jittered across 2 hours so the fleet does not start downloading on the same
post-OTA launch. The legacy rows are never deleted, but the first write after a migration does re-stamp
`bootstrap-attempts:` down to the mirrored value — the clean pass has to be visible to a rolled-back bundle
too, or it would re-read the pre-migration count and settle the scope all over again.

A scope torn down from **More → Storage** becomes eligible again: `removeBoardScopeData`
(`sync/scope-teardown.ts`) clears all three board-data checkpoints **and** its `bootstrap-attempts:` /
`bootstrap-attempts-healed:` / `bootstrap-done:` / `bootstrap-paged-fallback:` / `bootstrap-retry:` markers
in the same transaction as the rows, so a re-download takes the snapshot fast path rather than a paged
crawl — and `onScopeDownloadComplete` attributes it honestly instead of reporting a stale
`method: 'snapshot'` for a run that actually paged. The marker prefixes stay package-internal (not
re-exported from `index.ts`). `BOOTSTRAP_METADATA_QUERY` is built from `BOOTSTRAP_METADATA_PATTERNS` rather
than hand-written, and a test asserts the placeholder count matches, so adding a prefix cannot silently
drop one. Grades-import attempt counts are engine-only too: they are read by exact key when that importer
runs and intentionally stay out of the whole-layout UI metadata query.

Per-stage outcomes, copied from the `runBootstrapPhase` doc comment (the source of truth — keep this in
sync if the code comment changes):

| Condition                                                            | Budget burned           | Result this cycle                                                                         |
| -------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `scope-complete:` / `bootstrap-done:`                                | —                       | not eligible → normal delta/paged pull                                                    |
| incomplete scope with board checkpoints                              | —                       | heal on unmetered; a size-confirmed re-enable also heals on metered                       |
| `isOnline()` reports offline                                         | —                       | whole cycle skipped before the phase starts; retried on reconnect                         |
| a scheduled retry has not elapsed                                    | —                       | not eligible this cycle; crawl runs unless the retry is inside the 30-minute grace window |
| terminal, last failure `structural-artifact`, re-arm left, new build | — (grants a round)      | budget restored once → snapshot path runs                                                 |
| terminal, otherwise                                                  | —                       | settled → normal paged pull, manifest not fetched                                         |
| heal-over-partial on a metered link                                  | **no** (defers 6 h)     | normal paged pull                                                                         |
| the same, with `userRequested` armed by the retry action             | — (spends the tap)      | snapshot path runs now; recovery reports `trigger: 'user-request'`                        |
| manifest `absent` (404/missing or unsupported format version)        | **no**                  | permanent miss this cycle → normal paged pull                                             |
| manifest `error` (transport, HTTP, invalid JSON/current shape)       | **no** per-scope        | wait twice at 30 s; third failure starts paged sync and probes again in 5 min             |
| manifest `ok` but no entry for `(boardType, layoutId)`               | **no**                  | permanent miss (not exported yet) → normal paged pull                                     |
| download fails or returns `null`, transport-shaped                   | `transport`             | 2 min ladder; paged pull skipped while the retry is imminent                              |
| download fails or returns `null`, anything else                      | `structural-device`     | 6 h ladder; crawl runs                                                                    |
| download throws `SnapshotPermanentMissError`                         | `structural-device`     | full bytes were spent; bounded retry ladder, with paged progress this cycle               |
| import throws — corrupt/short artifact, row-count/format mismatch    | `structural-artifact`   | 6 h ladder; a new `builtAt` may re-arm it once                                            |
| import loses the write lock (`SQLITE_BUSY`/locked) after its ladder  | `database-locked`       | own 3-strike budget on the 2 min ladder; artifact kept; never re-armed by a new build     |
| import throws `SnapshotSchemaStaleError`                             | **no**                  | permanent miss this run → normal paged pull                                               |
| import throws `SnapshotWatermarkRegressionError`                     | `structural-artifact`   | nothing written → normal paged pull; 6 h ladder; reported `expected: false`               |
| a sign-out wipe is detected mid-phase                                | **no**                  | whole phase bails, mirrors `syncTable`'s wipe guard                                       |
| success                                                              | transport counter reset | marked done; deletions rewound; paged pull runs as a small delta from scoped watermarks   |

The `transport counter reset` on that last row is why `database-locked` is not a transport failure: a
retained artifact reaches it having moved zero bytes.

Resumable / ranged artifact downloads are **not deliverable client-side**, and are nobody's open work item.
Artifacts ship gzip-encoded and rely on the native stack to decode, so byte-offset resume would need a JS
gunzipper (a native dependency, OTA-forbidden) — and the CDN measurement in
"Why continuation and not persisted pause/resume" below proves `Range` addresses ENCODED bytes while both
platforms write DECODED bytes to disk. This paragraph used to assign resume to issue #4310 while the same
document disproved it a few hundred lines down. The cheap-failed-transfer problem it was reaching for is
real (26–31% of Kilter transfers fail and discard ~99 MB); the answer is artifact **sharding**, tracked in
issue #4721 with its trigger condition named.

**Import mechanics** (`bootstrapScopeFromSnapshot`). Since issue #4310 the import is **not one
transaction**. It is an autocommit preamble, then a sequence of short exclusive transactions with the lock
released between every one of them.

_Autocommit preamble, holding no lock:_ `ATTACH`es the downloaded file as `bs_snapshot`, runs
`PRAGMA quick_check` (rejects a truncated/corrupt file before touching any row), verifies `snapshot_meta`
(format version, schema version, and that `row_count` matches the artifact's actual row count — catches a
truncated download the integrity check alone might miss), computes watermarks from the exact scoped rows
inside the artifact, applies `busy_timeout` and `synchronous = NORMAL`
(`applyBulkImportPragmas` — the pragma is rejected inside a transaction, and without it every batch commit
would pay an fsync), and stages this scope's climb UUIDs into a TEMP table. Every refusal — stale schema,
watermark regression, bad meta — happens here, so a refused artifact still writes exactly zero rows.

_Then, one short exclusive transaction at a time:_

- **Reconcile** (its own transaction). Deletes stale local `board_climbs`/`board_climb_stats` rows for this
  scope whose cursors are at or before the scoped watermarks but absent from the artifact. This keeps a
  later bootstrap from overlaying a newer artifact on top of rows that vanished from the exported scope.
  Still **unbatched**: cheap on a fresh scope, unbounded on a heal-over-partial (#4313) or a second size of
  an already-downloaded layout, which is why it is reported separately as `importReconcileMs`.
- **N row transactions** of `SNAPSHOT_IMPORT_BATCH_ROWS` (5,000) rows each. `board_climbs` is filtered by
  the scope — `board_type = ? AND layout_id = ?`, plus (for size-scoped boards; MoonBoard is the one
  exception, `isSizeScopedBoard`) a `json_each` membership check against `compatible_size_ids`, mirroring
  the resolver's `boardClimbsScope` exactly; that is what the TEMP staging table holds, so the membership
  parse is paid once instead of once per stats row. `board_climb_stats` is scoped by a semi-join against
  that staging table — the same set the correlated `EXISTS` over the artifact used to select — and batched
  on its PRIMARY KEY with SQLite **row-value** syntax, `board_type = ? AND (climb_uuid, angle) > (?, ?)`.
  The row-value form is load-bearing: the expanded `a > ? OR (a = ? AND b > ?)` shape re-scans the whole
  `board_type` partition on every batch (verified with `EXPLAIN QUERY PLAN`), which would make a batched
  import slower than the single statement it replaces. A test pins the query plan.
- **A final transaction** stamping both table checkpoints at the scoped imported-row watermarks and
  rewinding the deletions cursor.

**The invariant that replaces all-or-nothing.** Rows can now be committed without checkpoints; checkpoints
can never be committed without their rows, because they live only in the final transaction. That asymmetry
is the one `scope-teardown.ts` is written around: rows without markers is benign (the next bootstrap
re-imports over them, `INSERT OR REPLACE` is idempotent, and a teardown still removes them), markers
without rows is unrecoverable, because the strict `>` delta pull never revisits anything at or below a
stamped cursor. `synchronous = NORMAL` is safe under the same rule — WAL is replayed to its last valid
frame, so a later commit can never survive an earlier one being lost.

The final transaction also:

- **Rewinds the deletions checkpoint** to the artifact's `sync_deletions` replay boundary with deletion
  cursor `syncSeq = '0'`, in the _same_ transaction as the import. Deletion cursors page over deletion-row
  ids, not board table `sync_seq` values. A 30-second stability boundary alone is not safe: a delete
  transaction can run longer, remain invisible to the snapshot, then commit afterwards with an older
  `deleted_at`. The exporter therefore includes the oldest visible same-role `xact_start`; it samples from
  a second connection before the RR snapshot is acquired, so a commit cannot disappear from activity while
  remaining invisible to an already-fixed artifact snapshot. `pg_stat_activity` exposes full details to
  ordinary users only for same-role sessions, so production writers and the exporter deliberately share
  one DB role. Any other-role client fails the optimization closed. Prepared transactions are absent from
  `pg_stat_activity`, so their presence does too. Old artifacts and malformed/missing/future optional
  metadata fall back to the older scoped row watermark. Rewind and checkpoints commit together, and after
  every row batch, so a crash cannot permanently strand tombstones against the freshly-imported scope.

The following deletions pull applies each fetched tombstone page **and that page's checkpoint** in one
SQLite exclusive transaction. Playlist-child cleanup, resurrection guards, and composite-key validation
run inside that same transaction. A failed tombstone rolls back the whole page; a successful page pays one
lock/commit instead of one autocommit per row. Expo opens the wrapper with deferred `BEGIN`, so the page
first rewrites its current deletion cursor to acquire SQLite's writer lock, then rechecks the global purge
epoch. It checks again before publishing the fetched cursor; a purge that wins the lock makes the page roll
back, while a purge that starts after the page owns the lock necessarily clears the cursor after commit.

**Wipe-epoch guard**: a sign-out wipe or a scope purge can start (or fully complete) across any of the
`await`s above. The bootstrap captures the monotonic wipe epoch before its first `await`, re-checks it (and
the signing-out flag) in the preamble, and again **inside every exclusive transaction, after the lock is
held**. Holding the lock first is what makes it sound: `beginScopePurge` latches before its delete
transaction takes the lock, so either a batch wins the lock and commits (and the purge's own DELETE then
removes what it wrote), or the purge wins and the batch reads the latch and bails. A mismatch throws
`SnapshotWipedError` — possibly leaving committed rows, never a checkpoint — and the pull-client treats it
as a bail-out, not a counted failure.

**A lost lock race is not a bad artifact.** Batching turns one lock acquisition into ~143 against writers
that genuinely exist, so a batch that loses `BEGIN EXCLUSIVE` outright retries on a short ladder
(250/750/2000 ms), and a lock-shaped import failure is classified `database-locked` — its **own** budget,
`MAX_BOOTSTRAP_LOCK_FAILURES = 3`, on the transport cooldown rungs. The retained artifact is not deleted on
that path either.

Neither existing budget could hold it. `structural-artifact` strands the board after two strikes and
deletes the ~103 MB file, for a fault the artifact did not cause. `transport` fails the other way:
`clearTransportFailures` runs after every successful download, and a **retained** artifact is handed back
off disk with zero bytes moved — so a device with persistent write-lock contention would charge 1, get
reset, charge 1, forever, never reaching a cap, while `shouldSkipPagedPull` kept skipping the crawl on the
2-minute cooldown. The board would be unreachable by _both_ paths. With its own counter the third failure is
terminal, so the paged crawl runs and the board still lands, slowly. A new `builtAt` does **not** re-arm it:
tonight's export cannot win a lock race either.

**Import telemetry** (`Offline Board Download Completed`, all absent-when-unknown). Two different filters:

- The six `import*` props — filter on `importMs IS NOT NULL`. `importVerifyMs` (the autocommit preamble),
  `importReconcileMs`, `importRowsMs`, `importBatches`, `importLockWaitMs`, and `importLockMaxMs` — the
  longest SINGLE exclusive hold, which is the number to read before changing the batch size or the
  local-write retry ladder. `importMs` itself is the whole call and was never a lock hold; two in-repo retry
  ladders were once sized as if it were.
- The three `grades*` props (`gradesDownloadMs`, `gradesVerifyMs`, `gradesLockMs`) — filter each on its own
  `IS NOT NULL`, **not** on `importMs`. The grades retrofit path imports grades for a scope that is already
  bootstrapped, in a cycle with no whole-layout import, and that is exactly the still-crawling population
  issue #4719 is about. The grades import is still one unbatched exclusive transaction.

`importLockMaxMs` is stamped from after `BEGIN EXCLUSIVE` succeeds, so it is a hold and never a wait; the
wait (busy_timeout blocking plus the retry ladder's sleeps) is reported separately as `importLockWaitMs` and
subtracted out of `importReconcileMs`/`importRowsMs`. One cost does stay inside the holds: SQLite attempts a
WAL autocheckpoint at COMMIT and the engine leaves the 1000-page default in place, so where the single
pre-#4310 transaction paid that once at the end, a minority of batches now pay a passive checkpoint inside
their COMMIT. Read the `importLockMaxMs` tail with that in mind rather than against the ~150 ms typical
batch `SNAPSHOT_IMPORT_BATCH_ROWS` is sized from.

**Query-cache invalidation**: because the delta pull that follows a successful bootstrap may legitimately
return zero documents (the snapshot already satisfied the scope), and `syncTable`'s cache invalidation only
fires on non-empty pages, `runBootstrapPhase` explicitly invalidates the `board_climbs`/`board_climb_stats`
query keys right after a successful import — otherwise an active search/detail query would keep serving the
pre-import empty result set.

## Mobile wiring

- **Pre-download size estimate (the manifest's second consumer)**: the My Boards confirm dialog
  ("Download {board}?") quotes the artifact size before the user commits —
  `entry.bytes` for the layout, formatted by `packages/mobile/src/lib/format-bytes.ts`. The manifest
  comes from `useSnapshotManifest()` (`packages/mobile/src/offline/use-snapshot-manifest.ts`), a React
  Query wrapper around the **same** `SnapshotSource.fetchManifest` the engine is handed (`staleTime`
  5 min, mirroring the object's `max-age=300`), warmed on screen mount so the dialog never awaits a
  fetch. The decision of _whether a number can be quoted at all_ lives in
  `estimateScopeDownload` (`snapshot-estimate.ts`), which mirrors `runBootstrapPhase`'s eligibility
  rules and returns `unknown` — falling back to sizeless copy — whenever the paged crawl would run
  instead: no manifest, an existing checkpoint on either board table (a re-enabled board resumes as a
  small delta, so the full artifact size would be a lie), attempts at `MAX_BOOTSTRAP_ATTEMPTS`, no
  entry for the layout, or a schema-stale entry. `findSnapshotEntry`/`isSnapshotEntryUsable` are
  shared with `runBootstrapPhase` so the UI can never disagree with the engine about which artifact a
  scope would download. Note `bytes` is the **stored** object size — the wire figure, and deliberately
  the same scale the download progress row renders, so the dialog and the bar can never disagree.

- **Download progress (issue #4311)**: `runBootstrapPhase` emits three staged frames per scope on the
  existing `onProgress` sink — `manifest` → `download` → `import` — carried as
  `SyncProgress.snapshot` (`SnapshotBootstrapProgress`). A payload is only ever attached to a
  `phase: 'bootstrap'` frame whose `currentTable` **is** the scope key, which is how a row matches it;
  the throttle behind it is cancelled in the phase's `finally` so a late native callback can't re-light
  a finished row. Every number on the frame is **wire scale**: `wireBytes` is `entry.bytes` and
  `wireBytesDone` is `fraction × entry.bytes`, so no renderer can reach the decoded size.

  The denominator lives in `resolveDownloadFraction` (`snapshot-progress.ts`). The platform counter
  counts bytes **written to disk**, so the denominator has to be the size of the file that ends up
  there — decoded for a gzip entry — never the compressed transfer size, whoever reports it. In order:
  `uncompressedBytes` for a gzip entry, floored against the platform's own total
  (`max(uncompressedBytes, reportedTotalBytes)`); then the reported total when positive and not a gzip
  entry's wire size; then `entry.bytes` for identity; then `null` = indeterminate (byte counter, no
  bar). iOS is why the first rule exists: URLSession pairs a decoded `totalBytesWritten` with a
  Content-Length `totalBytesExpectedToWrite`, so dividing by the reported total raced the bar to 100%
  once 103 MB of a 271 MB stream had landed — about 38% in. Android has no total at all (OkHttp gunzips
  transparently, so `contentLength()` is -1). A gzip artifact exported before `uncompressedBytes`
  shipped stays indeterminate for the whole download rather than showing a bar 2.6× too fast; re-running
  the export workflow closes that. The denominator is latched on the first frame that has a candidate
  and never re-picked, which is what keeps the fraction monotonic — the throttle **drops** backwards
  frames rather than clamping them, so a mid-download re-scale would freeze the row until the raw
  fraction climbed back past its old high-water mark. If the counter still runs >2% past the
  denominator, the download latches indeterminate rather than pinning at 100%. expo's synthetic terminal
  frame (`bytesWritten === totalBytes`, carrying the decoded on-disk size) is read as "complete", never
  as a data point — a gzip entry's wire-scale total is excluded from that check first, since the decoded
  counter passes it mid-flight.

  Frames are throttled to one per 400 ms plus a rounded-percent/rounded-megabyte change gate — Android
  emits natively every 100 ms, which is ~5,300 events over an 8m52s Kilter download.

  Byte progress is permanently enabled on native. `useSnapshotSource` always hands out the full source,
  including progress, cancellation, artifact retention, and the grades artifact. There is no PostHog
  cohort that can silently lose byte progress or retention behaviour.

- **Backgrounding: a pocketed phone pauses a download, it does not kill it (issue #4390)**. The rule
  `runBootstrapPhase` encodes is **start new work only in the foreground; never kill work already in
  flight**. A wipe / sign-out / board removal still aborts the transfer the instant it lands — the rows
  the artifact is for are being deleted, so its bytes are worthless — but a backgrounding does not. On
  Android the process stays alive, so simply not cancelling is the whole fix there.

  Whether a dead transfer counts as a free **pause** or a real transport failure is a deliberately
  narrow test, and both halves matter:
  - the **suspension window** must still be open. It opens when the app backgrounds mid-transfer and
    **closes on the first byte delivered in the foreground** — after that the transfer demonstrably
    survived the pocket, so a later failure belongs to the network or the device. Without the closing
    rule, one screen lock during a nine-minute Android transfer would launder every subsequent wifi
    drop, HTTP 500 or disk error into a free, cooldown-free 100 MB retry loop.
  - the cause must be **transport-shaped**: either `isNetworkError` (for example
    `NSURLErrorNetworkConnectionLost`, a timeout, or a `SocketException`) or iOS background
    URLSession's exact `cannot decode raw data` response-decoding interruption. A disk-full or HTTP 500
    is not a pause.

  Free pauses are **bounded at three per scope** (`MAX_FREE_BACKGROUND_PAUSES`, persisted as
  `BootstrapRetryState.backgroundPauses`). The fourth is charged to the **transport** budget on its
  ladder, so the worst case terminates at 3 free + 3 transport restarts, after which the board still
  arrives via the paged crawl and "Try the fast download again" is the consented escape. Any completed
  download resets the counter (`clearTransportFailures`) — landed bytes prove the device can finish one.
  The bound also closes a hole that predates this work: a self-aborted background transfer used to be
  free with no bound at all. An older bundle rolled back onto the new row reads the missing key as 0 and
  simply loses the bound, which is the pre-#4390 behaviour, not a corruption.

  A transfer that **finishes** while backgrounded is never a pause. The file is on disk with its
  `.complete` sidecar, the phase hands it back through `releaseArtifact({ imported: false })`, and the
  next foreground cycle returns it as `reused: true` with zero bytes re-fetched. The grades stage
  follows the same rule: `importGradesForScope` checks the teardown reason before spending one of the
  three attempts that artifact ever gets.

- **Download transport (issues #4394 / #4390)**. Every snapshot uses expo-file-system's DownloadTask.
  `resolveSnapshotDownloadStrategy` (`packages/mobile/src/offline/download-strategy.ts`) selects only by
  `Platform.OS`:

  | Platform | Strategy          | Reason                                                                               |
  | -------- | ----------------- | ------------------------------------------------------------------------------------ |
  | iOS      | `task-background` | A background URLSession keeps a large transfer alive while the app is suspended.     |
  | Android  | `task-foreground` | Android ignores session type, but DownloadTask uses its task-specific OkHttp client. |

  The strategy is fixed for the bundle lifetime. No feature-flag resolution can restart the scheduler or
  replace a transfer's transport mid-download. Continue watching `sizeMismatch`,
  `reason: 'permanent-miss'`, `reason: 'background-transfer-decode'`, and `wireKbps`; the gzip sniff and
  paged fallback remain the safety net if a platform HTTP stack ever stops decoding
  `Content-Encoding: gzip` transparently. The exact iOS decode interruption is a known transport failure,
  not a structural device defect: within an open suspension window it gets the bounded free-pause path;
  otherwise it uses the normal transport ladder instead of the six-hour structural cooldown.

  Both platforms are real task arms: Android ignores `sessionType` but a `DownloadTask` builds
  its **own** `OkHttpClient` (60 s connect/read/write timeouts), while iOS hands the transfer to a
  background URLSession so it can continue while the app is suspended.

- **Why continuation and not persisted pause/resume.** Measured against the live CDN object on
  2026-08-13: `Content-Encoding: gzip` comes back **unconditionally** (even under
  `Accept-Encoding: identity` — it is stored-object metadata, not negotiated), `Accept-Ranges: bytes`,
  strong ETag, and `Range: bytes=0-15` returns `206` with `Content-Range: bytes 0-15/102416919` and a
  body starting `1f 8b` — so **Range addresses ENCODED bytes**. Both platforms write **decoded** bytes to
  disk. expo's Android resume computes its offset as the destination file's length
  (`FileSystemDownloadTask.kt:92`) and sends `Range: bytes=<decoded>-` (line 112): provably wrong for
  every gzip artifact we publish, off by 2.6× on kilter:1, with no JS-side fix. **Never enable Android
  resume** until the artifacts are served identity-encoded or expo's offset moves to encoded byte space.
  iOS `resumeData` validity over a `Content-Encoding` response cannot be established off-device and is
  treated as unproven. Background-session continuation needs no byte-space reasoning at all.

  Residual gap, stated honestly: if iOS **terminates** the app (force-quit or a memory-pressure kill),
  expo's dispatcher has no delegate on relaunch and the finished temp file is dropped — that download is
  lost and the next foreground restarts at 0. A merely _suspended_ app keeps its delegate and resolves
  on resume, which is the common case.

- **Exact decoded-size gate (#4394)**. Before the `.complete` sidecar is written, the finished file's
  size is compared against `entry.uncompressedBytes` — exact, because the export writes
  `rawBuffer.length`, the SQLite file's own byte length. A mismatch deletes the file, reports a handled
  error, and throws `SnapshotArtifactTruncatedError` → funnel reason `artifact-truncated`, charged to the
  **transport** budget (a short body is a cut-short response; `structural-device` would durably settle a
  scope onto the paged crawl after two occurrences). It runs **after** the gzip sniff, so a
  still-compressed body keeps reporting `permanent-miss`. Absent `uncompressedBytes` — every gzip grades
  block and every pre-#4311 layout entry — the gate is skipped; an `identity` entry gates on
  `entry.bytes`, which there IS the decoded size. A retained artifact's size is re-verified before its
  sidecar is trusted, so a survivor the OS truncated is re-downloaded rather than ATTACHed.

- **Superseded-partial sweep**: artifacts for an older `builtAt` of the same (board, layout) are deleted
  at the **top** of `downloadSnapshotFile`, before the free-space precheck, as well as after a successful
  download. A 271 MB stale partial used to sit in the cache until the next download succeeded — which it
  might not, because that partial counted against the precheck the new download had to pass.

- **Per-transfer telemetry**: every transfer that moved bytes emits `Offline Artifact Transfer` with
  `strategy`, `wireBytes`, `wallMs`, `firstByteMs`, `wireKbps`, `backgroundedDuringTransfer` and friends
  (full prop contract in `packages/shared/analytics/src/events.ts`). A reused artifact emits nothing, so
  the denominator is always real network work. Read `wireKbps` only where
  `backgroundedDuringTransfer = false`: a suspended transfer's `wallMs` includes wall-clock time nobody
  was downloading.

- **Not on `main`, ever** — these need a native fingerprint change and belong on a `[native-train]` draft:
  the `URLSessionConfiguration` knobs behind #4394's Low Data Mode hypothesis
  (`allowsConstrainedNetworkAccess`, `allowsExpensiveNetworkAccess`, `waitsForConnectivity`,
  `networkServiceType`, `delegateQueue`), restoring background-session delegates on relaunch, and
  surfacing `X-Tigris-*` response headers from a download task. All of them live in expo-file-system's
  Swift, reachable only via a pnpm patch (`vp exec pnpm patch`) or an upstream PR.

- **Download fallback status**: My Boards keeps the normal per-row download state (`pending`,
  `downloading`, `finalizing`, or `downloaded`) and separately derives a `BoardDownloadNotice` from the persisted
  attempt, done, and explicit paged-fallback markers plus board checkpoints. The explicit outcome closes
  the ambiguous failure-then-permanent-miss path; checkpoints keep a restored or flag-toggled mid-crawl
  scope from being labelled as a retry after restart. Active bootstrap always outranks persisted history,
  while pending and active paged fallback use different copy. The screen reads all enabled scopes' markers
  with index-backed `GLOB` prefix ranges in one SQLite query into an O(1) map, refreshes after each scope's
  bootstrap decision settles, and refreshes again on each `onScopeDownloadComplete` callback rather than
  waiting for a multi-scope cycle to finish. The full transition message wraps instead of truncating.
  Android exposes it as the only polite live region; iOS announces semantic notice changes through
  VoiceOver explicitly. The changing climb count remains readable but is never auto-announced per page.
  An active paged crawl always outranks a future fast-path retry notice, so the row shows the slower-path
  explanation and its live count instead of a static “Faster download interrupted” spinner while 500-row
  pages are landing.
  Once a snapshot's durable import marker lands, that row stays `finalizing` throughout work on sibling
  snapshots and shared deletion/user-data phases instead of falling back to “Waiting to download.” A
  scope on the paged fallback has no import marker and therefore never gets that label prematurely.

- **Per-connection ATTACH invariant (BOARDSESH-AA)**: expo-sqlite's
  `withExclusiveTransactionAsync` runs its task on a **new native connection**
  (`useNewConnection: true`), and SQLite `ATTACH`es are per-connection — anything attached on the
  main connection does not exist inside the task. The bootstrap therefore attaches, verifies, and
  imports entirely on the transaction's own connection (`snapshot-bootstrap.ts`, see the
  COMMIT → ATTACH → `BEGIN EXCLUSIVE` bracket). The node test double mirrors this: a **file-backed**
  `createTestDatabase(path)` opens a separate connection for exclusive transactions, so any suite
  exercising ATTACH/temp-table/PRAGMA state inside a transaction must be file-backed — the
  in-memory double's same-connection transactions are what let this bug ship at 100% test green.

- **`EXPO_PUBLIC_SNAPSHOT_BASE_URL`** (`packages/mobile/src/lib/env.ts`) — base URL for
  `<base>/manifest.json`; each manifest entry carries its own absolute artifact URL, so this constant is
  only used for the manifest fetch. There is deliberately **no production fallback**: if the env var is
  unset or empty, `OfflineSyncBridge` does not pass `mobileSnapshotSource` to the scheduler and fresh
  boards use the paged crawl. Set this as a real EAS build-time env var. `EXPO_PUBLIC_*` vars are inlined
  at build time, not read at runtime, so this needs a new build to take effect, not just a config change.
- **No PostHog gates**: native offline downloads, snapshot bootstrap, byte progress, and the fixed task
  transport are baked on. `useSnapshotSource` (`packages/mobile/src/offline/use-snapshot-source.ts`)
  hands out the full source whenever `EXPO_PUBLIC_SNAPSHOT_BASE_URL` is configured; a missing build-time
  URL is the only reason it returns `undefined`. Expo web remains unsupported and keeps the native engine
  disabled through its platform fork.
- **No lost wake after an offline-surface tap**: `armBoardsOffline` persists the enabled scope, then reads
  current NetInfo reachability. If reconnect landed just before the setting write, that read starts the
  cycle and synchronizes React Query's online singleton before the pull guard runs. A rejected or
  stale-negative read gets two bounded re-probes; if the link remains unreachable, the scheduler's next
  reachability edge reads the durable setting. This closes the ordering window that otherwise left a
  reachable device on “Waiting to download” with no future edge to wake it.
- **Bounded offline GraphQL requests**: only the client used by the mutation drainer and pull engine has a
  30-second hard deadline. It forwards caller cancellation and aborts the underlying native request, but
  releases the scheduler even if the platform fetch never settles. Interactive GraphQL calls keep their
  existing transport behaviour. A deadline failure reaches the ordinary 30-second cycle retry rather than
  holding the global single-flight latch forever.
- **Interrupted cycles terminalize their live status**: every expected background/offline/purge/sign-out
  exit emits `phase: 'idle', interrupted: true`. This clears the per-board spinner without stamping
  `lastSyncedAt`. Bootstrap and grades downloads also latch a cycle teardown across their native awaits,
  so a foreground event that arrives before a rejection is handled queues a fresh cycle instead of letting
  the stale one continue into deletions or paged pulls.
- **Gzip magic-byte sniff** (`packages/mobile/src/offline/snapshot-source.ts`): identity artifacts skip
  gzip verification. For manifest entries with `contentEncoding: 'gzip'`, the expectation is that the
  native HTTP stack (`NSURLSession` / OkHttp via `expo-file-system`'s `DownloadTask`)
  transparently decompresses the object while downloading. `looksGzipCompressed` reads just the first two
  bytes of the downloaded file and checks for the gzip magic number (`0x1f 0x8b`). If they're still present
  — the stack did **not** auto-decode — the file is deleted, the download throws
  `SnapshotPermanentMissError` (the structural-device budget is charged because all bytes were already
  spent, while paging can still progress in the same cycle), and a handled error is
  reported to Sentry with
  `tags: { source: 'offline-sync', kind: 'snapshot-bootstrap' }`. This client does not attempt to gunzip
  the file itself — it relies on the native stack's transparent decode, and the sniff is the safety net if
  that assumption is ever wrong on a given platform/build (fresh boards fall back to the paged crawl, never
  a crash). This is why the fleet is only pointed at the `v1-gzip` prefix after that decode is verified
  on-device (see Rollout plan).
- **Telemetry**:
  - `Offline Board Download Completed` (PostHog, `SHARED_EVENTS.OfflineBoardDownloadCompleted`) fires once
    per scope's first-download completion (climbs, stats, and grades all reached the tail), with method
    `snapshot` or `paged` and `durationMs` measured from the start of the sync cycle's work on that scope (so a
    `'snapshot'` scope's duration includes its manifest/download/import time, not just the trailing delta
    pull — an apples-to-apples comparison against a full paged crawl). A HEALED scope carries
    `bootstrapHealed: true` and must be filtered out of those percentiles: its duration excludes the paged
    work earlier cycles already did. Both fields read the persisted `bootstrap-done:` row (its presence for
    `method`, its value — `'heal'` vs `'1'` — for `bootstrapHealed`) rather than anything in-memory, because
    completion routinely lands cycles after the import.
  - Sentry handled errors, `tags: { source: 'offline-sync', kind: 'snapshot-bootstrap' }`, for every
    bootstrap failure (manifest/download/import stage, with
    `scopeKey`/`stage`/`attempt`/`expected`/`cause`/`causeName` in `extra`) and for the gzip-sniff failure
    above. Transport-shaped failures carry `expected: true`, report at `level: warning`, and are additionally
    tagged `expected_offline` — they are a phone with no signal, not a defect. `expected` is a severity signal
    only: at the manifest stage it also skips the attempt counter, but a transport-shaped download failure
    still burns an attempt (see the matrix above). The real exception is attached as the wrapper's `cause`,
    which is what lets the shared classifier recognise them at all (issue #4238).
  - `Offline Sync Cycle Failed` records a bounded `phase`, `currentTable`, document count, HTTP status,
    and stable error kind when a whole drain/pull cycle throws. It never sends raw exception text. An
    unchanged signature is emitted at most once per five minutes; unexpected failures also reach Sentry
    under the same throttle. Reporter failures are swallowed by the scheduler so telemetry cannot suppress
    the failed-idle frame or retry alarm.

## Download funnel events

Six PostHog events (`@boardsesh/analytics`'s `SHARED_EVENTS`) make board downloads measurable
end-to-end (issue #4316). Before them the feature had exactly one — `Offline Board Download
Completed` — so abandonment was structurally unmeasurable and failures went only to Sentry.

| Event                              | When                                                                                   | Key props                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `Offline Board Download Started`   | first time any cycle starts pulling a scope, once ever                                 | `scopeKey`, `pathIntent`, `artifactBytes`, `trigger`, `offlineEngineEnabled`          |
| `Offline Board Download Completed` | both board tables reached the tail, once ever                                          | `scopeKey`, `method`, `durationMs`, `bytes?`, `rowCount?`, `downloadMs?`, `importMs?` |
| `Offline Board Download Failed`    | a bootstrap attempt ended without succeeding, or something ended the download for good | `scopeKey`, `stage`, `attempt`, `expected`, `reason`, `aborted`, `errorMessage`       |
| `Offline Board Download Cancelled` | progress detail when a board is switched off mid-snapshot; 0 events in 180 days        | `scopeKey`, `source`, `stage?`, `fraction?`, `bytesDone?`                             |
| `Offline Board Toggled`            | the offline switch was flipped, either way                                             | `scopeKey`, `enabled`, `source`                                                       |
| `Offline Download All Tapped`      | the "download all my boards" switch was TAPPED                                         | `boardCount`                                                                          |

**The once-ever contract.** Started and Completed are each guarded by a durable `sync_meta`
marker — `scope-started:<scopeKey>` and `scope-complete:<scopeKey>` — so the funnel query is
simply Started → Completed, with no first-occurrence de-duplication needed. Both markers sit
**outside** the `checkpoint:` prefix, so signing out leaves them alone (matching the board rows,
which survive as a shared cache), and both are cleared by `scope-teardown.ts` in the same
transaction as the rows, so removing and re-adding a board starts a fresh funnel.

Getting this wrong breaks the metric in both directions, which is why the marker exists at all: a
paged crawl writes a board-table checkpoint on its **first page**, and `runBootstrapPhase` treats
any existing checkpoint as ineligible — so a per-cycle Started gated on "no checkpoint yet" would
emit **no Started at all** for the multi-cycle crawls that are the most likely to be abandoned,
while a retrying snapshot would emit **several**.

A scope that is **already complete** the first time this code sees it — every board on a device that
upgrades into the funnel build — gets its `scope-started:` marker written but emits **no** Started.
It can never emit Completed again either (that marker is already set), so announcing it would post
one unmatched Started per already-downloaded board on the first cycle after release: a phantom
abandonment spike in exactly the window the baseline is read from.

> **If a future change wipes board data on logout** (issue #3621), it must clear both markers in the
> same transaction as the rows. Otherwise the next sign-in emits Completed with no Started.

**A marker is not the only thing that can orphan a Started.** `pullSync`'s board loop iterates the
scopes in `syncEnabledBoards` and nothing else, so a board that leaves that list is never visited
again — its `scope-started:` marker can survive perfectly intact and still describe a download
nothing will ever finish. Anything that de-lists a board therefore owes the funnel a terminal, even
when it deletes no rows at all. See "every path that ends a download" below.

**The terminal-event invariant: every Started has exactly one terminal event.** A snapshot bootstrap
attempt ends in `Offline Board Download Completed` (its scope finished) or `Offline Board Download
Failed` (everything else, teardowns included) — never in silence. Field reports kept arriving that
looked impossible: a Started carrying a 103 MB `artifactBytes`, then nothing at all — no Completed,
no Failed, no Sentry event — and the cycle moving on to the next board two minutes later.

`runBootstrapPhase` has a dozen ways out (`break`, `continue`, a `throw` from any of the ~15 awaited
SQLite writes that sit **outside** the import's own `try`, a consumer callback like `onProgress`
raising back into the loop), and reporting them one site at a time only ever covers the sites
somebody remembered. So the invariant is structural: the phase arms
`createDownloadFunnelGuard` (`packages/shared/offline-sync/src/sync/download-funnel-guard.ts`) at the
Started emission and closes it from a `finally`. An attempt that reaches that `finally` with no
terminal event recorded emits one:

| Exit                                         | `reason`                          | `aborted` | Sentry |
| -------------------------------------------- | --------------------------------- | --------- | ------ |
| sign-out / wipe epoch bump / board removal   | `aborted-wipe`                    | `true`    | no     |
| app backgrounded                             | `aborted-background`              | `true`    | no     |
| an exception unwinding the phase             | classified (`database-locked`, …) | `false`   | yes    |
| anything else — a bail-out nobody registered | `unknown-exit`                    | `false`   | yes    |

Two rules keep it honest. **No double-emit**: every explicit report settles the guard through the
shared wrapper in `runBootstrapPhase`, and a successful import settles it too — its terminal event is
the Completed the board-data loop fires once the delta pull reaches every table's tail, which on
Kilter is usually cycles later. **No burn**: every guard-emitted report carries `attempt: 0`; the
guard is a bystander and never spends the scope's retry budget.

`unknown-exit` should sit at **zero**. Anything else means an exit path exists that the phase cannot
explain, and it is the one abort-shaped outcome that still goes to Sentry (`source: offline-sync`,
`kind: snapshot-bootstrap`, `reason: unknown-exit`) for exactly that reason.

**The invariant is scoped to the snapshot bootstrap.** A paged crawl is multi-cycle by design — an
interrupted one has not failed, it is simply not finished — so the board-data loop does not report
per-cycle aborts, and a paged Started legitimately stays open until its Completed lands. Slow
abandonment on that path is still measured as a Started with no Completed after N days, not as a
Failed.

**Except when the board is removed** (issue #4406). That is the one exit that ends a download for
good: `removeBoardScopeData` deletes the `scope-started:` marker along with the rows, so once it
commits nothing can tell an abandoned download from a board that was never downloaded. It therefore
reads `scope-started:` / `scope-complete:` **before** its transaction and, when a download had
announced itself and never completed, reports one
`Offline Board Download Failed { stage: 'board-removed', reason: 'abandoned-removed', aborted: true, attempt: 0 }`
after the commit. Unlike every other abort-shaped reason it fires **at most once per Started**, which
makes "downloads the climber gave up on" a count rather than a subtraction. A removal landing
mid-**bootstrap** would otherwise produce two terminals for one Started — the phase's own
`aborted-wipe` and this one — so both claim against the purge generation `beginScopePurge` bumped
(`sync/download-terminal-registry.ts`), and only the first claim reports.

### Every path that ends a download, and which reports

Issue #4452 widened the removal terminal above to every other ender. The full list, so the next
person can check it rather than re-derive it:

| How a download ends                                                             | Reports today                                                                                                      |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| it finishes                                                                     | `Offline Board Download Completed`                                                                                 |
| board removed from Storage (`removeBoardScopeData`)                             | `Failed { stage: 'board-removed', reason: 'abandoned-removed' }` (#4406)                                           |
| explicit sign-out / account deletion (`purgeLocalDataForSignOut`)               | `Failed { stage: 'abandoned', reason: 'abandoned-signed-out' }` — read before the wipe transaction, emitted after  |
| forced 401, proactive token expiry, identity change (`clearUserData` + de-list) | `Failed { stage: 'abandoned', reason: 'abandoned-signed-out' }` — from `runSignedOutCleanup`, markers then cleared |
| My Boards toggle-off                                                            | `Failed { stage: 'abandoned', reason: 'abandoned-disabled' }`, plus `Offline Board Toggled { enabled: false }`     |
| a de-list that crashed before reporting, or a device upgrading into this build  | the launch backstop in `offline-sync-bridge.tsx`, as `abandoned-disabled`                                          |
| the owner-stamp mismatch wipe (`clearUserData` in the bridge)                   | nothing, and correctly: it de-lists nothing, so the scope keeps downloading                                        |
| the app is backgrounded, or a sibling board's removal tears the cycle down      | `Failed { aborted: true, reason: 'aborted-background' / 'aborted-wipe' }` — an interruption, the download resumes  |
| process death, uninstall, a climber who never opens the app again               | **nothing, and nothing can.** Per production this is the dominant unterminated bucket                              |

The three `abandoned-*` reasons are the once-per-Started ones. The de-list paths **clear**
`scope-started:` and `scope-download-started:` (`clearScopeDownloadFunnelMarkers`) and nothing else:
the rows and the `checkpoint:` keys stay, so a re-enable still resumes instantly. Two Starteds for a
toggle-off-then-on is the intended reading — as far as the funnel is concerned those are two
downloads, and a durable marker outliving its download is what made abandonment unmeasurable in the
first place.

They clear **before** they report, and each scope's close is independently fault-tolerant. The clear
is the only step that can fail (a locked database); `track()` cannot. Reporting first would emit the
terminal and then leave the marker behind for the next launch's sweep to report a second time, so a
failed clear now emits nothing and the sweep becomes the single reporter — exactly one terminal
either way. Wrapping each scope separately keeps one locked write from silently dropping the rest of
a sweep.

Sign-out reports through **two** seams for one reason: the explicit wipe runs `deleteAllSyncMeta`, so
only code inside that function can still see the markers, while the selective sign-outs keep every
marker and are ended purely by `setSetting('syncEnabledBoards', [])`. The claim in
`download-terminal-registry.ts` therefore keys on a **composite** `wipeEpoch:purgeEpoch` generation:
`setSigningOut(true)` moves only the global wipe epoch and `beginScopePurge` only its namespace's, so
a namespace-only key would let a stale `aborted-wipe` from an unrelated board removal suppress a real
sign-out terminal. The de-list paths do **not** claim — nothing tore a cycle down for them, and the
cleared marker is the durable dedup.

`runSignedOutCleanup` also moved `resetAnalytics()` to **after** the offline cleanup. Every sign-out
event — the discarded outbox, `Offline Data Wiped On Sign Out`, and these terminals — has to land on
the account that is leaving; production showed every wipe event sitting on a different `person_id`
from the `Logout` half a second earlier, which made all of them unjoinable.

**What this still does not cover.** Started → Completed will not reach 100% and is not meant to. Over
the funnel's first weeks in production, of the (person, scope) pairs with a Started and no Completed,
the majority emitted _nothing at all_ after the Started — same first and last timestamp, no toggle,
no logout. That is process death, uninstall, or a climber who moved on, and no code change can emit
an event for it.

**A removal also re-arms the scheduler.** A removal latches its namespace for the seconds its delete
transaction runs, and every purge guard in the pull client reads that latch as "purged" — so a cycle
that starts inside the window skips the scope from top to bottom. That is correct (it must not write
into a delete) but it also consumes the trigger, and the scheduler has no interval: a board switched
back **on** during a removal used to sit on "waiting to download" until the next foreground or
reconnect, which on Marco's phone meant nine hours and an app relaunch. `startSyncScheduler` now
subscribes to `onPurgeSettled` and runs a cycle when the window closes — but only when a
still-enabled board needs that namespace, so an ordinary removal costs no cycle.

**Reading the props.** `pathIntent` on Started is an INTENT from cheap local facts, not an outcome —
a snapshot-eligible scope can still fall back to the paged crawl after the manifest resolves. Split
by resolved path using Completed's `method`. `bytes`/`rowCount`/`downloadMs`/`importMs` are absent
(not zero) when the completing delta pull lands in a **later cycle** than the import — the
dropped-connection tail — which biases those four toward the healthy population; `durationMs`,
`method`, and the funnel ratio itself are unaffected.

**Trigger vocabulary.** `trigger` separates deliberate taps from automatic re-enables, which is what
#4318's discovery nudges are measured against: `toggle` and `download-all` are taps;
`auto-download-all` (the More screen's mount effect acting on the persisted setting) and
`adopt-auto` (a discovered board adopted because `autoOfflineBoards` is on) are not; plus
`adopt-confirmed`, `retry`, and `unknown`. It is persisted per scope
(`settings/offline-boards.ts`'s `rememberDownloadTrigger`), not held in memory, because the case
that matters most is a board enabled with no signal whose download runs on a later launch — an
in-memory map loses exactly that one. `unknown` is an explicit, expected value.

## Ops runbook

### Manual export

From CI: trigger `.github/workflows/export-board-snapshots.yml` via `workflow_dispatch` (GitHub UI or
`gh workflow run export-board-snapshots.yml`).

From a local shell, from `packages/backend/`:

```sh
DATABASE_URL=<primary connection string> \
AWS_S3_BUCKET_NAME=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_ENDPOINT_URL=... AWS_DEFAULT_REGION=... \
node --import tsx src/scripts/export-board-snapshots.ts \
  [--dry-run] [--gzip] [--key-prefix <prefix>] [--refresh-threshold <rows>] \
  [--board <boardType>] [--layout <layoutId>]
```

- `--dry-run` builds artifacts locally (in a temp dir, cleaned up after) and logs sizes/row counts, but
  never uploads anything and never touches the manifest. Works with **no AWS credentials at all**. It
  cannot be combined with `--refresh-threshold`, whose selection requires reading the live manifest.
- `--gzip` compresses artifact objects and publishes manifest entries with `contentEncoding: 'gzip'`.
  Pair it with `--key-prefix board-snapshots/v1-gzip` so gzip artifacts land beside — never overwrite — the
  identity `v1` rollback prefix.
- `--key-prefix <prefix>` (default `board-snapshots/v1`) targets a self-contained prefix: its own manifest,
  merge, and prune, isolated from every other prefix. Validated against a safe key charset. The nightly
  workflow uses it to publish `v1` (identity) and `v1-gzip` (gzip) in one run.
- `--refresh-threshold <rows>` reads that prefix's current manifest and rebuilds only layouts with at
  least that many stable rows after any artifact-table watermark. The production schedule uses `500`
  with `--gzip --key-prefix board-snapshots/v1-gzip`; the identity rollback remains a nightly full export.
  A scan with no stale layout makes zero S3 writes. Missing manifests recover by rebuilding every
  discovered pair; invalid manifests abort before upload because a partial run cannot merge safely.
- `--board`/`--layout` filter to a subset. A filter matching **zero** `(boardType, layoutId)` pairs is
  treated as an operator error and throws loudly (e.g. `--board=kilterr` typo) rather than silently leaving
  that board's artifacts stale.
- `DATABASE_URL` must point at the **primary**, never a read replica (see the rationale above) — this is
  read-only-sufficient (the export only `SELECT`s) but the write-time/commit-order mismatch on a replica is
  a correctness bug, not a permissions one.

### Verify deletion replay metadata after a live full refresh

After an unfiltered full gzip refresh, inspect the `Export board snapshots (gzip →
board-snapshots/v1-gzip)` job logs before treating the refresh as complete. Every rebuilt layout — including
Kilter, Tension, and So iLL — must have a non-null `deletionsReplayFrom` and
`deletionsReplayFallbackReason: null` in its `[export-snapshots] uploaded` record. The live gzip pass refuses
to replace a layout's previous manifest entry when the boundary is unavailable and fails the run after the
remaining layouts finish; the next queued refresh retries it. Identity exports and dry-runs remain log-only
so operators can diagnose the environment without blocking the live pass. The bounded reasons are
`observer-pool-capacity`,
`activity-probe-failed`, `exporter-transaction-not-observed`, `activity-visibility-incomplete`, and
`invalid-probe-timestamp`; none include database session details.

Then verify the objects actually published behind the live manifest, not just the local build result. This
uses a no-cache request plus a unique query tag so the manifest's five-minute CDN TTL cannot return the
pre-refresh object. It checks every current layout artifact against the same metadata gates as the client:

```sh
set -euo pipefail
snapshot_check_dir="$(mktemp -d)"
snapshot_manifest="$snapshot_check_dir/manifest.json"
manifest_url='https://boardsesh-board-snapshots.t3.tigrisfiles.io/board-snapshots/v1-gzip/manifest.json'
manifest_cache_tag="$(date +%s)"
latest_schema_version="$(vp node --import tsx -e \
  "import('./packages/shared/offline-sync/src/db/migrations.ts').then(({ LATEST_SCHEMA_VERSION }) => console.log(LATEST_SCHEMA_VERSION))")"
curl -fsSL -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
  "$manifest_url?verify=$manifest_cache_tag" \
  -o "$snapshot_manifest"

jq -e --argjson current_schema "$latest_schema_version" '
  .formatVersion == 1
  and (.entries | length) > 0
  and all(.entries[];
    (.schemaVersion | type) == "number"
    and .schemaVersion >= $current_schema
    and (.builtAt | type) == "string"
    and (.url | type) == "string")
' "$snapshot_manifest" >/dev/null

selected_artifacts="$(jq -r '.entries[]
  | [.boardType, (.layoutId | tostring), .builtAt, (.schemaVersion | tostring), .url]
  | @tsv' "$snapshot_manifest")"
if [ -z "$selected_artifacts" ]; then
  echo 'FAIL live manifest contains no layout artifacts' >&2
  exit 1
fi

while IFS="$(printf '\t')" read -r board_type layout_id manifest_built_at manifest_schema_version artifact_url; do
  artifact_path="$snapshot_check_dir/$board_type-$layout_id.db"
  curl -fsSL --compressed "$artifact_url" -o "$artifact_path"
  replay_meta="$(sqlite3 "$artifact_path" \
    "SELECT deletions.watermark_updated_at || char(9) || deletions.built_at
     FROM snapshot_meta AS deletions
     JOIN snapshot_meta AS climbs ON climbs.table_name = 'board_climbs'
     JOIN snapshot_meta AS stats ON stats.table_name = 'board_climb_stats'
     WHERE deletions.table_name = 'sync_deletions'
       AND deletions.row_count = 0
       AND deletions.watermark_sync_seq = '0'
       AND deletions.format_version = 1
       AND climbs.format_version = 1
       AND stats.format_version = 1
       AND deletions.schema_version = $manifest_schema_version
       AND climbs.schema_version = $manifest_schema_version
       AND stats.schema_version = $manifest_schema_version
       AND deletions.schema_version >= $latest_schema_version
       AND deletions.built_at = climbs.built_at
       AND deletions.built_at = stats.built_at
       AND julianday(deletions.built_at) IS NOT NULL
       AND julianday(deletions.watermark_updated_at) IS NOT NULL
       AND julianday(deletions.watermark_updated_at) <= julianday(deletions.built_at)
       AND climbs.row_count = (SELECT COUNT(*) FROM board_climbs)
       AND stats.row_count = (SELECT COUNT(*) FROM board_climb_stats)")"
  IFS="$(printf '\t')" read -r replay_from artifact_built_at <<< "$replay_meta"
  if [ -z "$replay_from" ] || [ "$artifact_built_at" != "$manifest_built_at" ]; then
    echo "FAIL $board_type:$layout_id artifact/manifest deletion metadata mismatch" >&2
    exit 1
  fi
  echo "OK $board_type:$layout_id $replay_from <= $artifact_built_at"
done <<< "$selected_artifacts"
```

The timestamp on the left may be much older than `built_at` when a long-running same-role transaction was
open during export; that is expected and is the safety property.

The optimized replay boundary exists only in newly published live gzip artifacts. Older artifacts, the
identity rollback prefix, and a live manifest retained by the CDN for up to five minutes use the compatible
legacy rewind to table watermarks, which can replay a much longer deletion history. Deploy the client and
exporter first, complete this unfiltered live gzip refresh, and wait for the canonical manifest cache to
serve the verified keys before using multi-board download speed as release evidence.
That compatibility fallback can also miss a tombstone from a transaction that began before its scoped
watermark; only a verified live gzip replay boundary carries the stronger long-transaction guarantee.

### Required Production secrets

Set on the `Production` GitHub environment (referenced by the workflow): `DATABASE_URL`,
`AWS_S3_BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL`,
`AWS_DEFAULT_REGION`. The workflow also accepts the Tigris console's exported names
(`AWS_ENDPOINT_URL_S3`, `AWS_REGION`) so rotating keys stays copy-paste. `SYNC_STABILITY_WINDOW_SECONDS`
is an optional `vars.*` passthrough (only needed if the backend's stability window is ever configured off
its 30s default — the export reads the same env var so the two stay in lockstep).

The Production environment restricts deployments to `main`, so `workflow_dispatch` runs of the export
must be dispatched from `main` — a feature-branch dispatch fails immediately with a branch-policy
rejection and zero log output.

**Public URL base (Tigris quirk)**: the manifest's per-artifact `url` fields must be fetchable
unauthenticated. Tigris serves public objects **only** on the bucket's virtual-host domain
(`https://<bucket>.t3.tigrisfiles.io/<key>`); the S3 endpoint's path-style form that `getPublicUrl`
builds (`https://t3.storage.dev/<bucket>/<key>`) returns 403 for anonymous GETs even on a public
bucket. The workflow therefore sets `SNAPSHOT_PUBLIC_BASE_URL` (not a secret — it appears in every
manifest) and the export re-bases entry URLs onto it. Keep it consistent with
`EXPO_PUBLIC_SNAPSHOT_BASE_URL` in the mobile workflows: the mobile value is
`${SNAPSHOT_PUBLIC_BASE_URL}/board-snapshots/v1-gzip`.

### Recovery controls

Native offline downloads, snapshot bootstrap, progress, and transfer strategy have no PostHog kill
switches. Recover by fixing or withdrawing the published snapshot inputs:

- **Grades only** (issue #4310): the grades import runs only when the manifest entry carries a `grades`
  block, so publishing a manifest without one — or rolling the fleet back to the identity `board-snapshots/v1`
  prefix, which never publishes grades — reverts every client to the paged grades crawl with no deploy. It
  is a slower download, not a broken one.
- **Nuclear, affects every client regardless of flag state after cache expiry**: delete the
  `board-snapshots/v1-gzip/manifest.json` object from the bucket — that's the prefix the fleet reads;
  deleting `board-snapshots/v1/manifest.json` stops nothing. The manifest is cached for up to 5 minutes
  (`Cache-Control: public, max-age=300`), so clients that already fetched it may keep bootstrapping until
  that cache entry expires. After that, `fetchManifest` returns a 404 → `absent` → permanent miss, no
  attempt burned, straight to the paged crawl. Restoring after a manifest delete must use an unfiltered
  export/workflow run first: a filtered export merges against the now-empty manifest and publishes only the
  filtered entries, temporarily hiding every untouched layout until an unfiltered run restores the full
  index.

### When the catalogue pass fails

The `board-snapshots/v1-catalog` step runs last and touches nothing the fleet reads, so a failure
there is not a fleet incident — every mobile client keeps bootstrapping from the artifacts the two
passes before it already published.

What it does break is the seeded developer database image: `Dockerfile.dev-db` resolves that
manifest and fails the build outright if it is missing, rather than producing an image with no board
geometry. Consequences, in order of who notices:

- **Nobody, for a while.** The image is only rebuilt by a manual dispatch of
  `postgres-image-publisher.yml`, so a failed catalogue pass sits unnoticed until someone rebuilds.
- **`test-dev-db`** on any PR touching `packages/db/**` — that job builds the image, so it is the
  first automated signal.

The artifact is immutable and content-addressed, and the manifest is only rewritten on success, so a
failed pass leaves the previous artifact serving. Recovery is a re-dispatch: it is one whole-catalogue
build with no incremental state, so re-running it is always safe and always sufficient. There is no
partial-catalogue mode to get stuck in — the export either publishes a complete artifact or leaves
the last one in place.

If it fails repeatedly, the likely causes are the ones the per-layout passes share (Production
secrets, the Tigris endpoint) rather than anything catalogue-specific — it reads ~816k rows from
fourteen tables in one REPEATABLE READ transaction and writes a single ~12 MB object.

### Format-version bump procedure

Bump `SNAPSHOT_MANIFEST_FORMAT_VERSION` in `snapshot-manifest.ts` (and its `formatVersion: 1` literal type)
only for a breaking shape change to the manifest or `snapshot_meta` contract. Because clients reject a
`format_version` mismatch outright (`verifySnapshotMeta` throws if it doesn't match exactly), a bump is a
coordinated change, not just a constant flip:

1. Bump the constant/type in `packages/shared/offline-sync/src/sync/snapshot-manifest.ts`.
2. Change the export job's `SNAPSHOT_KEY_PREFIX` (`export-board-snapshots.ts`) from `board-snapshots/v1` to
   `board-snapshots/v2` — the prefix is a **separate, hand-maintained constant**, not derived from the
   format-version number, so both must move together deliberately.
3. Ship the client change (new `SNAPSHOT_MANIFEST_FORMAT_VERSION`) in a mobile release before or alongside
   the backend cutover — an old client binary keeps checking for `format_version === 1` and will simply
   treat a `v2`-only export as "no entry for this layout" (permanent miss, falls back to paged pull), so
   there's no crash risk, but it also gets zero benefit from the new artifacts until it updates.
4. Point `EXPO_PUBLIC_SNAPSHOT_BASE_URL` at the `v2` path in the next build once `v2` artifacts exist.
5. The old `v1` manifest/artifacts are not automatically cleaned up by this procedure (pruning only ever
   acts within the prefix a given run is writing to) — delete them manually once old clients have aged out.

### When bootstrap failure rate spikes

1. Check Sentry for handled errors tagged `source: offline-sync`, `kind: snapshot-bootstrap` — `extra`
   carries `scopeKey`/`stage` (`manifest`/`download`/`import`)/`attempt`/`cause`. A spike concentrated in
   one `stage` narrows it fast (e.g. `download` failures across many scopes usually means the manifest or
   an artifact URL is broken; `import` failures usually mean a bad/truncated artifact or a genuine
   schema/format mismatch).
2. Check the PostHog `Offline Board Download Completed` event, split by `method` (`snapshot` vs `paged`)
   and look at `durationMs` percentiles per method — a rising `paged` share among fresh scopes is the
   downstream signal that bootstrap is failing out even if Sentry volume looks modest (2 failed attempts
   per scope is a small, capped signal).
3. Confirm the manifest is actually fetchable and valid: `curl <SNAPSHOT_BASE_URL>/manifest.json` and check
   `formatVersion`/`entries`.
4. If it's isolated to one board/layout, re-run the export filtered to it (`--board`/`--layout`) rather
   than a full unfiltered run.

### Schema-bump staleness window

A schema-version bump on the client (a new migration touching `board_climbs`, `board_climb_stats`, or
`board_climb_grades`) makes existing artifacts `schema_version`-stale. The live threshold scan treats an
old schema as stale without waiting for 500 rows, so the fleet's gzip artifacts self-heal on the next
best-effort scan (scheduled every 15 minutes); the identity rollback catches up in the 07:15 nightly.
During that window, freshly-enabled scopes on the new client fall back to the paged crawl (a permanent
miss, no attempt burned, always correct) rather than importing a stale artifact — see the `schema_version`
semantics above. A manual `workflow_dispatch` starts the rebuild without waiting for the next scheduled
scan if a release needs it sooner.

### Deferred: correlated-EXISTS cost on the fallback path

[boardsesh/boardsesh#3561](https://github.com/boardsesh/boardsesh/issues/3561) — `syncClimbStats`'s scope
filter uses a correlated `EXISTS` against `board_climbs` per page (`queries.ts`, mirrored in the export's
`STATS_WHERE` and the client's stats-import semi-join). The snapshot path pays this cost once per layout
per night; the paged fallback pays it once per page, for every user paging that scope. As long as the
snapshot path stays healthy this is rarely hot, but any sustained drop in the `method: 'snapshot'` share
(see the failure-rate check above) puts more traffic through the correlated `EXISTS` on every fallback
page — that's the trigger to prioritize the fix.

## Catalogue artifact (`board-snapshots/v1-catalog`)

A third prefix, published by the same nightly run and read by nobody in the mobile fleet.

The per-layout artifacts carry the climb catalogue. They deliberately do not carry the **hardware
catalogue** — the t-nut holes, placements, LED positions, hold sets, product sizes, layouts, grade
scales and attempt enums that every board render and every grade lookup needs. That data is small
(~30k rows across the six Aurora boards; MoonBoard and Woods geometry lives in
`@boardsesh/board-constants`, not Postgres), it changes a handful of times a year, and it is
board-scoped rather than layout-scoped, so it does not fit the per-layout shape at all.

The seeded developer database image needs it, though. That image used to scrape six Aurora APKs and
run pgloader at build time to get it (issue #4508). Publishing the same rows as one more artifact
lets the image be built entirely from public, production-derived, nightly-verified files.

|          |                                                                                             |
| -------- | ------------------------------------------------------------------------------------------- |
| Script   | `packages/backend/src/scripts/export-board-catalog.ts`                                      |
| Prefix   | `board-snapshots/v1-catalog` — one gzip artifact + its own `manifest.json`                  |
| Cadence  | The 07:15 UTC nightly only. Never the 15-minute scan; never a `--board`/`--layout` dispatch |
| Size     | ~12 MB gzipped (~63 MB on disk), dominated by `board_climb_aliases`                         |
| Consumer | `packages/db/scripts/load-board-snapshots.ts`, run by `Dockerfile.dev-db`                   |

Tables, in the order a consumer must load them (foreign keys point backwards):

`board_products`, `board_layouts`, `board_product_sizes`, `board_sets`, `board_placement_roles`,
`board_holes`, `board_placements`, `board_leds`, `board_product_sizes_layouts_sets`, `board_kits`,
`board_difficulty_grades`, `board_attempts`, then — after every layout artifact has loaded, because
their rows reference `board_climbs` — `board_climb_aliases` and `board_beta_links`.

`board_beta_links` drops `created_by_user_id`, `tick_uuid` and `board_id` at export: they are
per-user links to production rows that mean nothing in another database.

**This prefix has its own manifest on purpose.** It is not an entry in the fleet-facing manifest and
it does not widen `SNAPSHOT_TABLES`. A shipped binary verifies a downloaded artifact against a
two-table `snapshot_meta` and counts an unexpected table as an import _failure_; two of those and the
scope falls back to the paged crawl. Keeping the catalogue in its own prefix means no shipped client
can ever see it.

```json
{
  "formatVersion": 1,
  "generatedAt": "2026-08-26T07:16:04.221Z",
  "artifact": {
    "key": "board-snapshots/v1-catalog/2026-08-26T07-15-58-102Z.db",
    "url": "https://boardsesh-board-snapshots.t3.tigrisfiles.io/board-snapshots/v1-catalog/...",
    "bytes": 12685503,
    "uncompressedBytes": 63229952,
    "contentEncoding": "gzip",
    "builtAt": "2026-08-26T07:15:58.102Z",
    "schemaVersion": 1,
    "tables": { "board_holes": { "rowCount": 6405 }, "...": {} }
  }
}
```

Same 14-day prune grace as the other prefixes, and the manifest is written last, so a reader never
sees a key that is not on S3 yet.

## Rollout plan

1. **Build configuration**: confirm `EXPO_PUBLIC_SNAPSHOT_BASE_URL` is set to the real Tigris bucket URL
   in every native build. With the env var missing, the app intentionally uses the paged crawl (see Mobile
   wiring above).
2. **Two pre-release manual verifications**:
   - One real on-device bootstrap, confirmed end to end: the `ATTACH` uses a bare filesystem path (no
     `file://` scheme — SQLite's ATTACH resolution isn't guaranteed URI-mode-safe on either platform's
     bundled sqlite3), the artifact attaches and imports, and Sentry reports no gzip-magic-byte handled
     error for that download (the fleet reads the gzip prefix, so decode is on the live path).
   - Background and foreground transfers on iOS, plus foreground transfers on Android, report useful byte
     progress and complete against the production CDN.
3. **Release monitoring**: watch `Offline Board Download Completed` duration percentiles split by `method`
   and the Sentry `snapshot-bootstrap` failure rate. Withdraw a bad manifest if snapshot p95 no longer
   clearly beats paged downloads or failures jump.

## Gzip transition & cutover

Gzip cuts artifact size ~2.6× (`kilter:1` 271 MB → 103 MB, whole catalog 595 MB → 220 MB, measured
2026-07-27), directly shrinking the download portion of `durationMs`. It shipped in stages so the live
fleet was never regressed while transparent decode was unverified:

1. **Dual-publish — shipped.** The nightly publishes both `board-snapshots/v1` (identity) and
   `board-snapshots/v1-gzip` (`--gzip`), one manifest each, ~80s apart in the same run.
2. **Transparent decode validated on-device, iOS + Android — done.** Android: the real `downloadArtifact`
   path on an emulator (OkHttp) inflated the artifact to a decoded SQLite file, no
   `SnapshotPermanentMissError`. iOS 26.5.2: via the `pr-3816` gzip OTA preview — fresh downloads took the
   snapshot path and Sentry reported no `kind: 'snapshot-bootstrap'` "arrived still gzip-compressed".
3. **Cutover — shipped.** `EXPO_PUBLIC_SNAPSHOT_BASE_URL` points at `.../board-snapshots/v1-gzip` in **all
   six** mobile fingerprint workflows — `mobile-ota-production.yml`, `ios-testflight-rn.yml`,
   `android-apk-rn.yml`, `mobile-ota-check.yml`, `mobile-ota-preview.yml`, `mobile-ota-backport.yml`. They
   must move together: `scripts/mobile-ci-env-parity.test.ts` requires the var byte-identical across them
   (a single-workflow change fails CI, and the `pr-<number>` preview branch bakes the same env as
   production, so there is no "preview-only" pointer). It's a bundle-only var, so the cutover rode the
   production OTA rather than a native release; any straggler where decode fails degrades to the paged
   crawl, never a crash.
4. **Cleanup (not done yet).** Once the fleet has migrated, drop the identity pass from the export workflow
   and delete the `board-snapshots/v1` artifacts + manifest. `docs/board-snapshots-dataset.md` publishes
   `v1` URLs to outside users, so that doc has to be repointed at `v1-gzip` in the same change.

**Rollback**: point the six workflows back at `v1` (identity is still published nightly) — a one-commit
revert, no export change needed.
