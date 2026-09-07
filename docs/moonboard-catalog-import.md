# MoonBoard catalog import

How a MoonBoard capture becomes rows in production: the three scripts, the order
they run in, what each of them refuses to do, and how to read the counters.

MoonBoard has no sync daemon. Unlike Kilter and Tension, whose catalogs stream in
continuously, the MoonBoard catalog only moves when someone runs these scripts by
hand against a capture. `packages/moonboard-sync` covers gym locations only.

## The capture

A capture is a directory of seven JSON files, one per board, each shaped
`{ count, holdsetup, problems[] }`, plus a separate beta-video JSON keyed by
problem id. They come from the MoonBoard iOS app's REST API (see the
`moonboard-scraper` repo). They are large — roughly 260 MB for the catalog — and
are **not committed**.

`HOLDSETUP_TO_LAYOUT` in `packages/db/scripts/moonboard-catalog-helpers.ts` maps
the app's `holdsetup` ids onto our layout ids:

| holdsetup | Board | Layout | Angles |
| --------: | ----- | -----: | ------ |
| 1 | MoonBoard 2016 | 2 | 25° / 40° |
| 15 | MoonBoard Masters 2017 | 4 | 25° / 40° |
| 17 | MoonBoard Masters 2019 | 5 | 25° / 40° |
| 19 | Mini MoonBoard 2020 | 6 | 40° |
| 21 | MoonBoard 2024 | 3 | 25° / 40° |
| 22 | Mini MoonBoard 2025 | 7 | 40° |
| 23 | MoonBoard 2010 | 1 | 40° |

**Check the capture's own handoff notes before importing.** Captures are produced
in stages and not every directory is finished; the scraper repo marks the ones
that must never be imported. A partial capture looks exactly like a complete one
to these scripts.

## Order of operations

Each step depends on the one above it. Run them in this order.

```sh
# 0. Point at production without putting the connection string in your shell history.
cat > /tmp/prod-db.env <<'ENV'
DB_URL="op://Boardsesh/DATABASE_URL/notesPlain"
ENV

# 1. Rehearse. Writes everything, commits nothing.
op run --env-file=/tmp/prod-db.env -- \
  vp run '@boardsesh/db#db:import-moonboard-catalog' /path/to/catalog --dry-run

# 2. The real import.
op run --env-file=/tmp/prod-db.env -- \
  vp run '@boardsesh/db#db:import-moonboard-catalog' /path/to/catalog

# 3. Derive required_set_ids for the climbs step 2 inserted.
op run --env-file=/tmp/prod-db.env -- vp run db:backfill-moonboard-set-ids

# 4. Beta videos. Needs step 2's alias rows to resolve problem ids.
op run --env-file=/tmp/prod-db.env -- \
  vp run '@boardsesh/db#db:import-moonboard-beta-links' /path/to/beta-video-links.json --dry-run
op run --env-file=/tmp/prod-db.env -- \
  vp run '@boardsesh/db#db:import-moonboard-beta-links' /path/to/beta-video-links.json

# 5. Read-only: which listed climbs does the capture no longer back?
op run --env-file=/tmp/prod-db.env -- \
  vp run '@boardsesh/db#db:report-moonboard-withdrawn' /path/to/catalog \
    --previous /path/to/previous-catalog --out withdrawn.csv
```

`DB_URL` is what targets production. It beats the dev-db value `db-connection.ts`
dotenv-loads, which `DATABASE_URL` would not — always use `DB_URL`.

The catalog and beta-link tasks are **package-scoped**: plain
`vp run db:import-moonboard-catalog` resolves no task. `db:backfill-moonboard-set-ids`
is registered at the root, so it takes the short form.

## Step 2: the catalog import

`packages/db/scripts/import-moonboard-catalog.ts`. One climb row per problem
(angle-agnostic, like Kilter and Tension), one `board_climb_stats` row per graded
angle. One transaction per board file, so a crash leaves completed boards
committed and the whole thing is idempotent on re-run.

**It merges in place and never deletes.** A capture re-keys identities, so
matching happens on `(layout_id, hold_fingerprint)` — recomputed live from
`board_climb_holds` — with a case-insensitive name tie-break. A match reuses the
existing UUID so ticks, favourites and URLs survive. Stats upserts are monotonic:
they never overwrite a grade with null or shrink an ascent count.

### Reading the counters

| Counter | Meaning | Expected |
| --- | --- | --- |
| `matched` | merged onto a climb that already existed | most of the capture |
| `inserted` | genuinely new problems | the capture's growth since last time |
| `foldedInBatch` | two problems in one file share holds and collapsed onto one climb | a handful |
| `withdrawn` | upstream marked the problem deleted | see below |
| `skippedProblems` | not importable at all (withdrawn, holdless, or no graded angle) | small |
| `skippedAmbiguous` | several listed rows already share the holds | **0** |
| `skippedDrifted` | hold-match miss, but the problem already owns rows | **0** |
| `skippedHijacked` | merging would repoint live rows the problem owns | a handful |

`skippedDrifted` above zero means a problem's holds changed under a climb we
already imported — the import cannot tell that apart from a parser regression, so
it refuses. Diff the capture's `moves` against the previous one before doing
anything else. `skippedAmbiguous` above zero on a migrated database means a
cross-problem duplicate group needing manual dedup.

Unmapped grades are reported by name. Add them to `MOONBOARD_GRADE_TO_DIFFICULTY`
in `moonboard-helpers.ts` and re-run; until then those configurations import with
a null grade, indistinguishable from an ungraded project.

### Withdrawn problems

MoonBoard withdraws a problem by setting `dateDeleted` and rewriting the setter to
`MoonBoardSystem`, while still returning the row from the API. The importer skips
it **and stops listing the climb it owns**. Rows, holds, aliases, ticks and beta
links all stay, so a logbook entry still resolves — the climb just leaves search,
matching what the MoonBoard app shows.

A climb a still-published problem also resolves to is never unlisted. Two problems
sharing holds collapse onto one climb, and one of them being withdrawn says
nothing about the other.

A problem that **disappears from the API entirely** is a different thing, and the
importer does not act on it. The app's paginated endpoint filters rows out of its
own window, so absence from one capture is not proof of deletion. Step 5 reports
that group instead.

## Step 3: `required_set_ids`

The importer leaves `required_set_ids` NULL. Until the backfill runs, new climbs
are invisible to the search set filter — the "I don't own the wooden holds" case.
The backfill is idempotent and reprocesses every MoonBoard climb, not just the new
ones, so it is safe to run whenever you are unsure whether it happened.

## Step 4: beta videos

`packages/db/scripts/import-moonboard-beta-links.ts` writes the Instagram clips
the app lists for a problem into `board_beta_links`.

Three things are deliberately **not** imported:

- **`thumbnail`** — the capture carries MoonBoard CDN URLs. The beta-video
  resolver discards any thumbnail that is not ours and caches its own copy to R2
  on first render, so a foreign URL would be dead weight that also makes the
  column lie about what we host.
- **`foreign_username`** — not in the capture. Same resolver fills it from live
  metadata.
- **`angle`** — MoonBoard beta is per-problem, and the `betaLinks` query never
  filters on it.

`board_beta_links_video_identity_unique` is a **global** partial-unique index: one
video attaches to exactly one climb across the whole table. So the importer
cannot simply insert a video for every problem that lists it. It:

1. processes problems in ascending id order, so a contested video is awarded
   deterministically and a re-run does not shuffle it;
2. checks that a problem resolves to a live climb *before* it claims a video, so
   an unresolvable low id cannot starve a resolvable higher one;
3. leaves alone any video already attached anywhere — it may have a tick and a
   cached thumbnail behind it.

Unresolved problem ids are reported. They almost always mean the catalog import
has not run yet.

> Imported links carry the import timestamp in `created_at`. The home "Fresh
> beta" strip orders by `created_at DESC` and bypasses its per-user cap for rows
> with no `foreign_username`, which these all have. They stay out of the strip
> while `thumbnail` is NULL, but they become eligible as thumbnails cache in. If
> the strip starts looking like an import dump, backdate them.

## Step 5: the withdrawn report

`packages/db/scripts/report-moonboard-withdrawn.ts` is read-only. It lists every
listed MoonBoard climb the capture no longer backs, with ascent count, Boardsesh
tick count and beta-link count, in three classes:

- `withdrawn-upstream` — a problem in this capture carries `dateDeleted`. Step 2
  already unlists these, so a non-empty bucket here means step 2 has not run.
- `vanished-from-capture` — present in the previous capture, absent from this
  one. Needs `--previous`.
- `no-catalog-alias` — no catalog problem resolves here at all. Mostly legacy rows
  from the pre-catalog imports, which are not evidence of deletion.

Without `--previous`, the middle class collapses into the last one and the report
says so. Always pass the previous capture directory when you have it.

## After the import

- **Board snapshots** rebuild on their own. The 15-minute threshold scan in
  `export-board-snapshots.yml` rebuilds any layout with ≥500 changed rows, so a
  normal capture reaches the CDN within ~15 minutes plus export time and up to
  five minutes of manifest caching. A layout with **fewer than 500** changed rows
  (MoonBoard 2010 is usually one) waits for the 07:15 UTC nightly. New
  `board_climb_aliases` rows ride the catalogue artifact, which is nightly-only,
  so they lag up to 24 h. See [board-snapshots.md](./board-snapshots.md).
- **Boardsesh grades need no refresh** — MoonBoard is deliberately excluded from
  the crowd-mean model (`refresh-climb-grades.ts`).
- **The sitemap climb store** refreshes on its own six-hourly scheduler job.
- **`hold_fingerprint`** is not written for merged climbs, so it stays NULL on
  every climb that pre-dates the column. `vp exec tsx
  packages/db/scripts/backfill-hold-fingerprints.ts --board moonboard` fills it in
  if you need the index.

## Related

- `docs/board-snapshots.md` — how catalog changes reach the mobile fleet
- `docs/moonboard-sync.md` — MoonBoard gym locations (a separate pipeline)
- `docs/db-migrations.md` — migration numbering and the renumber bot
