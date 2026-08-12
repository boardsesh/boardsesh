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
now — typically under a day.

## Architecture

### Nightly export

`.github/workflows/export-board-snapshots.yml` runs `export-board-snapshots.ts` at **07:15 UTC** daily
(`workflow_dispatch` also available), with `environment: Production` so it gets the Production secrets.
`concurrency.group: export-board-snapshots` with `cancel-in-progress: false` means overlapping runs queue
instead of stepping on each other.

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
   `row_count`, `schema_version` (`LATEST_SCHEMA_VERSION`), and `format_version`.
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
- Only an **unfiltered** run has the full picture, so only it may drop an entry whose layout no longer has
  climbs (passes `livePairs`; filtered runs pass `null` and keep everything).
- A layout whose export **failed** this run keeps its previous (still-valid, immutable) artifact entry —
  failures don't block the other layouts' refresh, and the whole run only fails at the very end, after
  every layout has been attempted.

Previous-manifest failure matrix (`fetchPreviousManifest`), because the merge above needs those entries to
avoid dropping data on a broken read:

| Previous manifest state        | Filtered run                                            | Unfiltered run                                                                                                                     |
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

The whole-layout `.db` file carries exactly two data tables — `board_climbs` and `board_climb_stats` —
plus `snapshot_meta`. That has not changed since the first release and must not: every shipped binary
verifies the file against its own two-table list and throws `snapshot_meta missing row for <table>` on a
mismatch, which is a **counted** import failure. Two of those settle the scope onto the paged crawl, so
widening this file's meta would break the fleet for the whole 14-day prune-grace window. Boardsesh grades
ride in a separate file for exactly that reason (see "Grades artifact" below).

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

One row per data table (`board_climbs`, `board_climb_stats`).

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
  paged crawl, and the next nightly export rebuilds the artifact at the new schema.

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
  imported an artifact, and carries snapshot-path failures behind it. This is the un-strand for issue
  #4313: a board that gave up on the snapshot and then crawled part of its catalog can jump the rest of
  the climbs/stats crawl from an artifact.

Both also require that neither retry budget is spent and that any scheduled cooldown has elapsed. A
`scope-complete:` scope is never healed — it already serves the whole catalog locally, so ~100 MB buys it
nothing. The ordinary paged sync still downloads `board_climb_grades` before a scope is reported complete
(it is not in `SNAPSHOT_TABLES`), so a heal removes part of the slow path, not all of it. One artifact
download is shared across every size of the same `(boardType, layoutId)` within a cycle.

**Failure taxonomy and budgets** (issue #4313). Before this, `MAX_BOOTSTRAP_ATTEMPTS = 2` was doing two
jobs: it was the retry policy (there is none — the artifact GET is unresumable and never retried) and the
total-spend bound. Because a dropped connection at the DOWNLOAD stage burned the same counter as a corrupt
artifact, two bad-reception launches condemned a board to the 400+-round-trip crawl for the life of the
install. The two jobs are now separate: kind-specific budgets bound total spend, a cooldown ladder bounds
frequency.

| Kind                  | Raised by                                                                            | Budget                                | Cooldown ladder      | Re-armed by a new `builtAt`?                         |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------------------------- | -------------------- | ---------------------------------------------------- |
| `transport`           | `isNetworkError(cause)` at the download stage (offline, DNS, TLS, timeout)           | `MAX_TRANSPORT_DOWNLOAD_FAILURES` = 3 | 2 min → 15 min → 2 h | no                                                   |
| `structural-artifact` | anything raised inside the import (`quick_check`, `snapshot_meta` mismatch, throw)   | `MAX_BOOTSTRAP_ATTEMPTS` = 2          | 6 h → 24 h           | yes, `MAX_STRUCTURAL_REARMS` = 1 per scope, lifetime |
| `structural-device`   | every other non-transport cause (disk space, cache dir, CDN non-2xx, unclassifiable) | `MAX_BOOTSTRAP_ATTEMPTS` = 2          | 6 h → 24 h           | **no**                                               |

A successful download resets `transportFailures` to 0 and drops its cooldown. The manifest stage stays
entirely free for transport failures (a few KB of JSON, and the stage an offline launch dies at — issue
#4238); everything else is charged at either stage. The `structural-device` default is deliberately
conservative: a plain `Error` from an adapter's downloader cannot be told apart from a disk-full or
cache-dir fault, and the export is **nightly**, so a `builtAt` reset for a device-side fault would be
2 × ~100 MB every day, forever.

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

**Cooldowns and skipping the paged crawl.** The skip is a grace window, not all-or-nothing: only a FRESH,
non-terminal scope whose retry lands within 30 minutes waits for it, because a first-page checkpoint used
to disqualify the snapshot path permanently and the crawl is 400+ serial round trips it is about to throw
away. Past that window the crawl runs, so a board is never left empty waiting on a 2-hour cooldown, and a
scope that already holds rows always crawls — a failed heal must not stall progress already being made.

**The metered-network probe.** `SyncOptions.isOnUnmeteredNetwork` (default `() => true`, so web and every
existing caller are unchanged) gates ONE decision: the automatic heal of a partly-crawled scope, which is a
~100 MB download the user did not ask for that day. On a metered link the heal defers 6 hours and burns
nothing. A fresh bootstrap (they just confirmed the size) ignores it, and so does a user-requested retry:
`restoreBootstrapRetryBudget` arms a `userRequested` flag on the persisted state, `runBootstrapPhase` skips
the defer while it is set, and the flag is spent the instant the download starts (one tap, one artifact).
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
channel rollback and `pr-<n>` preview channels are live paths here: an older bundle that read no legacy row
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
drop one; the heal marker is the only one with no UI and stays out of that list.

Per-stage outcomes, copied from the `runBootstrapPhase` doc comment (the source of truth — keep this in
sync if the code comment changes):

| Condition                                                            | Budget burned             | Result this cycle                                                                         |
| -------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| `scope-complete:` / `bootstrap-done:` / mid-crawl with no failures   | —                         | not eligible → normal paged pull                                                          |
| `isOnline()` reports offline                                         | —                         | whole cycle skipped before the phase starts; retried on reconnect                         |
| a scheduled retry has not elapsed                                    | —                         | not eligible this cycle; crawl runs unless the retry is inside the 30-minute grace window |
| terminal, last failure `structural-artifact`, re-arm left, new build | — (grants a round)        | budget restored once → snapshot path runs                                                 |
| terminal, otherwise                                                  | —                         | settled → normal paged pull, manifest not fetched                                         |
| heal-over-partial on a metered link                                  | **no** (defers 6 h)       | normal paged pull                                                                         |
| the same, with `userRequested` armed by the retry action             | — (spends the tap)        | snapshot path runs now; recovery reports `trigger: 'user-request'`                        |
| manifest `absent` (404/missing or invalid JSON/shape)                | **no**                    | permanent miss → normal paged pull                                                        |
| manifest `error`, transport-shaped (offline/DNS/TLS/timeout)         | **no**, nothing persisted | skip paged pull this cycle; reported as `expected`                                        |
| manifest `error`, anything else (HTTP non-2xx except 404, …)         | `structural-device`       | 6 h ladder; crawl runs (past the grace window)                                            |
| manifest `ok` but no entry for `(boardType, layoutId)`               | **no**                    | permanent miss (not exported yet) → normal paged pull                                     |
| download fails or returns `null`, transport-shaped                   | `transport`               | 2 min ladder; paged pull skipped while the retry is imminent                              |
| download fails or returns `null`, anything else                      | `structural-device`       | 6 h ladder; crawl runs                                                                    |
| download throws `SnapshotPermanentMissError`                         | **no**                    | permanent miss → normal paged pull                                                        |
| import throws — corrupt/short artifact, row-count/format mismatch    | `structural-artifact`     | 6 h ladder; a new `builtAt` may re-arm it once                                            |
| import throws `SnapshotSchemaStaleError`                             | **no**                    | permanent miss this run → normal paged pull                                               |
| import throws `SnapshotWatermarkRegressionError`                     | `structural-artifact`     | nothing written → normal paged pull; 6 h ladder; reported `expected: false`               |
| a sign-out wipe is detected mid-phase                                | **no**                    | whole phase bails, mirrors `syncTable`'s wipe guard                                       |
| success                                                              | transport counter reset   | marked done; deletions rewound; paged pull runs as a small delta from scoped watermarks   |

Resumable / ranged artifact downloads are **not** in scope here — artifacts ship gzip-encoded and rely on
the native stack to decode, so byte-offset resume needs a JS gunzipper (a native dependency, OTA-forbidden).
That is issue #4310's; when it lands, the transport ladder's first rung should drop, because a resumed
attempt is cheap.

**Import mechanics** (`bootstrapScopeFromSnapshot`): `ATTACH`es the downloaded file as `bs_snapshot`, runs
`PRAGMA quick_check` (rejects a truncated/corrupt file before touching any row), verifies `snapshot_meta`
(format version, schema version, and that `row_count` matches the artifact's actual row count — catches a
truncated download the integrity check alone might miss), computes watermarks from the exact scoped rows
inside the artifact, then in **one exclusive transaction**:

- Deletes stale local `board_climbs`/`board_climb_stats` rows for this scope whose cursors are at or
  before the scoped watermarks but absent from the artifact. This keeps a later bootstrap from overlaying a
  newer artifact on top of rows that vanished from the exported scope.
- Imports `board_climbs` filtered by the scope — `board_type = ? AND layout_id = ?`, plus (for
  size-scoped boards; MoonBoard is the one exception, `isSizeScopedBoard`) a `json_each` membership check
  against `compatible_size_ids`, mirroring the resolver's `boardClimbsScope` exactly.
- Imports `board_climb_stats` via a correlated `EXISTS` against the just-scoped `board_climbs`, mirroring
  the resolver's semi-join.
- Stamps both table checkpoints at the scoped imported-row watermarks.
- **Rewinds the deletions checkpoint** to the older scoped table watermark timestamp with deletion cursor
  `syncSeq = '0'`, in the _same_ transaction as the import. Deletion cursors page over deletion-row ids, not
  board table `sync_seq` values. A committed import stamps `bootstrap-done:`, which disqualifies the scope
  from ever bootstrapping again, so a crash between the import commit and a separate rewind step would
  permanently strand any board-row deletions that fell in `(watermark, deletions-head]` — they'd never
  replay against the freshly-imported rows. Doing it in the same transaction closes that gap. Note the
  rewind target is `min(scoped watermarks)`, the max `updated_at` of the artifact's rows FOR THIS SCOPE:
  on a quiet layout that timestamp can be weeks old, so the replay window is bounded by the 80-day
  tombstone retention, not by one nightly export window.

**Wipe-epoch guard**: a sign-out wipe can start (or fully complete) across any of the `await`s above. The
bootstrap captures the monotonic wipe epoch before its first `await` and re-checks it (and the
signing-out flag) before the transaction, and again after the import completes but before commit. Any
mismatch throws `SnapshotWipedError`, rolling the transaction back — no rows, no checkpoints — and the
pull-client treats it as a bail-out, not a counted failure.

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
  scope would download. Note `bytes` is the **stored** object size: correct as a download figure while
  artifacts stay identity-encoded, and an undercount of the on-disk file the day `--gzip` ships.

- **Download fallback status**: My Boards keeps the normal per-row download state (`pending`,
  `downloading`, or `downloaded`) and separately derives a `BoardDownloadNotice` from the persisted
  attempt, done, and explicit paged-fallback markers plus board checkpoints. The explicit outcome closes
  the ambiguous failure-then-permanent-miss path; checkpoints keep a restored or flag-toggled mid-crawl
  scope from being labelled as a retry after restart. Active bootstrap always outranks persisted history,
  while pending and active paged fallback use different copy. The screen reads all enabled scopes' markers
  with index-backed `GLOB` prefix ranges in one SQLite query into an O(1) map, refreshes after each scope's
  bootstrap decision settles, and refreshes again on each `onScopeDownloadComplete` callback rather than
  waiting for a multi-scope cycle to finish. The full transition message wraps instead of truncating.
  Android exposes it as the only polite live region; iOS announces semantic notice changes through
  VoiceOver explicitly. The changing climb count remains readable but is never auto-announced per page.

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
  unset or empty, `OfflineSyncBridge` does not pass `mobileSnapshotSource` to the scheduler, even when the
  PostHog flag is on, and fresh boards use the paged crawl. Set this as a real EAS build-time env var
  before ramping the flag. `EXPO_PUBLIC_*` vars are inlined at build time, not read at runtime, so this
  needs a new build to take effect, not just a config change.
- **PostHog flags** (`packages/mobile/src/providers/feature-flags-provider.tsx`):
  - `offline-board-downloads` — the offline engine's _new_ work: downloads, the **online** local-first
    read optimization, queued offline writes, and background sync. Missing/undefined reads as **off**.
    Reading an already-downloaded board while the network is unavailable is NOT gated by this flag — see
    the flag-gate section in `docs/offline-sync-plan.md` and issue #3888.
  - `offline-snapshot-bootstrap-v2` — nested under the flag above: whether a freshly-enabled scope warms
    from the snapshot at all. With `offline-board-downloads` on and `offline-snapshot-bootstrap-v2` off, a
    fresh board still downloads — just via the paged crawl. `OfflineSyncBridge`
    (`packages/mobile/src/components/offline-sync-bridge.tsx`) only passes `mobileSnapshotSource` to the
    sync scheduler when `useSnapshotBootstrapEnabled()` is true **and** `EXPO_PUBLIC_SNAPSHOT_BASE_URL` is
    configured; otherwise it passes `undefined`, which makes `pullSync` skip the bootstrap phase entirely
    — behaviourally identical to before this feature existed.
- **Gzip magic-byte sniff** (`packages/mobile/src/offline/snapshot-source.ts`): identity artifacts skip
  gzip verification. For manifest entries with `contentEncoding: 'gzip'`, the expectation is that the
  native HTTP stack (`NSURLSession` / OkHttp via `expo-file-system`'s `File.downloadFileAsync`)
  transparently decompresses the object while downloading. `looksGzipCompressed` reads just the first two
  bytes of the downloaded file and checks for the gzip magic number (`0x1f 0x8b`). If they're still present
  — the stack did **not** auto-decode — the file is deleted, the download throws
  `SnapshotPermanentMissError` (no attempt burned, same-cycle paged fallback), and a handled error is
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

## Ops runbook

### Manual export

From CI: trigger `.github/workflows/export-board-snapshots.yml` via `workflow_dispatch` (GitHub UI or
`gh workflow run export-board-snapshots.yml`).

From a local shell, from `packages/backend/`:

```sh
DATABASE_URL=<primary connection string> \
AWS_S3_BUCKET_NAME=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_ENDPOINT_URL=... AWS_DEFAULT_REGION=... \
node --import tsx src/scripts/export-board-snapshots.ts \
  [--dry-run] [--gzip] [--key-prefix <prefix>] [--board <boardType>] [--layout <layoutId>]
```

- `--dry-run` builds artifacts locally (in a temp dir, cleaned up after) and logs sizes/row counts, but
  never uploads anything and never touches the manifest. Works with **no AWS credentials at all**.
- `--gzip` compresses artifact objects and publishes manifest entries with `contentEncoding: 'gzip'`.
  Pair it with `--key-prefix board-snapshots/v1-gzip` so gzip artifacts land beside — never overwrite — the
  identity `v1` prefix the live fleet reads.
- `--key-prefix <prefix>` (default `board-snapshots/v1`) targets a self-contained prefix: its own manifest,
  merge, and prune, isolated from every other prefix. Validated against a safe key charset. The nightly
  workflow uses it to publish `v1` (identity) and `v1-gzip` (gzip) in one run.
- `--board`/`--layout` filter to a subset. A filter matching **zero** `(boardType, layoutId)` pairs is
  treated as an operator error and throws loudly (e.g. `--board=kilterr` typo) rather than silently leaving
  that board's artifacts stale.
- `DATABASE_URL` must point at the **primary**, never a read replica (see the rationale above) — this is
  read-only-sufficient (the export only `SELECT`s) but the write-time/commit-order mismatch on a replica is
  a correctness bug, not a permissions one.

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

### Kill switches

- **Fastest, no deploy**: flip the `offline-snapshot-bootstrap-v2` PostHog flag off. Every client falls back
  to the paged crawl for newly-enabled boards; nothing already bootstrapped is affected (it's already past
  the eligibility check).
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

A schema-version bump on the client (a new migration touching `board_climbs`/`board_climb_stats`) makes
every existing artifact `schema_version`-stale until the next nightly export rebuilds them — that's a
window of **at most one nightly run** (worst case: the client release ships right after 07:15 UTC). During
that window, freshly-enabled scopes on the new client fall back to the paged crawl (a permanent miss, no
attempt burned, always correct) rather than importing a stale artifact — see the `schema_version` semantics
above. No manual action needed; it self-heals at the next nightly run. A manual `workflow_dispatch` closes
the window immediately if a release needs it sooner.

### Deferred: correlated-EXISTS cost on the fallback path

[boardsesh/boardsesh#3561](https://github.com/boardsesh/boardsesh/issues/3561) — `syncClimbStats`'s scope
filter uses a correlated `EXISTS` against `board_climbs` per page (`queries.ts`, mirrored in the export's
`STATS_WHERE` and the client's stats-import semi-join). The snapshot path pays this cost once per layout
per night; the paged fallback pays it once per page, for every user paging that scope. As long as the
snapshot path stays healthy this is rarely hot, but any sustained drop in the `method: 'snapshot'` share
(see the failure-rate check above) puts more traffic through the correlated `EXISTS` on every fallback
page — that's the trigger to prioritize the fix.

## Rollout plan

1. **Internal testers**: flip `offline-snapshot-bootstrap-v2` on for the `tester` PostHog cohort only.
2. **Two pre-ramp manual verifications** (do both before any percentage ramp):
   - Confirm `EXPO_PUBLIC_SNAPSHOT_BASE_URL` is set to the real Tigris bucket URL in the build that will
     ship to testers. With the env var missing, the flag is inert and the app intentionally uses the paged
     crawl (see Mobile wiring above).
   - One real on-device bootstrap, confirmed end to end: the `ATTACH` uses a bare filesystem path (no
     `file://` scheme — SQLite's ATTACH resolution isn't guaranteed URI-mode-safe on either platform's
     bundled sqlite3), the artifact attaches and imports, and Sentry reports no gzip-magic-byte handled
     error for that download (the fleet reads the gzip prefix, so decode is on the live path).
3. **Percentage ramp**: increase the PostHog rollout gradually, watching `Offline Board Download Completed`
   duration percentiles split by `method`, and the Sentry `snapshot-bootstrap` failure rate, at each step.
   Hold or roll back on a `snapshot` p95 that doesn't clearly beat `paged`, or a failure-rate step change.

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
   (a single-workflow change fails CI, and the `pr-<number>` preview channel bakes the same env as
   production, so there is no "preview-only" pointer). It's a bundle-only var, so the cutover rode the
   production OTA rather than a native release; any straggler where decode fails degrades to the paged
   crawl, never a crash.
4. **Cleanup (not done yet).** Once the fleet has migrated, drop the identity pass from the export workflow
   and delete the `board-snapshots/v1` artifacts + manifest. `docs/board-snapshots-dataset.md` publishes
   `v1` URLs to outside users, so that doc has to be repointed at `v1-gzip` in the same change.

**Rollback**: point the six workflows back at `v1` (identity is still published nightly) — a one-commit
revert, no export change needed.
