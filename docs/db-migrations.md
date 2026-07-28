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
bunx drizzle-kit generate --name describes_what_it_does
```

`vp run build:db` runs first if your schema changed — `drizzle.config.ts` reads
`./dist/schema/index.js`, so a stale build makes `generate` hallucinate column renames
and stop on an interactive prompt.

Data-only migrations (backfills, one-off corrections) have no schema delta, so
`generate` produces nothing to diff. Use `bunx drizzle-kit generate --custom --name …`,
which writes an empty `.sql` and the journal entry for you, then fill in the body.
Several existing backfills use a `_bs_migration_guards` row to stay idempotent; that
guard key is a semantic identity, **not** the filename, so it must never be renumbered —
which is why the renumber bot never rewrites anything inside a migration body.

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
force-pushes. Your SQL is never rewritten.

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
| `generate` produced no migration                 | Either main already landed your schema change, or drizzle needs you to say whether something was created or renamed. Rebase locally and run `bunx drizzle-kit generate` to see the prompt. |
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
folder, since `migrate` gates both production deploy jobs.

**When it fires.** It does not self-heal, on purpose: several migrations here are data
backfills whose idempotence hinges on `_bs_migration_guards` semantic keys, so re-running a
mixed DDL/DML set unattended is worse than a blocked deploy. Repair each named tag by hand:

1. Read `packages/db/drizzle/<tag>.sql` and confirm it is safe against the current schema.
2. Apply it inside a transaction.
3. In the same transaction, insert the ledger row with the journal's `when` as `created_at`
   and the same hash drizzle would have written:
   `INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES (<sha256 of the .sql body>, <when>);`
   `vp run db:verify-journal` confirms the repair.

Extra ledger rows matching no journal entry are ignored — renumbering leaves those behind
legitimately, and failing on them would block deploys for benign residue.

## Why the schema barrel is union-merged

`.gitattributes` marks `packages/db/src/schema/**/index.ts` as `merge=union`. The file is
an append-only export list, so two PRs that each add a table both append to the same last
line and conflict on every single rebase — even though the resolution is always "keep
both". Union merge is git's built-in answer for exactly this file shape.

Without it the renumber bot blocks on nearly every table-adding PR, which is most of
them. The failure mode is loud rather than silent: if both sides add the _same_ export,
the union keeps both copies and TypeScript fails the build.
