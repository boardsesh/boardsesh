# Database migrations: numbering, collisions, and the renumber bot

How Drizzle migrations are numbered in this repo, what happens when two PRs claim the
same number, and what the automation does about it.

## The shape of the folder

```
packages/db/drizzle/
  0186_backfill_sync_frozen_at.sql      # the migration
  meta/_journal.json                    # the ordered list drizzle actually applies
  meta/0186_snapshot.json               # the full schema state after this migration
```

Three properties matter more than they look:

**Order comes from `when`, not from the number.** `packages/db/scripts/migrate.ts` and
`scripts/dev-db-up.sh` both select entries whose `when` is newer than the last applied
migration. A migration whose `when` is at or below an already-applied timestamp is
skipped _forever_, silently — green PR, green deploy, DDL that never happened. The
number is for humans; `when` is what runs.

**A `.sql` with no journal entry is inert.** Nothing applies it. It looks like a
migration in review and does nothing in production.

**Snapshots are a chain.** Each one records the full schema state and names its parent
via `prevId`. `drizzle-kit generate` diffs the built schema against the newest snapshot,
so a broken chain produces wrong DDL — or, more often, silence.

## Creating one

```bash
cd packages/db
vp exec drizzle-kit generate --name describes_what_it_does
```

`vp run build:db` runs first if your schema changed — `drizzle.config.ts` reads
`./dist/schema/index.js`, so a stale build makes `generate` hallucinate column renames
and stop on an interactive prompt.

Data-only migrations (backfills, one-off corrections) have no schema delta, so
`generate` produces nothing to diff. Use `vp exec drizzle-kit generate --custom --name …`,
which writes an empty `.sql` and the journal entry for you, then fill in the body.
Several existing backfills use a `_bs_migration_guards` row to stay idempotent; that
guard key is a semantic identity, **not** the filename, so it must never be renumbered —
which is why the renumber bot never rewrites anything inside a migration body.

### The `check()` constraint footgun

drizzle-kit 0.31 does not reliably diff the object-form `check()` used in a table's
index/constraint callback: a `generate` run touching a table that already has one can
emit a spurious `DROP CONSTRAINT` for it and quietly drop it from the new snapshot,
even though nothing about the constraint changed. `boardsesh_ticks_quality_range`
(migration 0153, patched in 0155) and `board_sessions_explicit_board_path_check`
(migration 0216) are both manually-managed for this reason.

Whenever you `generate` a migration for a table carrying one of these constraints,
check the output for a `DROP CONSTRAINT` on it that your schema change didn't ask for.
If you find one, strip that statement from the generated `.sql` and hand-patch the
constraint back into the generated snapshot JSON so the next diff doesn't try to drop
it again. Leave a comment on the constraint in the schema file (see `sessions.ts` or
`ascents.ts`) so the next person touching that table knows to check.

## When main takes your number

Migration numbers are first-come-first-served, and every open migration PR appends to
the same `_journal.json` tail. So several PRs can each hold `0187` and each report
_mergeable_ — right up until one of them merges, at which point all the others go
`CONFLICTING`. This is routine: 109 migrations landed in one recent three-month window,
and git history carries 26 hand-written renumber commits.

**You usually don't have to do anything.** CI labels your PR `db-migration`, and when a
migration lands on main, `.github/workflows/db-migration-renumber-dispatch.yml` fans out
a renumber run for every stranded PR. The bot rebases you onto main, moves your
migration to the next free number, proves it still applies against Postgres, and
force-pushes. Your SQL is never rewritten. Its PR comment says the renumber landed
only after that force-push succeeds; a failed validation, proof, re-check, or push
leaves a "Nothing was pushed" comment with the action run to inspect.

To do it yourself, or when the bot stops:

```bash
vp run db:renumber                      # rebase onto origin/main and renumber
vp run db:renumber -- --dry-run         # do the work, skip the commit
vp run db:renumber -- --strategy merge  # merge instead of rebase (no force-push needed)
```

### When the bot stops and hands it back

It blocks — pushing nothing — rather than guess, in these cases:

| It says                                          | What happened                                                                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| conflicts outside the migration folder           | A real code conflict. Resolving it by rule would silently pick a side of someone's work.                                                                                                   |
| `generate` produced no migration                 | Either main already landed your schema change, or drizzle needs you to say whether something was created or renamed. Rebase locally and run `vp exec drizzle-kit generate` to see the prompt. |
| this branch adds two migrations at one number    | Apply order is ambiguous; guessing would be worse than asking.                                                                                                                             |
| tag referenced by files this branch didn't touch | Almost certainly a `_bs_migration_guards` key, which must not move.                                                                                                                        |
| the rebase altered a file this branch owns       | A safety assertion tripped. Please report it.                                                                                                                                              |

Add the `renumber:skip` label to opt a PR out entirely.

### What it will not do

- **Fork PRs.** The GitHub App is installed on this repo only, so it cannot push to a
  fork — and fork PRs never get the label in the first place, because `pull_request`
  hands fork workflows a read-only token.
- **Rewrite your SQL.** If `drizzle-kit` would now generate something different, the bot
  keeps your version and posts the difference as a comment for you to judge. Hand-tuning
  is real here (batched backfills, explicit sequences, lock avoidance).

## The guard rails

`vp run check:db-migrations` runs on every PR touching `packages/db`. It has no database
and no build — a few file reads:

- a `.sql` with no journal entry, or a journal entry with no `.sql`
- two migrations the branch adds at the same number
- a number main has already taken
- a `when` that is not newer than main's newest
- new entries interleaved instead of appended

It deliberately ignores six duplicate numbers that main has carried since 2024
(`0025`, `0048`–`0052`). Both sides are journalled and applied in production; they order
correctly by `when` and cannot be fixed now.

### The journal-vs-ledger check (`VERIFY_MIGRATION_JOURNAL=1`)

`check:db-migrations` reads files. It cannot see whether a database actually ran them, and
one failure mode only shows up there.

Drizzle's applier is a single high-water mark, not a reconciliation. `PgDialect.migrate()`
reads `max(created_at)` from `drizzle.__drizzle_migrations` **once, before the loop**, and
applies only journal entries whose `when` is strictly greater. A migration appended with a
`when` at or below that mark is skipped on that deploy — and on every deploy after it,
because the mark only ever moves up. Production hit this with `0129_numerous_star_brand`:
`location_sync_gym_sources` was never created, and the first Kilter location sync days
later died on `relation "location_sync_gym_sources" does not exist`.

With `VERIFY_MIGRATION_JOURNAL=1`, `packages/db/scripts/migrate.ts` now checks **every**
journal entry against the ledger, keyed on the migration hash, and throws with the missing
tags named. `production-deploy.yml` and `db-migration-renumber.yml` both set it. It stays
opt-in for now because the `boardsesh-dev-db` image is missing `0187_sad_freak`'s ledger
row, so a default-on check would redden every developer's `vp run db:migrate`.

Run it read-only against any database, without applying anything:

```
DB_URL=postgres://... vp run db:verify-journal
```

That is one `SELECT hash FROM drizzle.__drizzle_migrations` plus local file reads — safe to
point at production, and worth doing before merging anything that touches the migration
folder, since `migrate` gates both production deploy jobs. On a gap it prints each missing
tag with the ledger hash that tag's repair row needs:

```
❌ 1 of 188 journal migrations have no row in drizzle.__drizzle_migrations (189 rows present).
   • 0187_sad_freak  (ledger hash 9f2c…)
```

Tags in the recorded baseline (see below) print the same way but as a `⚠️` and without
setting the exit code.

Take the hash from that output rather than computing a sha256 yourself. The whole reason
this check calls drizzle's own `readMigrationFiles` is that a re-derived hash drifts on
encoding, BOM, line endings, or a drizzle change — and a repair row carrying a hash drizzle
would not have written re-opens the same gap under a different name.

**When it fires.** It does not self-heal, on purpose: several migrations here are data
backfills whose idempotence hinges on `_bs_migration_guards` semantic keys, so re-running a
mixed DDL/DML set unattended is worse than a blocked deploy.

A missing row is not proof the migration never ran. Two states produce the same report and
need different repairs:

- **The migration never ran** — usually drizzle's high-water-mark skip, the `0129` case
  above. The objects are absent.
- **The schema is there, the ledger row is not** — a snapshot or restore, a row lost in an
  earlier hand repair, a renumber. `boardsesh-dev-db` is in exactly this state for
  `0187_sad_freak` today (#3978): the tables and types exist, the row does not. The `.sql`
  files are not idempotent, so applying one here just fails on `… already exists`.

Repair each named tag by hand, in this order:

1. Check whether that migration's objects already exist (`\d <table>`, `\dT <type>`). If they
   all do, go straight to step 3 and insert only the ledger row.
2. Otherwise read `packages/db/drizzle/<tag>.sql`, confirm it is safe against the current
   schema, and apply it inside a transaction. Partial state — some objects present, some not
   — means trimming the statement list by hand; there is no safe shortcut.
3. Insert the ledger row (in the same transaction as step 2, when there was one) with the
   journal's `when` as `created_at` and the hash `db:verify-journal` printed for that tag:
   `INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES ('<ledger hash>', <when>);`
4. Re-run `vp run db:verify-journal` to confirm the repair.

Extra ledger rows matching no journal entry are ignored — renumbering leaves those behind
legitimately, and failing on them would block deploys for benign residue.

#### The recorded baseline

The gate's first armed run found 20 of production's 188 journal entries with no ledger row
— a backlog going back to the initial schema, not the regression the check was built for —
and blocked the production deploy, because `migrate` is the `needs:` gate for both
`deploy-web-railway` and `deploy-production-backend`.

Those 20 migrations are listed in `scripts/lib/migration-ledger-baseline.ts` and subtracted
before the gate throws. A gap in any other journal entry still fails the deploy, which keeps
the case that matters: a freshly appended migration skipped by the high-water mark (the `0129`
incident) is caught on the first deploy after it happens.

Each entry pins the hash its `.sql` had when the gap was recorded, and the exemption only
applies at that exact content. Edit a baselined migration and drizzle expects a new hash while
the old `when` still stops it replaying — a tag-only exemption would report "known gap, deploy
on" while the edited DDL ran nowhere. Instead the gap turns fatal with the edit named, and
`vp run test:db:migration-journal` catches the drift at PR time. Applied migrations are not
editable; write a new one.

The baseline is a stopgap, not a resolution. Two mechanisms produce those 20 tags and only
one of them is harmless:

- **The `.sql` changed after production applied it.** The ledger holds the hash of the file
  as it ran, so an edit orphans the row. `0103_thick_puck` landed as a bare `CREATE TABLE`
  and was rewritten with `IF NOT EXISTS` guards the next day; 11 of the 20 have more than one
  content version in git history.
- **The migration never ran.** Then production is missing that DDL right now, and the
  baseline is hiding it.

Telling them apart needs the production schema in front of you, tag by tag — the four repair
steps above, then delete that tag's line from the baseline. `vp run db:verify-journal` prints
the baselined tags with their repair hashes on every run and exits 0; a tag outside the
baseline exits 1.

Adding a tag to the baseline is not a normal fix. A new gap means DDL that did not reach
production, and baselining it ships the outage this check was written to prevent.

## Why the schema barrel is union-merged

`.gitattributes` marks `packages/db/src/schema/**/index.ts` as `merge=union`. The file is
an append-only export list, so two PRs that each add a table both append to the same last
line and conflict on every single rebase — even though the resolution is always "keep
both". Union merge is git's built-in answer for exactly this file shape.

Without it the renumber bot blocks on nearly every table-adding PR, which is most of
them. The failure mode is loud rather than silent: if both sides add the _same_ export,
the union keeps both copies and TypeScript fails the build.
