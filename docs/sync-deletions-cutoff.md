# Deletion sync cutoff: database objects with no reader

#6339 added a publication rule for board sync and an ordering guard for
`syncDeletions`. Production applied its four migrations on 2026-10-13 at
01:56 UTC. #6431 reverted the code and kept the migrations, because a migration
that production has applied is never edited or removed. The backend reads none
of these objects now. A follow-up migration drops them once #6431's backend is
live, and an administrator then removes the helper and its role.

## What is in the database

| Migration                               | Object                                                                                                          | Still fires? |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------ |
| `0270_climb_reference_membership`       | `trg_board_climbs_reference_membership` on `board_climbs`, function `sync_board_climb_reference_membership()` | Yes          |
| `0271_sync_deletions_stream`            | `sync_deletions.stream_at`, `sync_deletions_user_stream_idx`, `sync_deletions_null_stream_idx`                 | Indexes only |
| `0272_sync_deletions_cutoff_guard`      | `trg_sync_deletion_stream_at` on `sync_deletions`, function `stamp_sync_deletion_stream_at()`                  | Yes          |
| `0273_climb_membership_withdrawal_flag` | `sync_deletions.is_membership_withdrawal` (`boolean NOT NULL DEFAULT false`)                                   | No           |
| admin bootstrap, outside any migration  | `public.sync_deletions_safe_cutoff(double precision)`, role `boardsesh_sync_cutoff_owner`                      | No caller    |

What the two live triggers do under the reverted backend:

- **0270.** When an update moves a climb out of "published and listed", it
  writes a NULL-scoped `board_climbs` marker stamped one second before the
  row's new `updated_at`. A device drops its older copy, then pulls the new row
  on its next climb page if `syncClimbs` still returns it, so the climb comes
  back with its new flags. A protected climb that changes owner gets a marker
  scoped to the old owner. In either direction the trigger also bumps the
  climb's `board_climb_stats` and `board_climb_grades` cursor fields, so devices
  pull those rows again. Bulk imports that set
  `boardsesh.suppress_sync_tombstones` skip the marker. The trigger adds work
  to the write; it does not change what the write stores.
- **0272.** Every new marker gets `stream_at = clock_timestamp()`. The resolver
  pages on `(deleted_at, id)` again and never reads `stream_at`.
- **0273.** No writer sets the flag, so every marker is an ordinary one.

A device whose last deletion cursor came from #6339's backend holds a
`stream_at` value in the cursor's `updatedAt`, which is later than that
marker's `deleted_at`. Every marker one transaction writes shares one
`deleted_at`, so comparing `deleted_at` with that cursor would skip the rest of
the transaction for good whenever a page ended inside it: a playlist's climbs, a
catalogue delete, any multi-row delete. No long transaction is needed for that.
So the resolver resumes from the earlier of the cursor's time and the
`deleted_at` of the marker the cursor names, looked up by id
(`deletionResumeTimestamp` in `resolvers/sync/queries.ts`). It names no column
#6339 added.

- A cursor the reverted resolver issued already holds the named marker's exact
  `deleted_at`, so the lookup changes nothing. An epoch cursor, a pruned marker
  or a marker outside the caller's scope keeps the cursor's time.
- A resumed #6339 cursor can deliver a marker twice: one another transaction
  wrote between the named marker's `deleted_at` and its `stream_at`, which
  #6339 already sent. The client's `updated_at <= deletedAt` guard makes that
  harmless.
- It can still miss a marker from a transaction that started before the named
  marker's transaction and wrote after #6339 issued the cursor. #6339 only
  issued a cursor below the start of every open writer and below the stability
  window, so that transaction ran for longer than the window: the long
  transaction the 30-second window already missed before #6339. A `0270`
  marker can also land there through its one-second backdate. Under the
  reverted resolvers that costs nothing, because `syncClimbs` sends the climb's
  new row anyway.

## Why the bootstrap tooling stays

`0272` refuses to run until the helper exists, is owned by
`boardsesh_sync_cutoff_owner`, and matches its pinned body and privileges. The
migration login cannot create it. So every database that replays the journal
from zero still needs the admin bootstrap first:

- `bootstrap-sync-deletions-cutoff-development.ts` (explicit development flag,
  local host only). It runs in `scripts/dev-db-up.sh`, the dev-db image build,
  CI's full-journal replay, E2E, and the migration-renumber replay.
- `bootstrap-sync-deletions-cutoff.ts` is the reviewed admin path, plan by
  default and `--apply` with `SYNC_CUTOFF_ADMIN_DATABASE_URL`. Production
  already has the helper; do not run it there again.

`packages/db/scripts/migration-runtime-acl.ts` checks the helper's contract on
every production migrate and leaves that one function out of the routine ACL
sweep. The logical-replication restore and the migration audit scripts carry
the same exception. Keep all of them until the cleanup migration has dropped
`sync_deletions.stream_at`: the contract accepts a missing helper only once that
column is gone.

## Order of the cleanup

1. #6431's backend is live in production (`/health` reports its merge commit
   or later).
2. The cleanup PR merges. Its migration drops the triggers, both trigger
   functions, both indexes and both columns.
3. An administrator runs the teardown script, which drops the helper and the
   role and refuses while `stream_at` or the stream trigger still exists.

Do not drop the helper before step 2. Production migrate would fail its ACL
preflight, because `stream_at` would still exist with no helper.

Do not roll the backend back to #6339's build (`549969d683`) at any point from
here on. It calls the helper and reads `stream_at` and the flag, so it fails
once step 2 lands, and before that it brings back the code the owner decided
to revert.
