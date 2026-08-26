# Board snapshots as a downloadable dataset

Boardsesh publishes nightly SQLite snapshots of the climb catalogs it syncs. They exist to give
the mobile app a fast first download (see `board-snapshots.md` for that pipeline), but they are
plain, publicly fetchable SQLite files — anyone who wants a local copy of the climb data for
analysis, backup, or tooling can use them directly.

## Getting the data

The one stable URL is the manifest:

```
https://boardsesh-board-snapshots.t3.tigrisfiles.io/board-snapshots/v1-gzip/manifest.json
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
manifest=https://boardsesh-board-snapshots.t3.tigrisfiles.io/board-snapshots/v1-gzip/manifest.json

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

`formatVersion: 1`. Each entry:

| Field                                                   | Meaning                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `boardType`, `layoutId`                                 | Which catalog this artifact holds                                                               |
| `url`                                                   | Public download URL (valid until pruned — always re-resolve via the manifest)                   |
| `key`                                                   | Object key under `board-snapshots/v1/`                                                          |
| `bytes`                                                 | Stored size                                                                                     |
| `contentEncoding`                                       | `identity` (a plain SQLite file) or `gzip` (gunzip before opening)                              |
| `builtAt`                                               | When the export built this artifact                                                             |
| `schemaVersion`                                         | SQLite schema revision of the tables inside                                                     |
| `tables.<name>.rowCount`                                | Row counts, for sanity-checking a download                                                      |
| `tables.<name>.watermarkUpdatedAt` / `watermarkSyncSeq` | Sync cursors (app-internal; irrelevant for dataset use)                                         |
| `grades`                                                | Present when the layout has Boardsesh grades: a sibling artifact with its own `url` and `bytes` |

Treat `schemaVersion` as informational: columns may be added over time (additive), and a breaking
layout change would ship under a new `board-snapshots/v2*` prefix rather than mutating `v1-gzip`.
A `board-snapshots/v1` prefix still carries identity-encoded copies of the same artifacts; it is
kept only as a rollback target and will be deleted, so don't build against it.

## What's inside

Each per-layout artifact is a standard SQLite database with three tables. The authoritative DDL
lives in `packages/shared/offline-sync/src/db/schema.ts`.

**`board_climbs`** — one row per climb, all 27 columns: `uuid` (primary key), `board_type`,
`layout_id`, `setter_id`, `setter_username`, `name`, `description`, `hsm`,
`edge_left/right/bottom/top` (placement bounding box), `angle` (the setter's intended angle, where
the board type has one), `frames_count`, `frames_pace`, `frames` (the hold sequence as the board's
native frame string), `is_draft`, `is_listed`, `created_at`, `published_at`, `user_id`,
`required_set_ids` / `compatible_size_ids` / `characteristics` (JSON arrays), `hold_fingerprint`,
and sync bookkeeping (`updated_at`, `sync_seq`).

Drafts and unlisted climbs **are** included — filter on `is_listed` / `is_draft` yourself if you
only want the public catalog. There is no size filter either: a layout's artifact spans every wall
size, so filter with `compatible_size_ids`.

**`board_climb_stats`** — community stats per `(climb, angle)`: `ascensionist_count`,
`difficulty_average` and `display_difficulty` (in the board's native difficulty scale),
`benchmark_difficulty` where the community designates benchmarks, `quality_average` (0–5 star
scale), and first-ascent attribution (`fa_username`, `fa_at`).

**`snapshot_meta`** — export bookkeeping (row counts, watermarks, schema/format versions). Useful
for verifying integrity: `row_count` should match `SELECT COUNT(*)` on each table.

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
  nightly). The full set is ~224 MB on the wire (~600 MB decoded), dominated by one 100 MB Kilter
  artifact — please don't re-fetch it hourly.
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
