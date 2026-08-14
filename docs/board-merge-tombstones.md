# Board merge tombstones and serial-board dedupe

One physical wall should have exactly one `user_boards` row. Historically it could
accumulate several (the LED supplier reuses controller serials, seeded gym catalogs and
user-created boards overlapped, and the BLE first-connect path minted per-user rows).
The sticky per-user serial pointer (`user_board_serials.board_uuid`) then pinned
different climbers on the same wall to different board ids, silently fragmenting every
board-scoped join — issue #3407 is the canonical incident.

Two mechanisms keep this converged:

## Merge tombstones (`user_boards.merged_into_board_uuid`)

When the dedupe script merges duplicate rows, losers are **soft-deleted** with
`merged_into_board_uuid` set to the survivor's uuid (never hard-deleted; plain
soft-deletes keep the column NULL and must NOT redirect).

Everything that can hold a stale board reference follows the chain
(`followBoardMergeChain` in `packages/backend/src/graphql/resolvers/board-presence/shared.ts`
— the single implementation, bounded to 3 hops, dangling pointers log a warning):

- `board` / `boardBySlug` resolvers return the surviving canonical board. The
  merged-slug fallback lookup is served by the partial index
  `user_boards_merged_slug_idx`.
- `findChosenBoardForSerial` follows a remembered serial pointer at a merged loser and
  **heals** the `user_board_serials` row to point at the survivor.
- Board-presence `resolveBoardForUuid` follows the same chain, then applies ownership /
  public-readability checks to the canonical board (never the stale loser).
- Offline `saveTick` replays accept an active `boardUuid` or a merge tombstone UUID,
  then take the serial-cluster lock and stamp the canonical board id in the tick
  transaction. A UUID for an ordinary soft-delete remains unassociated and never
  falls back to a same-config board.
- Mobile self-heals a stored active board whose uuid resolves to a different (merged)
  board after hydration and on each foreground transition
  (`packages/mobile/src/lib/boards/use-active-board-self-heal.ts`). Active-board writes
  take a synchronous generation token and share a persistence queue, so a user choice
  that starts while the lookup is in flight always wins even before React Query renders it.

## Duplicate prevention at creation

- `createBoard` rejects a serial already registered to another owner's active
  **same-config** board with `BOARD_SERIAL_EXISTS` unless `allowDuplicateSerial: true`
  (the explicit escape hatch — genuine serial reuse across different walls is a
  supported reality, so there is deliberately **no global unique index on serial**).
  The error carries the existing board's uuid/slug/name **only when it is public**
  (serial-enumeration guard). Normal creates take a transaction-scoped advisory lock
  keyed by the normalized serial and re-check inside the same transaction as the
  insert, so concurrent cross-owner creates cannot both pass. The first-connect
  serial resolver and serial/config edits take the same lock and re-read while holding
  it, closing create-vs-connect and create-vs-edit races too. The explicit create
  override still takes the lock but skips the conflict check. `createBoard` is authenticated and rate-limited;
  the private-board identity mask additionally prevents the conflict response from
  exposing a private wall's name, slug, or uuid.
- The React Native create flow (native and Expo web) pre-checks the serial
  (`boardsBySerialNumbers`) and steers the user onto the existing board (follow
  - activate) before creating; a de-emphasized "create a duplicate anyway"
    remains available, including when the conflicting board is private
    (identity-masked dialog variant).

## Follow/write concurrency

`followBoard` checks the requested **active** row, applies its public/owner access
rule, and inserts the follow in one explicit `READ COMMITTED` transaction. The
active row is held `FOR SHARE` through commit. That mode lets multiple followers
proceed together while blocking merge, privacy, and delete updates to the same
board.

This gives the merge race two deliberate outcomes:

- **Follower first:** the follow commits on the loser before the merge obtains its
  board-row locks. The dedupe cluster transaction is also pinned to `READ COMMITTED`,
  so its later follow migration sees that newly committed row and moves it to the
  survivor.
- **Merge first:** the follower waits for the row update, then the active-row
  predicate is rechecked and returns `Board not found`. `followBoard` does not walk
  tombstones, so it cannot reveal that a requested private board merged into a
  different private canonical board.

The lock order is board row before `board_follows` for both paths: the follower
locks one requested board and then inserts, while dedupe locks the complete cluster
in board-id order before migrating follows. There is no follow-to-board inversion,
and concurrent followers' shared locks do not conflict with each other.

## The dedupe script

`vp run db:dedupe-serial-boards` (`packages/db/scripts/dedupe-serial-boards.ts`) —
dry-run by default; `--apply`, `--limit <n>`, `--only-serial <s>`. Uses `DB_URL` first
(maintainers run it against prod), `DATABASE_URL` otherwise; prefix `DB_URL=` to force
local.

- Merges only **config-identical** clusters (`board_type|layout_id|size_id|set_ids`,
  set ids normalised); distinct-config clusters are reported and skipped.
- When any row in a cluster is public, canonical selection is limited to those
  already-public rows: most climb events → most ticks → most follows → lowest
  id. All-private clusters use the same ranking across every row. This prevents
  a merge from promoting a private board's identity or location into discovery.
- Repoints: climb events (seq renumbered above durable history and every reserved
  `presence_seq` to satisfy `UNIQUE (board_id, seq)`), sessions, session_boards,
  ticks, beta links, follows,
  serial pointers, comments, votes (+`vote_counts` rebuild), feed items (both columns),
  notifications. A public survivor backfills gym/location metadata and a
  specific name only from public losers; all-private clusters can use every
  loser. It preserves the strongest privacy flags across the full cluster.
- One explicit `READ COMMITTED` transaction **per cluster** (advisory-locked) so a
  long run doesn't hold row locks across all clusters, a writer that commits while
  dedupe waits is visible to the migration statements, and partial progress survives
  a failure; re-running is safe (merged losers drop out of discovery).
- PostgreSQL owns board-presence sequence reservations through
  `user_boards.presence_seq`. The merge holds the same board-row locks as the allocator,
  reserves moved events above every cluster counter, and raises the survivor counter
  before commit. Dwell-qualified reports reserve the sequence and insert the matching
  durable event in one transaction, so a merge either moves that event or wins first
  and makes the stale reservation fail. Redis is mirrored to that durable result on
  the next allocation, so a stale/expired `board:<id>:seq` key cannot reuse a moved
  event sequence.
- Every merge keeps the most restrictive `hide_location` and `is_unlisted` flags
  found anywhere in the cluster, including private losers. `MoonBoard` (ignoring
  case and surrounding whitespace) is a replaceable default name. Versioned and
  Mini MoonBoard names, plus custom names, remain specific. Review dry-run
  candidates before `--apply`.

Set-id normalisation is intentionally mirrored in `@boardsesh/shared-schema`
(`normalizeSetIdsForCompare`) because board-config depends on shared-schema; the parity
test in `packages/db/src/queries/boards/__tests__/serial-dedupe.test.ts` fails if the
two ever disagree.
