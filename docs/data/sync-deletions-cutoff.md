# Deletion sync cutoff (historical)

Nothing in the running system uses anything described here. This page exists
because four applied migrations still need an admin step to replay, and because
production needs one admin step to finish removing them.

## What happened

#6339 added a publication rule for board sync and an ordering guard for
`syncDeletions`. Production applied its migrations `0270` to `0273` on
2026-10-13 at 01:56 UTC. #6431 reverted the code and kept the migrations,
because an applied migration is never edited or removed. Migrations `0274` and
`0275` then dropped what they had created:

| Created by | Object                                                                         | Dropped by |
| ---------- | ------------------------------------------------------------------------------ | ---------- |
| `0270`     | trigger `trg_board_climbs_reference_membership` on `board_climbs`              | `0274`     |
| `0270`     | function `sync_board_climb_reference_membership()`                             | `0274`     |
| `0271`     | column `sync_deletions.stream_at`                                              | `0275`     |
| `0271`     | indexes `sync_deletions_user_stream_idx`, `sync_deletions_null_stream_idx`     | `0275`     |
| `0272`     | trigger `trg_sync_deletion_stream_at` on `sync_deletions`                      | `0274`     |
| `0272`     | function `stamp_sync_deletion_stream_at()`                                     | `0274`     |
| `0273`     | column `sync_deletions.is_membership_withdrawal`                               | `0275`     |
| admin step | function `public.sync_deletions_safe_cutoff(double precision)`                 | teardown   |
| admin step | role `boardsesh_sync_cutoff_owner` and its `pg_read_all_stats` membership     | teardown   |

The last two are not a migration's to drop. An administrator installed them,
the migration login cannot remove them, and `0272` needs them to replay.

## Cursors #6339 issued

`syncDeletions` keeps one piece of this history after the cleanup. A device
that last pulled deletions from #6339's backend holds a cursor whose time is the
last marker's `stream_at`, later than that marker's `deleted_at`. All markers of
one transaction share one `deleted_at`, so a plain `(deleted_at, id)` comparison
would skip the rest of a transaction whenever #6339's page ended inside it. The
resolver therefore resumes from the earlier of the cursor's time and the named
marker's `deleted_at`, looked up by id (`deletionResumeTimestamp` in
`resolvers/sync/queries.ts`).

- It names no dropped column, so it works on both sides of `0275`.
- A cursor the current resolver issued holds the marker's exact `deleted_at`,
  so nothing changes for it. An epoch cursor, a pruned marker or another
  account's marker keeps the cursor's time.
- A resumed #6339 cursor can deliver a marker twice; the client's
  `updated_at <= deletedAt` guard makes that harmless.
- It can still miss a marker from a transaction that started before the named
  marker's transaction and committed after it. That includes short
  transactions, not only ones that outlived the stability window: the
  independent review lost a marker from a 1 s transaction that landed just past
  a full #6339 page. Only devices holding a cursor #6339 issued are exposed,
  and only for markers written in that overlap. We accept that rather than
  widen the resume point further.

Once every such cursor has advanced, the lookup is a no-op. It can stay; it
costs one primary-key read per page.

## Fresh databases still need the bootstrap

`0272` opens with a check that refuses to run until the helper exists, is owned
by `boardsesh_sync_cutoff_owner`, and matches its pinned body and privileges.
So a database that replays the journal from zero still needs the admin
bootstrap before migrating, and keeps the unused helper and role afterwards:

- `bootstrap-sync-deletions-cutoff-development.ts` (explicit development flag,
  local hosts only) runs in `scripts/dev-db-up.sh`, the dev-db image build,
  CI's full-journal replay, E2E, and the migration-renumber replay.
- `bootstrap-sync-deletions-cutoff.ts` is the reviewed admin path: plan by
  default, `--apply` with `SYNC_CUTOFF_ADMIN_DATABASE_URL`.

`packages/db/scripts/migration-runtime-acl.ts`, the logical-replication restore
and the migration audit keep their exception for the helper. Each one accepts a
database with no helper once `sync_deletions.stream_at` is gone, so they hold
on a fresh database and on production after the teardown alike.

## Production teardown

Run this once, after `0274` and `0275` are in production's ledger
(`vp run db:verify-journal` lists them as recorded) and the backend that
shipped with them is live.

1. `vp exec tsx packages/db/scripts/teardown-sync-deletions-cutoff.ts` prints
   the plan without connecting.
2. Set `SYNC_CUTOFF_ADMIN_DATABASE_URL` to a superuser URL and run it again. It
   inspects the database in a read-only transaction and prints what it would
   drop, or why it refuses.
3. Add `--apply`. In one transaction it drops the helper, revokes
   `pg_read_all_stats` from the role, drops the role, and checks the contract
   the migration ACL preflight runs. A refusal or a failed check rolls back
   everything.
4. Run step 3 again. It prints "Nothing to remove".

It refuses, without changing anything, while:

- `stream_at`, `is_membership_withdrawal` or either #6339 trigger or trigger
  function still exists. The migration ACL preflight accepts a missing helper
  only once `stream_at` is gone, so tearing down first would fail the next
  production migrate.
- the helper differs from the reviewed body or owner.
- anything depends on the helper, or another function's source names it.
- the role owns or holds privileges on anything else, in any database on the
  server (the role is cluster-wide).
- the role has members, or is a member of anything but `pg_read_all_stats`.

`SYNC_CUTOFF_RUNTIME_ROLE` defaults to `boardsesh_runtime`, the same as the
bootstrap. The script never reads `DATABASE_URL`.

## Rollback

Never roll the backend back to #6339's build (`549969d683`). It calls the helper
and pages on `stream_at`, and both are gone. Any build from #6431 on is a safe
rollback target.
