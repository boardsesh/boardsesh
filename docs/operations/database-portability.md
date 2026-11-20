# Database portability and recovery requirements

PostgreSQL remains portable through standard connection strings, `pg_dump` and
`pg_restore`. The completed Neon migration is no longer an operating procedure.
Use [PostgreSQL migration](postgres-18-migration.md) for the reviewed migration
tooling and [disaster recovery](postgres-dr-architecture.md) for the current
primary/standby topology and its recovery limitations.

## Restore configuration as well as rows

A restore into a precreated database and logical replication do not inherit all
database settings. Reapply the database-level
`max_parallel_workers_per_gather = 0` default and verify it with the target
application credential before routing traffic. A custom archive restored with
`pg_restore --create` preserves database settings, but still needs separately
provisioned global roles. See [restore verification](db-connectivity.md#preserving-the-default-through-a-database-restore).

`ALTER SYSTEM` settings, TLS material, role grants, extension availability and
replication configuration need separate verification. The [DR settings
inventory](postgres-dr-architecture.md#primary-settings-outside-the-image) records
the settings outside the image; a data dump alone is insufficient.

## Logical replication and sequences

Logical replication does not copy sequence state. Fence all source writers,
terminate their existing sessions, wait for every subscription table to become
ready and for the subscriber to reach the source flush LSN, then use
`scripts/postgres-logical-replication.sh sync-sequences`. The helper preserves
both `last_value` and `is_called`; setting a previously unused sequence as called
would skip its first ID. Follow the complete [migration gates](postgres-18-migration.md)
before using the helper; this page does not authorize a cutover.

After a logical move, point-in-time recovery or potentially lossy promotion,
reset the partner feed generation while the API and writers remain fenced.
Transaction IDs alone cannot identify the source cluster or prove that previously
acknowledged history survived. See the [integration contract](../integrations/integration-platform.md)
for the generation reset, snapshot invalidation and old-cursor `410` behavior.

## Interrupted replication setup

An orphan source slot retains WAL until cleaned up. The guarded
`scripts/postgres-logical-replication.sh teardown` validates ownership and the
exact migration objects before changing them. Use the source, target and
replication connection variables documented by the [migration runbook](postgres-18-migration.md),
with `TEARDOWN_CONFIRMED=true` and the exact publication, subscription and slot
names. Do not improvise unconditional SQL drops.

If the subscription still exists, `TARGET_OWNER_ROLE` and
`TARGET_SUBSCRIBER_ROLE` are required before any mutation. If it is already
gone, teardown can remove the verified inactive orphan slot and publication
without those role names, then exits nonzero asking for both to finish role
cleanup. That nonzero exit can therefore mean WAL retention has been cleared,
not that nothing happened. Supply both names and rerun to finish. Drifted or
unrelated objects remain untouched for operator investigation.

## Read routing and rollback

The primary is authoritative. Replica reads can lag and cannot establish that a
newly written row is absent. A DNS or connection-string change does not fence
writers. After the target accepts its first write, recovery must preserve that
target's authoritative history; switching back to a stale source is unsafe.
Use the reviewed [DR procedure](postgres-dr-architecture.md#failover), including
its explicit readiness gaps, for physical recovery.
