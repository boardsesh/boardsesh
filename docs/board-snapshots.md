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

For every `(board_type, layout_id)` pair with at least one climb (`discoverLayoutPairs`), the job:

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
5. Uploads the SQLite file to `board-snapshots/v1/<boardType>/<layoutId>/<builtAt-colon-free>.db`.
   Artifacts are identity-encoded by default; `--gzip` is available once both mobile platforms have been
   verified to receive a decompressed file from `expo-file-system`.
6. After every artifact for the run has landed, writes `board-snapshots/v1/manifest.json` **last**, so a
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

- Artifacts: `board-snapshots/v1/<boardType>/<layoutId>/<builtAt>.db`,
  `Content-Type: application/x-sqlite3`, with manifest `contentEncoding: 'identity'` by default. `--gzip`
  uploads with `Content-Encoding: gzip` and records `contentEncoding: 'gzip'` in the manifest, but should
  stay off for mobile rollout until iOS and Android both prove the downloaded file is decompressed on disk.
  No explicit `cacheControl` is passed to `uploadToS3`, so artifacts get the storage layer's default:
  `public, max-age=31536000, immutable`. Content-addressed by build timestamp — safe to cache forever, a
  new build gets a new key.
- Manifest: `board-snapshots/v1/manifest.json`, `Content-Type: application/json`,
  `Cache-Control: public, max-age=300`. Mutable and cheap to refetch, written last so it's the only object
  in the whole scheme that changes in place.

### Pruning

Artifacts superseded by a newer build for the same `(boardType, layoutId)` are deleted by
`pruneStaleArtifacts`, but only when **all** of the following hold:

- the run was **unfiltered** (a filtered run doesn't have the full manifest picture to prune safely), and
- the run had **zero layout failures** (a failed night just defers pruning to the next green run).

An object is eligible for deletion when it's under `board-snapshots/v1/` and NOT referenced by the manifest
just written, **and** its `lastModified` is older than a **14-day grace window**
(`PRUNE_GRACE_MS`). The grace window exists because the manifest is CDN-cached for up to 5 minutes and a
client may hold a fetched manifest (with a now-superseded artifact URL) far longer than that before it
actually starts the download. Pruning is defensive by design: any failure (per-object or the whole scan) is
logged and swallowed, never fails the run.

## Artifact format

Each `.db` file carries exactly two data tables — `board_climbs` and `board_climb_stats` — plus
`snapshot_meta`:

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

## Client bootstrap flow

Implemented in `snapshot-bootstrap.ts` (the ATTACH/import/verify mechanics) and orchestrated from
`pull-client.ts`'s `runBootstrapPhase`, which runs **before** the deletions phase of every sync cycle.

**Eligibility**: a board scope (`boardType:layoutId:sizeId`) is only considered when it has **no
checkpoint on either `board_climbs` or `board_climb_stats`** (i.e. genuinely fresh — nothing pulled yet)
and its bootstrap attempt count is under `MAX_BOOTSTRAP_ATTEMPTS` (2). One artifact download is shared
across every size of the same `(boardType, layoutId)` within a cycle.

Failure/attempt matrix, copied from the `runBootstrapPhase` doc comment (the source of truth — keep this in
sync if the code comment changes):

| Condition                                                         | Attempt burned? | Result this cycle                                                                       |
| ----------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------- |
| checkpoint exists on either board table                           | —               | not eligible → normal paged pull                                                        |
| attempts ≥ `MAX_BOOTSTRAP_ATTEMPTS`                               | —               | gave up → normal paged pull                                                             |
| manifest `absent` (404/missing or invalid JSON/shape)             | **no**          | permanent miss → normal paged pull                                                      |
| manifest `error` (HTTP non-2xx except 404, network/transport)     | **yes**         | skip paged pull this cycle (retry next cycle)                                           |
| manifest `ok` but no entry for `(boardType, layoutId)`            | **no**          | permanent miss (not exported yet) → normal paged pull                                   |
| download fails or returns `null`                                  | **yes**         | skip paged pull this cycle                                                              |
| download throws `SnapshotPermanentMissError`                      | **no**          | permanent miss → normal paged pull                                                      |
| import throws — corrupt/short artifact, row-count/format mismatch | **yes**         | skip paged pull this cycle                                                              |
| import throws `SnapshotSchemaStaleError`                          | **no**          | permanent miss this run → normal paged pull                                             |
| a sign-out wipe is detected mid-phase                             | **no**          | whole phase bails, mirrors `syncTable`'s wipe guard                                     |
| success                                                           | —               | marked done; deletions rewound; paged pull runs as a small delta from scoped watermarks |

"Skip paged pull this cycle" matters because a scope whose bootstrap failed but still has attempts left
must **not** run its ordinary paged pull this cycle either — a first-page checkpoint from that pull would
permanently disqualify the scope from ever bootstrapping (the eligibility check requires no checkpoint at
all), so the next cycle retries the snapshot path instead of falling through to a slow crawl by accident.

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
  board table `sync_seq` values. Once a scope has board checkpoints it's never bootstrap-eligible again, so
  a crash between the import commit and a separate rewind step would permanently strand any board-row
  deletions that fell in `(watermark, deletions-head]` — they'd never replay against the freshly-imported
  rows. Doing it in the same transaction closes that gap.

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
  - `offline-board-downloads` — the whole offline engine (downloads, local-first reads, queued
    offline writes, background sync). Missing/undefined reads as **off**.
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
  the file itself; keep the export job identity-encoded until gzip has been verified on both mobile
  platforms.
- **Telemetry**:
  - `Offline Board Download Completed` (PostHog, `SHARED_EVENTS.OfflineBoardDownloadCompleted`) fires once
    per scope's first-download completion (both board tables reached the tail), with method `snapshot` or
    `paged` and `durationMs` measured from the start of the sync cycle's work on that scope (so a
    `'snapshot'` scope's duration includes its manifest/download/import time, not just the trailing delta
    pull — an apples-to-apples comparison against a full paged crawl).
  - Sentry handled errors, `tags: { source: 'offline-sync', kind: 'snapshot-bootstrap' }`, for every
    counted bootstrap failure (manifest/download/import stage, with `scopeKey`/`stage`/`attempt`/`cause` in
    `extra`) and for the gzip-sniff failure above.

## Ops runbook

### Manual export

From CI: trigger `.github/workflows/export-board-snapshots.yml` via `workflow_dispatch` (GitHub UI or
`gh workflow run export-board-snapshots.yml`).

From a local shell, from `packages/backend/`:

```sh
DATABASE_URL=<primary connection string> \
AWS_S3_BUCKET_NAME=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_ENDPOINT_URL=... AWS_DEFAULT_REGION=... \
node --import tsx src/scripts/export-board-snapshots.ts [--dry-run] [--gzip] [--board <boardType>] [--layout <layoutId>]
```

- `--dry-run` builds artifacts locally (in a temp dir, cleaned up after) and logs sizes/row counts, but
  never uploads anything and never touches the manifest. Works with **no AWS credentials at all**.
- `--gzip` compresses artifact objects and publishes manifest entries with `contentEncoding: 'gzip'`.
  Leave it off for mobile rollout until a device check proves iOS and Android both download decompressed
  SQLite files from the object store path.
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
`${SNAPSHOT_PUBLIC_BASE_URL}/board-snapshots/v1`.

### Kill switches

- **Fastest, no deploy**: flip the `offline-snapshot-bootstrap-v2` PostHog flag off. Every client falls back
  to the paged crawl for newly-enabled boards; nothing already bootstrapped is affected (it's already past
  the eligibility check).
- **Nuclear, affects every client regardless of flag state after cache expiry**: delete the
  `board-snapshots/v1/manifest.json` object from the bucket. The manifest is cached for up to 5 minutes
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
     bundled sqlite3), and identity artifacts attach/import without a gzip-magic-byte failure. If `--gzip`
     is tested separately, verify no gzip-magic-byte handled error is reported to Sentry for that download.
3. **Percentage ramp**: increase the PostHog rollout gradually, watching `Offline Board Download Completed`
   duration percentiles split by `method`, and the Sentry `snapshot-bootstrap` failure rate, at each step.
   Hold or roll back on a `snapshot` p95 that doesn't clearly beat `paged`, or a failure-rate step change.
