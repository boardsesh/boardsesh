# Climb-wide favorites rollout

Favorites belong to `(user_id, climb_uuid)`. This rollout has two phases: establish backend compatibility and deletion safety, then update storage and clients. That order keeps app updates from outrunning their backend and prevents the archive migration from leaving deleted accounts' favorites behind.

## 1. Backend compatibility and account deletion

Deploy the compatibility writer completely before merging #4256. It accepts both legacy board/angle inputs and UUID-only requests. Favorites reads ignore board and angle and return distinct UUIDs. Mutations take a transaction-scoped advisory lock per user and climb, check existing rows across angles, and use untargeted `ON CONFLICT DO NOTHING`. This works with either the original four-column unique index or the future two-column unique index.

Also deploy the archive-aware account-delete guard to **every serving backend instance before applying the archive migration**. In the delete transaction, it locks the live `user_favorites` relation before checking whether the archive table exists. If present, it removes only that account's archived rows; if absent, deletion remains safe before the migration. The lock orders account deletion against the migration's table DDL, and the archive cleanup rolls back with the rest of account deletion.

Inserts still populate the non-null legacy columns. The board comes from the catalog when available, falling back to the old input for unknown climbs; angle retains the input or defaults to zero. These columns are storage metadata, not favorite identity. The existing sync payload and three-part deletion IDs remain unchanged in this release, so current SQLite clients continue syncing.

This step has no database migration and does not change mobile query documents. During its own rolling deployment, older instances can still create angle duplicates under the existing index. The later migration archives and collapses those rows. Do not apply the unique-index migration until every serving backend instance runs compatible writers.

## 2. Storage and client update (#4256)

Once both the compatibility writer and archive-delete guard are deployed successfully, merge #4256. Keep the compatibility mutation implementation while the new index and client changes roll out. New mobile code can arrive before this second backend deployment because the compatibility backend already accepts UUID-only operations. The migration can arrive before this second backend deployment because the earlier serving release already handles archive cleanup and the compatibility writer never targets the obsolete conflict key.

The Postgres migration archives duplicate favorites before deduplication and suppresses deletion tombstones during that process. SQLite migration 11 changes the local primary key to `climb_uuid`, preserving shipped migrations 5–10. The client accepts both historical three-part and new UUID deletion IDs, with timestamp protection for a later re-add.

After step 2, rollback targets must retain a backend release containing both the compatible favorite writers and archive-aware account deletion. A writer-compatible release without the deletion guard is not a safe rollback floor once the archive exists: account removal could leave that user's archived favorites behind. Reverting to an earlier writer while the new unique index is installed can raise `23505` or fail conflict-target inference. Column and wire-field removal remain a separate cleanup in #4246 after the client population is accounted for.

## Verification

Backend integration tests run both payload formats against the legacy index, both indexes together, and the new index alone. They cover concurrent adds and toggles, old duplicate rows, account isolation, and non-null values needed by older sync clients. GraphQL validation covers shipped non-null variables and new UUID-only documents.
