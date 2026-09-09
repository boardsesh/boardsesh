# Climb-wide favorites rollout

Favorites belong to `(user_id, climb_uuid)`. Deploy this in two ordered changes so an app update cannot require a backend that has not arrived, and a database migration cannot reject the backend that is still serving requests.

## 1. Backend compatibility

Deploy the compatibility PR completely before merging #4256. It accepts both legacy board/angle inputs and UUID-only requests. Favorites reads ignore board and angle and return distinct UUIDs. Mutations take a transaction-scoped advisory lock per user and climb, check existing rows across angles, and use untargeted `ON CONFLICT DO NOTHING`. This works with either the original four-column unique index or the future two-column unique index.

Inserts still populate the non-null legacy columns. The board comes from the catalog when available, falling back to the old input for unknown climbs; angle retains the input or defaults to zero. These columns are storage metadata, not favorite identity. The existing sync payload and three-part deletion IDs remain unchanged in this release, so current SQLite clients continue syncing.

This step has no database migration and does not change mobile query documents. During its own rolling deployment, older instances can still create angle duplicates under the existing index. The later migration archives and collapses those rows. Do not apply the unique-index migration until every serving backend instance runs compatible writers.

## 2. Storage and client update (#4256)

Once backend compatibility is deployed successfully, merge #4256. Keep the compatibility mutation implementation while the new index and client changes roll out. New mobile code can arrive before this second backend deployment because the compatibility backend already accepts UUID-only operations. The migration can arrive before this second backend deployment because the compatibility writer never targets the obsolete conflict key.

Keep `userFavoritesCounts`, `userActiveBoards`, and the `FavoritesCount` response type available to shipped clients, even when current app code stops importing their query documents. Their resolvers derive favorite board identity from the climb catalog after the rekey. Existing `boardName` and `angle` arguments and input fields remain accepted. Removing a GraphQL field invalidates the entire older operation during validation; schema removal requires a separate retirement decision based on supported client versions, not the absence of current call sites.

The Postgres migration archives duplicate favorites before deduplication and suppresses deletion tombstones during that process. SQLite migration 6 changes the local primary key to `climb_uuid`, preserving shipped migration 5. The client accepts both three-part and UUID deletion IDs, with timestamp protection for a later re-add. The server keeps emitting three-part IDs because older apps skip bare UUIDs. When a favorite is removed, the trigger also emits IDs for that user's archived angle variants, clearing rows left on devices that have not migrated yet. An index supports this archive lookup.

After step 2, rollback targets must retain the compatibility backend. Reverting to an earlier writer while the new unique index is installed can raise `23505` or fail conflict-target inference. Column and wire-field removal remain a separate cleanup in #4246 after the client population is accounted for.

## Verification

Backend integration tests run both payload formats against the legacy index, both indexes together, and the new index alone. They cover concurrent adds and toggles, old duplicate rows, account isolation, and non-null values needed by older sync clients. GraphQL validation covers shipped non-null variables and new UUID-only documents.
