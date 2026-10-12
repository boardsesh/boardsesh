# Deletion sync transaction cutoff

A long transaction can insert a deletion marker and commit after a newer marker
has already advanced the mobile cursor. A fixed 30-second delay cannot prevent
this when the transaction lasts longer. `syncDeletions` now uses a DB-stamped
stream timestamp and waits for older writer transactions before delivering a
page. This change does not alter the document-page stability window.

`deleted_at` remains the client resurrection guard. In this release a
membership withdrawal (migration `0270_climb_reference_membership`) is stamped one second before the climb's
new `updated_at`. That is after every copy a device can have pulled, because a
device only pulls a version once it is a stability window old and deployed
windows are at least two seconds, and before the owner's re-delivered row, so a
replay of the deletion stream never deletes it. One copy is not covered: an old
public row read through MVCC while the privatizing transaction is still open,
which can be newer than the guard when that transaction runs long. The guard
migration that closes it ships one release later; see
[The withdrawal guard, one release later](#the-withdrawal-guard-one-release-later).

This release also adds the internal `is_membership_withdrawal` flag (migration
`0273_climb_membership_withdrawal_flag`) and the filter that reads it. In the same page statement, the backend
omits a flagged climb withdrawal if the current climb is readable to the viewer
under the sync public/owner and spray-wall rules. Filtering precedes
pagination, so a page containing only omitted markers cannot hide later
withdrawals from installed clients that stop on an empty page. Nothing in this
release sets the flag: every withdrawal is an ordinary marker, delivered to
every device, which the one-second backdate makes safe. Ordinary hard-delete
markers keep their original behavior. No climb timestamp is moved into the
future.

A BEFORE INSERT
trigger always stamps `stream_at` using UTC `clock_timestamp()`, including when
the caller supplies a timestamp. Existing rows retain NULL and keep their old
`deleted_at` cursor position. Cursor comparisons/indexes use
`COALESCE(stream_at, deleted_at)`, and GraphQL keeps its existing cursor shape.

The backend makes two separate primary reads, outside a shared transaction.
First, `public.sync_deletions_safe_cutoff(double precision)` returns the smaller
of the sampled DB clock minus the nonnegative stability window and the oldest
same-database writer transaction start. Idle writer transactions count. Second,
the page query gets a fresh READ COMMITTED snapshot and reads strictly below
that bound. Sampling activity inside the page statement would allow a commit
after that statement's MVCC snapshot to disappear from activity and be skipped.

The helper clears the statistics snapshot before reading activity. It verifies
effective `pg_read_all_stats` inheritance before interpreting fields, checks
activity before prepared transactions, and returns NULL for disabled/unknown
metadata or any same-database prepared transaction. Prepare time is not a safe
transaction-start bound. NULL or a helper execution failure returns an empty
page, the unchanged cursor, and `hasMore: false`; normal polling retries it.
Other roles' activity requires elevated statistics visibility; the application
login is given only a timestamp-only function call. PostgreSQL documents these
boundaries in [statistics monitoring](https://www.postgresql.org/docs/current/monitoring-stats.html)
and [prepared transactions](https://www.postgresql.org/docs/current/view-pg-prepared-xacts.html).

## Admin prerequisite and deploy order

The migration login cannot grant `pg_read_all_stats`. Run the reviewed bootstrap
as a separate administrator before migrations or backend deployment. This is
portable PostgreSQL SQL and uses no hosting-specific API.

Stage this release's updated migrator and audit tooling first, and pause older
release jobs during the bootstrap/migration window. Older runtime ACL sweeps
try to re-grant every public routine as the ordinary DDL owner, which cannot
control this separately owned helper. Do not preinstall it and then run an
older migrator. The coordinated order is updated tooling, admin bootstrap,
this release's migrations, then this release's backend. The previous backend
may keep serving sync while the migrations run: none of them writes a marker it
cannot read. Installed app versions remain compatible.

1. Run `vp exec tsx packages/db/scripts/bootstrap-sync-deletions-cutoff.ts` to inspect the plan.
2. Set `SYNC_CUTOFF_ADMIN_DATABASE_URL` and run that command with `--apply`.
3. Run migrations with the normal migration login; the prerequisite must pass.
4. Verify the runtime login can call the helper but cannot read other sessions' activity.
5. Deploy the backend; poll deletion sync and confirm its cursor advances.

`SYNC_CUTOFF_RUNTIME_ROLE` defaults to `boardsesh_runtime`; set it explicitly for
a differently named application login. The script never uses `DATABASE_URL` as
an implicit admin target. It creates `boardsesh_sync_cutoff_owner` as NOLOGIN,
NOSUPERUSER, NOCREATEDB, NOCREATEROLE, INHERIT, NOREPLICATION, NOBYPASSRLS, with
only an effective `pg_read_all_stats` membership. No other role can inherit or
SET ROLE to that owner. On PostgreSQL 16+, the stats membership has ADMIN FALSE,
INHERIT TRUE, SET FALSE; PostgreSQL 15 uses its supported grant syntax.

The function pins `search_path=pg_catalog`, qualifies catalog views, revokes
PUBLIC EXECUTE, and grants only the chosen runtime login non-grantable EXECUTE.
It owns no application tables. A preexisting helper with a different body,
owner, role graph, or ACL is rejected for administrator inspection. The
generated custom migration pins the helper body/owner/search path before
installing the insertion trigger. Missing bootstrap blocks deployment; it does
not fall back to an unsafe clock. Runtime ACL reconciliation and infrastructure
audits preserve only this exact validated function exception.

The generated stream migration adds one nullable column without backfilling old
rows and builds two expression indexes, inside the deploy's migration
transaction. Every pending migration runs in that one transaction, so until it
commits, deletion-log reads and marker writes (and so every delete on a synced
table) wait for both index builds, and climb writes wait on the trigger lock
the reference-membership migration took earlier in it. The stream migration's
header records that decision and the table-size check to run before the deploy.
The old cursor indexes remain for a backend rollback.

Disposable CI services, E2E services, migration-renumber replay and the dev-db
image invoke `bootstrap-sync-deletions-cutoff-development.ts` before migration.
This adapter requires an explicit development flag, an explicit admin URL and
a localhost/127.0.0.1/container-`postgres` hostname. It creates an absent test
runtime role without application-table privileges, then uses the same canonical
admin bootstrap. It is never invoked by the production migration workflow.

## Restore and rollback

Preserve the dedicated owner role and its stats membership when restoring a
normal PostgreSQL dump. For the restricted `--no-owner --no-acl` logical migration
workflow, run the same admin bootstrap on the target before schema restore.
The restore list excludes exactly this pre-created helper and its metadata;
ordinary routine ownership/ACL sweeps must not re-own it. The audit checks its
canonical body, owner, membership, and runtime-only EXECUTE privileges.

Leave the stream column, trigger, classification and helper in place when
rolling back. A backend from before this release is a safe rollback target
while no flagged marker exists, which holds until the guard migration below is
applied. Do not remove the helper while the new backend is running. Delivery
stalls safely during a prepared transaction or loss of stats access; monitor
paused polls and resolve that database condition.

Deployed `SYNC_STABILITY_WINDOW_SECONDS` values are clamped to at least two
seconds. Invalid settings
retain the 30-second default. Exact zero is permitted only in `NODE_ENV=test`
for immediate real-database fixture reads. The timestamp helper still safely
accepts any nonnegative bound; deployed pull resolvers supply the guarded one.

## The withdrawal guard, one release later

The guard migration replaces the membership trigger's function. It stamps a
withdrawal at the next whole UTC second after both the old climb version and
the write clock, which covers a copy read through MVCC while privatization is
uncommitted, and it sets `is_membership_withdrawal`. Whole seconds also keep
the installed SQLite text comparison right: within a second, `.100001Z` sorts
before `.1Z` even though it is numerically newer.

That marker is at or after the owner's new `updated_at`, so only the flag
filter keeps it from the owner's device. A backend without the filter, serving
sync while the migration runs or after a rollback, would deliver it and the
owner's device would delete their own climb for good. So the guard ships one
release after this one, as a separate PR stacked on it (expand, then contract):

1. This release ships the flag column and the filter, with nothing flagged.
2. The guard migration merges only once this release's backend is live in
   production. The backend still serving during that deploy then already
   filters, and so does every rollback target from this release on.
3. From then on, never roll the backend back to a build from before this
   release.
