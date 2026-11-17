# Aurora live history integration

Boardsesh can read recently displayed climbs from the supported Aurora board apps:
Tension, Decoy, Touchstone, Grasshopper and So iLL. Kilter continues to use its
[existing integration](kilter-live-history.md), with no second Aurora reader.

The backend reader is disabled by default. Set `AURORA_LIVE_SYNC_ENABLED=1` and
list verified products in `AURORA_LIVE_SYNC_BOARDS`, separated by commas. An empty
list enables none. Enable a product only after checking its endpoint with an
account belonging to that product. The live checks described below establish
Tension access; they do not establish the other products' server policies.

## What climbers see

A signed-in viewer with a linked account for that board app starts polling when
watching an eligible public wall. Other clients that opt into Aurora history can
see the merged feed, including anonymous viewers. Anonymous or unlinked viewers
do not keep the upstream reader alive. Closing the last eligible subscription or
unlinking its account stops new reads.

Imported climbs appear in wall history with the board's source label. Their
presentation, grades and ordinary climb actions use the viewer's currently
selected angle. Changing angle changes that viewer's presentation; it does not
rewrite shared history or change what another viewer sees. The source event's
angle remains unknown. Missing orientation and displaying-user identity are not
invented from the setter or linked viewer.

The current-climb capsule follows the newest display timestamp across native
and imported events. An imported event is an inference about what may be lit,
not an ascent, occupancy signal or Bluetooth confirmation. Importing never
changes the session queue, claims control, sends LED commands or publishes an
upstream display report.

## Upstream protocol and evidence

The board name selects an allowlisted `WEB_HOSTS` entry in `@boardsesh/aurora-sync`.
The reader sends:

```http
GET /exhibits?serial_number=<controller serial>&before=<optional timestamp>
Accept: application/json
Cookie: token=<linked account session>
```

`after` is also supported by the adapter. The sampled Tension before/after
boundaries were exclusive. The real response is:

```json
{
  "exhibits": [
    {
      "climb_uuid": "example-climb-uuid",
      "serial_number": "example-controller-serial",
      "created_at": "2026-11-17 06:53:45.349160"
    }
  ]
}
```

The reader treats naive timestamps as UTC, following the shipped Android client,
and preserves microseconds for ordering, pagination and occurrence identity.
There is no event ID, display angle, mirror state or displaying user in the
verified response. Angle-specific grades come from the Boardsesh catalog for
the viewer's selected angle. `boardPresenceClimbGrades` reads at most 50 requested
UUIDs with a set-based lookup and the same board-visibility gate as history;
merged UUIDs are returned under their requested IDs.

On November 17, 2026, an authorized new Tension account successfully signed in
and read a public TB2 serial's latest 100 displays with only a session cookie.
Without a session, the feed and gym-profile read returned 401. Fresh login,
gym-profile and an empty-account sync request also worked without attestation.
An own-logbook route returned 404 and remains inconclusive.

The inspected Tension Android 5.0.3 (227) calls Firebase App Check to obtain a
token; 5.0.7 (231) immediately supplies an empty token. Their extracted signer
certificates match. This establishes a change in that client method, not the
server's historical enforcement date or iOS behavior. Source APK SHA-256:

- 5.0.3: `c02a0d37aff60842e7c7fcd9f5f9cdf94fba69c0e9c30aa38af7366d5ccb0131`
- 5.0.7: `2731ea0264796b4834c1df53b9c480142640f8bab0995780c34268b7590565f6`

No account passwords or session tokens belong in source, fixtures or logs.

## Physical wall identity

Authenticated [Aurora location enrichment](aurora-location-sync.md) records
exact upstream gym/wall/controller provenance in `aurora_wall_sources`.
Existing deterministic source keys and source-board UUIDs stay stable across
merges, including the first wall whose older source key omits its wall UUID.

A read requires exactly one listed source compatible with the public canonical
board's gym, layout, size, hold sets and controller serial. Missing, stale,
private, unlisted, ambiguous or incompatible bindings are skipped. Serial reuse
is supported by Boardsesh, so distinct known upstream physical walls sharing a
serial cannot be treated as one feed. This check is scoped to the relevant
Aurora product; a different product's serial/account is not an identity match.
Non-importable observations of unlisted or unsupported walls retain serial
conflict evidence across crawl slices and controller replacements without
creating public board rows.

The binding, viewer eligibility and ownership are checked again after HTTP and
inside the history transaction. Catalog joins are board-specific. Unknown or
layout-incompatible climbs never become history for another wall.

## Polling, persistence and compatibility

The shared polling lifecycle retains Kilter's ownership/viewer leases,
non-overlapping requests, cancellation, retry/backoff and linked-viewer failover.
Aurora requests use the linked account for the matching product. A rejected
session may trigger one normal login/retry; unlink/relink and sync writers share
credential coordination. Credentials never enter the display event.

Display occurrence keys include provider, product, stable physical source,
controller, climb and full timestamp. Repeated pages deduplicate transactionally.
Newest-first reads and bounded catch-up retain unfinished continuation; a partial
page walk must not claim a completed checkpoint. Equal-timestamp events across
page boundaries cannot be proven complete without an upstream tie-breaker.

`board_climb_events` retains source `aurora` and a null source angle. Native and
Kilter inputs retain their existing angle validation. The recent cache retains
50 entries from seven days; durable history uses chronological pagination.
Imported arrival sequences never advance native event cursors. Native displays
win exact timestamp ties, and an observed clear blocks older imported displays
from reappearing as current.

New clients opt in using `includeAurora: true` on `boardNowPlaying`,
`boardRecentHistory` and `boardHistoryPage`. The default is false, including when
an argument is omitted. Filtering occurs before pagination or live delivery;
older apps continue to receive their existing native/Kilter sources. Legacy
native-only history endpoints retain their existing contract.

## Rollout and QA

1. Apply the generated database migration and deploy the compatible backend.
2. Run authenticated Aurora location enrichment to populate exact sources.
3. Install the capable mobile client and verify its current-angle presentation.
4. Verify each product's feed, then enable only those products in the allowlist.
5. At a consenting wall, measure official-app display latency and watcher cleanup.

Use [local board QA](local-board-qa.md) for physical evidence. Confirm imports
leave the queue and LEDs unchanged, angle changes update grades/actions, clears
survive late imports, reconnects do not duplicate occurrences, and the last
eligible viewer leaving stops polling. Check an older client alongside the new
one. Disabling a product stops new imports while retaining durable history.

Rate limits, full retention, private-wall policy and physical command-to-feed
latency are not established by the HTTP probe. The reader's interval is a client
choice, not an upstream service guarantee. Issue: [#7736](https://github.com/boardsesh/boardsesh/issues/7736).
