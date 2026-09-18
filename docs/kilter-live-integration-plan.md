# Kilter live history integration

**Status:** One-way reading implemented, gated by `KILTER_LIVE_SYNC_ENABLED=1` on the backend. Upstream contribution is deferred: Boardsesh has no agreement with Kilter to publish live activity.

Protocol: [KILTER_LIVE_SPEC.md](KILTER_LIVE_SPEC.md). Related: [Kilter sync](kilter-sync.md), [board merges](board-merge-tombstones.md), [WebSockets](websocket-implementation.md).

## Scope

A signed-in viewer with a linked Kilter account starts polling when they subscribe to a public Kilter board's `boardNowPlaying` topic. Other viewers receive the merged board history through the same topic. Kilter activity is history, never evidence of a current occupant or the climb currently lit by Boardsesh.

Imports preserve Boardsesh history, current climb, holder, queue, and tick-derived statistics. No `/add`, report, or other upstream activity write is made. Existing native reports and upstream displays remain separate occurrences even if climb, angle, and time are similar.

## Exact physical wall identity

The location sync persists complete `(gymUuid, productLayoutUuid, wallUuid)` selectors in `kilter_wall_sources`. Source keys and deterministic source board UUIDs survive board merges. The backend follows up to three reverse merge links and requires exactly one listed source, matching layout, size, hold sets, and canonical gym association. It checks the binding again after the network request and inside the history transaction while holding the board row lock.

Manual/config-only boards, ambiguous mappings, private boards, custom walls, unlisted sources, and incompatible configurations are skipped. Broader matching is tracked in [#5539](https://github.com/boardsesh/boardsesh/issues/5539). Serial or configuration equality alone does not prove wall identity.

## Polling and credentials

- Each subscription operation has its own Redis viewer lease; socket close also releases all operations for that connection. Anonymous and unlinked viewers do not keep polling alive.
- A Redis owner lease selects one poller per board across backend instances. Viewer/owner leases last 60 seconds and renew every 15 seconds, bounding crash recovery. A control channel wakes owners when viewers or credentials change.
- The first read starts immediately. Successful reads wait 30 seconds plus 0–5 seconds jitter after completion; requests never overlap for a board. REST reads have a 15-second timeout. Failures back off to five minutes and honor a longer `Retry-After`.
- A 401 forces one refresh/retry. Rejected accounts are temporarily excluded so another linked viewer can take over. Removing credentials cancels work; in-flight results also recheck ownership, account identity, and remaining viewers before committing.
- Backend and daemon refresh through the same helper. A Postgres credential row lock serializes refreshes; rotated encrypted refresh tokens commit before the next reader. Unlink/revocation uses the same lock. Access tokens stay in process memory and never enter history or logs.

Redis outage stops polling until coordination recovers. The flag defaults off; existing history remains readable. Operators should restart backend instances when changing the flag.

## Merge and persistence

The parser accepts timezone-qualified display timestamps, normalizes them to UTC with microsecond precision, and prefers `derivativeAngle`. Deleted, reported, malformed, or unresolvable catalog entries are skipped. Climb aliases resolve into Boardsesh catalog IDs; name, setter, frames, and grade come from that catalog. Only `liveBoardUsername` supplies optional external attribution. Setter names and upstream user UUIDs are never mapped to Boardsesh senders.

The occurrence key hashes the complete wall selection, upstream display ID, and normalized timestamp. If an ID is absent, climb UUID and angle replace it. `(source, external_occurrence_key)` uniqueness prevents repeated polls and overlapping workers from duplicating events. Each imported event receives a reserved board sequence and `source='kilter'` in `board_climb_events`.

Imported recent history has its own Redis cache (`board:<id>:kilter-history`), retaining the newest 50 displays from seven days. The native history list is unchanged. Queries merge the two sources chronologically. A missing cache falls back to Postgres; subsequent polls rebuild it, including when every occurrence already exists. `BoardHistoryUpdated` changes client history only. Imported events are excluded from native display-count activity aggregates.

Durable event retention follows existing board history. Unlinking stops new reads; it does not erase previously imported public-wall history.

## Durable presence-sheet history

`boardHistoryPage` orders by `(confirmed_at DESC, seq DESC)` with an opaque, board-bound cursor. This separates event time from import arrival order. The legacy sequence-based `boardHistory` query and native `boardRecentClimbs` stay native-only for older clients.

The shared pagination hook automatically loads exactly one first page when the sheet mounts or changes boards. Its cursor starts independently of the sparse Redis window. A failed page remains retryable without advancing the cursor. Pull-to-refresh and reconnect reload the first durable page. The sheet merges durable and live entries chronologically, retains richer live copies, labels Kilter entries, and offers a load/retry button for lists too short to scroll.

## Rollout and verification

1. Apply migration `0232_kilter_live_history` before deploying the backend and sync daemon.
2. Run the normal Kilter reference/location sync to populate exact source selectors.
3. Enable `KILTER_LIVE_SYNC_ENABLED=1` on backend instances and restart them.
4. Open an exact imported public Kilter board with a linked account; confirm history gains labeled entries while current wall state stays unchanged.
5. Close the last linked viewer and verify polling stops. Disable the flag and restart to stop all polling without deleting history.

Automated coverage exercises repeated responses, native/imported coexistence, cache recovery, unknown climbs, binding changes and merge tombstones, chronological cursors, multiple backend instances, unsubscribe/unlink cancellation, token rotation under concurrency, history-only reducers, first-page loading, retry, and refresh.

The September 18, 2026 authorized REST probe confirmed the three-selector read shape and timestamp/angle fields. It does not establish server quotas, retention guarantees, custom-wall visibility, or permission to publish upstream. No production database writes were used during implementation.
