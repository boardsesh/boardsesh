# Repair historical cross-linked playlists

This operator tool addresses the historical ownership rows in #3541. It does not
merge accounts or prevent new cross-links; the importer and account-link guards
already address those causes. A merged PR or green CI does not demonstrate that
production rows have been reviewed or repaired. Keep #3541 open until the operator
records the audit, separately approved changes and follow-up checks.

## Before selecting a database

The script loads `.env.local`, which may contain production credentials. Set an
explicit disposable local `DB_URL` for development; check the reported target host
and mode before allowing an audit. Production reads and writes require separate
operator approval. Do not paste credentials or the report's user emails into a
public issue.

Required author validation uses separate Node test invocations from the repo root:

```sh
vp exec tsx --test packages/db/scripts/repair-cross-linked-playlists-helpers.test.ts
vp exec tsx --test packages/db/scripts/repair-cross-linked-playlists-args.test.ts
REPAIR_CROSS_LINKED_PLAYLISTS_DB_URL=postgresql://postgres:postgres@127.0.0.1:5433/boardsesh_backend_test_w1 vp exec tsx --test packages/db/scripts/repair-cross-linked-playlists.integration.test.ts
```

Use a disposable local PostgreSQL database with the repository schema migrated and the fixture role's temporary-table
permissions. The integration connection accepts only local development addresses;
all fixtures roll back. Require all three PostgreSQL cases to run without
skips. They exercise ownership/visibility drift, rollback, public attachments and
cross-linked board-account discovery. Standard CI does not run this opt-in suite;
`CI green` is the PR's internal-change template plan, not production acceptance.

## Review the audit

After selecting and approving the target, run the read-only default:

```sh
vp run db:repair-cross-linked-playlists -- --playlist-ids 12,34
```

Omitting `--playlist-ids` audits all multi-owner playlists. The board-account report
always scans cross-linked credentials/mappings and is informational; the playlist
filter does not constrain that report. Store output privately with the reviewed
commit, target and options. The preview is a maximum before locked drift checks,
not a promise of the number of writes.

| Classification | Meaning and default action |
| --- | --- |
| `revoke-adopter` | Known JSON-import residue, exactly two distinct owner rows with ordered timestamps at least 30 minutes apart; later ownership is eligible for removal. |
| `defer-to-account-merge` | Case/whitespace-equivalent emails suggest duplicate accounts; leave unchanged and review account merging separately. |
| `refuse` | Unknown cause, sharing roles, ambiguous owners or timestamps; report only and investigate manually. |

`--min-spread-minutes` changes the attribution threshold. Even zero never accepts
equal timestamps. `--include-merge-candidates` opts deferred cases into the same
ownership-revoke path; it does not move ticks or credentials and is not an account
merge. Review both options explicitly rather than using them to clear refusals.

## Apply only the reviewed scope

Before an approved production apply, retain a restorable database backup and the
private audit, choose a low-traffic window, and verify the target, commit, IDs and
options again. There is no built-in undo or persisted recovery snapshot.

```sh
vp run db:repair-cross-linked-playlists -- --playlist-ids 12,34 --apply
```

The script takes an advisory lock and locks each selected playlist and ownership
rows inside one transaction. Changed visibility, owner IDs, roles or ownership
timestamps cause that playlist to be skipped; processing continues for other
candidates. The validated subset commits together. A SQL or invariant error rolls
back the transaction. Locks on processed rows last until commit/rollback, so do not
run competing repair commands or account merges against the same records.

The post-commit summary reports actual returned ownership/pin/follow deletions and
tombstones. Drift-skipped IDs were not repaired; other validated IDs may have
committed in the same run. Re-audit before retrying a skipped ID. Already repaired
playlists no longer meet the two-owner selection; never infer success solely from
a smaller candidate count.

Only the later ownership row is removed. On private playlists, that user's pins
and follows are removed too; on public playlists those viewer relationships remain.
Playlist content, climbs, ticks, users and credentials remain intact. One
adopter-scoped `sync_deletions` playlist tombstone is appended after a real ownership
removal so that user's offline replica drops its stale owned copy; the creator and
other viewers do not receive that tombstone. See [offline deletion semantics](./offline-sync-plan.md).

Record the actual counts, skipped IDs and errors privately. Confirm the creator's
access, the adopter's updated owned-playlist list, preserved public pins/follows,
and offline refresh before closing the issue. A rollback after commit requires a
separately reviewed recovery from the backup, including offline-sync consequences.
