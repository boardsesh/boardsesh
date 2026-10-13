# Board snapshots as a downloadable dataset

Boardsesh publishes nightly SQLite snapshots of the climb catalogs it syncs. They exist to give
the mobile app a fast first download (see `board-snapshots.md` for that pipeline), but they are
plain, publicly fetchable SQLite files — anyone who wants a local copy of the climb data for
analysis, backup, or tooling can use them directly.

## Getting the data

The one stable URL is the manifest:

```
https://snapshots.boardsesh.com/board-snapshots/v1-gzip/manifest.json
```

Artifacts under this prefix are stored gzipped and served with `Content-Encoding: gzip`. Anything
that honours that header (curl, browsers, most HTTP clients) hands you a plain SQLite file; a
straight-to-disk downloader may write the raw gzip stream instead, so check the first two bytes for
`1f 8b` and gunzip if they are there rather than trusting `contentEncoding`.

Everything else is discovered from it. **Never hardcode artifact URLs** — every nightly run mints
new timestamped artifacts, and superseded ones are pruned after a 14-day grace window. A cron job
that stores an artifact URL will 404 within two weeks; a job that reads the manifest first will
keep working.

```sh
manifest=https://snapshots.boardsesh.com/board-snapshots/v1-gzip/manifest.json

# List what's available
curl -s "$manifest" |
  jq -r '.entries[] | "\(.boardType):\(.layoutId)\t\(.bytes / 1e6 | floor)MB\t\(.tables.board_climbs.rowCount) climbs"'

# Download one board's catalog (e.g. Tension board 2). --compressed decodes it.
url=$(curl -s "$manifest" |
  jq -r '.entries[] | select(.boardType == "tension" and .layoutId == 9) | .url')
curl --compressed -o tension-9.db "$url"

# Query it
sqlite3 tension-9.db "SELECT name, setter_username FROM board_climbs LIMIT 5"
```

One artifact per **(board type, layout)** pair. A layout's artifact contains the full catalog for
that layout across all wall sizes — filter with `compatible_size_ids` (a JSON array column) if you
only care about one size.

## Manifest format

`formatVersion: 2`. Older app versions use paged sync instead of importing this
privacy-filtered dataset with incompatible cursor assumptions. Each entry:

| Field                                                   | Meaning                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `boardType`, `layoutId`                                 | Which catalog this artifact holds                                                               |
| `url`                                                   | Public download URL (valid until pruned — always re-resolve via the manifest)                   |
| `key`                                                   | Object key under `board-snapshots/v1-gzip/`                                                     |
| `bytes`                                                 | Stored size                                                                                     |
| `uncompressedBytes`                                     | Size of the SQLite file once decoded; absent on entries built before the field existed          |
| `contentEncoding`                                       | `identity` (a plain SQLite file) or `gzip` (gunzip before opening)                              |
| `builtAt`                                               | When the export built this artifact                                                             |
| `privacyVersion`                                       | Must be `1`: external catalog only; older artifacts cannot be installed by privacy-aware clients |
| `schemaVersion`                                         | SQLite schema revision of the tables inside                                                     |
| `artifactShape`                                         | How the file stores its rows; see "Storage" below. `2` today, absent on older (shape 1) files   |
| `tables.<name>.rowCount`                                | Row counts, for sanity-checking a download                                                      |
| `tables.<name>.watermarkUpdatedAt` / `watermarkSyncSeq` | Sync cursors (app-internal; irrelevant for dataset use)                                         |
| `grades`                                                | Present when the layout has Boardsesh grades: a sibling artifact with its own `url` and `bytes` |

`grades` carries its own `uncompressedBytes` too, on shape-2 entries.

Treat `schemaVersion` as informational: columns may be added over time (additive), and a breaking
layout change would ship under a new `board-snapshots/v2*` prefix rather than mutating `v1-gzip`.
That promise covers the tables, their columns and their rows. How a file stores them (whether a table
has a `rowid`, which secondary indexes it carries, the order rows sit in) is not part of it and has
changed under `v1-gzip`; see "Storage" below.
A `board-snapshots/v1` prefix still carries identity-encoded copies of the same artifacts; it is
retained as a nightly-published rollback target. New consumers should use `v1-gzip`.
Removing the identity prefix or legacy Tigris data requires separate explicit approval.

## What's inside

Each per-layout artifact is a standard SQLite database with three tables. The authoritative DDL
lives in `packages/shared/offline-sync/src/db/schema.ts`; the export rewrites how it is stored (see
"Storage" below) but never the columns.

**`board_climbs`** — one row per climb, all 32 columns: `uuid` (primary key), `board_type`,
`layout_id`, `setter_id`, `setter_username`, `name`, `description`, `hsm`,
`edge_left/right/bottom/top` (placement bounding box), `angle` (the setter's intended angle, where
the board type has one), `frames_count`, `frames_pace`, `frames` (the hold sequence as the board's
native frame string), `is_draft`, `is_listed`, `is_hidden` (hidden by the community), `created_at`,
`published_at`, `user_id`, `required_set_ids` / `compatible_size_ids` / `characteristics` (JSON
arrays), `hold_fingerprint`, `missing_hold_count` and `retired_by_reset` (spray walls only, so NULL
here), `revision_number` (the climb's current revision) and `holds_revision_number` (the revision at
which its holds last changed), and sync bookkeeping (`updated_at`, `sync_seq`).

Only imported climbs without a linked Boardsesh author are distributed. Personal climbs and beta
are fetched through the viewer-authorized API, so account privacy changes can revoke access.
Imported draft and listing flags retain their source values; filter them for a public-only browse. There is no size filter either: a layout's artifact spans every wall
size, so filter with `compatible_size_ids`.

**`board_climb_stats`** — community stats per `(climb, angle)`: `ascensionist_count`,
`difficulty_average` and `display_difficulty` (in the board's native difficulty scale),
`benchmark_difficulty` where the community designates benchmarks, `quality_average` (0–5 star
scale), and first-ascent attribution (`fa_username`, `fa_at`).

**`snapshot_meta`** — export bookkeeping (row counts, watermarks, schema/format versions). Useful
for verifying integrity: `row_count` should match `SELECT COUNT(*)` on each table.

**Storage.** Current files are "shape 2", marked `artifactShape: 2` in the manifest.
`board_climbs`, `board_climb_stats` and the grades file's `board_climb_grades` are `WITHOUT ROWID`
tables, the file has been vacuumed, and it carries **no secondary indexes**. Earlier files ("shape 1",
no `artifactShape`) were ordinary rowid tables with three: `idx_climbs_search` on
`board_climbs (board_type, layout_id, is_listed)`, and `idx_stats_lookup` and `idx_stats_difficulty` on
`board_climb_stats`. They are gone. Same tables, columns and rows; about a quarter fewer bytes to
download. What that means if you read the files:

- A lookup by primary key is as fast as before: `board_climbs.uuid`, and
  `(board_type, climb_uuid, angle)` on the stats and grades tables. Anything else scans the table. If
  you filter by something else a lot, add your own index to your copy, for example
  `CREATE INDEX stats_by_difficulty ON board_climb_stats (board_type, angle, display_difficulty);`.
- There is no `rowid`. A query that selects or joins on `rowid`, `oid` or `_rowid_` fails on these
  tables. Use the primary key.
- Rows come back in primary-key order when you do not ask for one, where they used to come back in
  roughly the order they were written. Neither is a promise. Use `ORDER BY`.
- A reader should accept both shapes. The manifest is replaced once per export run, so it normally
  goes from all one shape to all the other in a single step; it holds both only when one layout's
  rebuild failed and kept its previous entry. The export can also be switched back to shape 1.

**Grades** ride in a sibling file, not in this one. Where a layout has Boardsesh-computed universal
grades (see `boardsesh-grade.md`), its manifest entry carries a `grades` object with its own `url`;
that file holds one `board_climb_grades` table. MoonBoard layouts have none by design.

**Board hardware** — holes, placements, LED positions, hold sets, product sizes, layouts, grade
scales — is a third artifact, one file for every board, discovered from its own manifest at
`board-snapshots/v1-catalog/manifest.json`. That is what turns a climb's `frames` string and
`layout_id` into coordinates on a wall. Same conventions: read the manifest, never hardcode a URL.

Not included: user accounts, ticks/logbooks, or any personal data beyond the public setter username
and first-ascent username attached to climbs and ascents by the climbers who published them.

## Freshness and cadence

- Exports run nightly at **07:15 UTC** (plus occasional manual runs). `generatedAt` in the
  manifest tells you what you have.
- The manifest is served with `Cache-Control: max-age=300` — allow five minutes of staleness.
- Snapshots are point-in-time copies of Boardsesh's synced catalog; climbs published on a board
  minutes ago may not appear until the next nightly run.

## Being a good consumer

- Re-resolve through the manifest; download an artifact at most once per day (they only change
  nightly). The full set was ~224 MB on the wire (~600 MB decoded) in shape 1; expect about a quarter
  less in shape 2. It is dominated by one Kilter artifact (110 MB in shape 1, 82 MB and 207 MB decoded
  in shape 2) — please don't re-fetch it hourly.
- Verify downloads: check `bytes` against what you received and run `PRAGMA quick_check` before
  trusting a file.

## Data provenance

The climbs, grades, and ascent statistics in these snapshots are user-generated content created by
climbers in each board's community. Boardsesh aggregates this catalog data to interoperate with
standing-hold training boards from multiple manufacturers. Kilter, Tension, MoonBoard, and other
board names are trademarks of their respective owners; Boardsesh is not affiliated with or endorsed
by any of them (see `/legal` on the website and `LEGAL.md`). If you redistribute or build on this
data, you are responsible for how you use it — attribute setters where you surface individual
climbs, and don't present the dataset as officially sourced from any board manufacturer.
