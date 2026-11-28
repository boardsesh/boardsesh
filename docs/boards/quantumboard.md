# Quantum Board proof of concept

This release covers XL, L, M and S Fitness: browse, download, light and log climbs
in Boardsesh, save drafts offline, and publish climbs to Boardsesh while online.
The owner confirmed Quantum's permission to use its trademarks, release this
proof of concept and publish catalogue snapshots on 2026-11-26.

The design and unanswered API/controller questions are recorded in
[#8179](https://github.com/boardsesh/boardsesh/pull/8179). Account linking, writes
to eWalls, duplicate-climb display merging, Belay and phone-to-phone session
control transfer remain follow-ups. Separate source climbs keep their identities
and may appear separately in this proof of concept.

Quantum uses the same board, climb, hold, grade, and sync contracts as the other
boards. Provider-specific acquisition, physical identity checks, drawing, and
Bluetooth commands live behind adapters.

The catalogue comes directly from eWalls. The implementation follows the
[Android 2.6.5 API and Bluetooth research](https://github.com/boardsesh/boardsesh/pull/7926).
Personal account synchronization and outbound writes remain tracked in
[#7921](https://github.com/boardsesh/boardsesh/issues/7921), under the
[Quantum support epic](https://github.com/boardsesh/boardsesh/issues/7917).

## Feature flag

Quantum discovery, public compatibility lists, and setup require the positive
`quantum-board` feature flag on web and mobile.
It defaults off; missing, unresolved and non-boolean flag answers keep the board
hidden. The same boundary covers restored boards, direct editor/player links,
invitations and shared-session joins. A rejected join leaves the current board
and session unchanged. Disabling Quantum preserves stored boards, drafts and
ticks, and stops further controller mutations.

Testers can enable **Quantum Board** through Settings → Developer → Feature Flags.
The tester-only override follows the existing app precedence. Public snapshots
remain public: this flag controls the app rollout, not catalogue confidentiality.
Backend acquisition has a separate default-off `quantum-catalog-sync` switch;
both scheduling and execution must be enabled before a catalogue request runs.

## Board identity and immutable geometry

| Controller model | Product | Layout | Size | Source controller type |
| --- | ---: | ---: | ---: | --- |
| XL | 91 | 9101 | 9201 | `big` |
| L | 91 | 9101 | 9202 | `medium` |
| M | 91 | 9101 | 9203 | `small` |
| S Fitness | 94 | 9104 | 9204 | `xsmall` |

XL/L/M share a physical layout, with different size membership and bounds.
[Walltopia documents the shared layout](https://walltopia.com/products/quantum-board/).
The captured source confirms every L and M diode matches XL by identity, LED
address, position, and hold type. Fitness is a separate layout. Belay is deferred;
its source geometry remains recorded for future work. One shared released-model
policy controls catalogue scopes, reference rows, setup and controller selection.

The checked-in geometry capture used model-local layout IDs for L and M. The
generator normalizes those historical identities to layout 9101. Native API
UUIDs remain source identities and are bound to the generated placements at the
provider boundary; callers use the common layout and size contracts.

Physical hold maps and per-size LED membership ship as generated board constants,
following the existing generated catalog pattern. The source and provenance are
recorded in [quantum-board-geometry](../quantum-board-geometry/README.md). The
source contains 3,154 model-specific diode rows; shared standard-family holds
have one canonical placement identity. Runtime catalog imports must match the
bundled physical fingerprint, including on the first import. A geometry correction
requires a reviewed source/generator update and a new compatible application
bundle, rather than silently accepting different LED addresses.

Mobile does not fetch a geometry API, hydrate a geometry registry, or store a
separate geometry table in SQLite. Generic rendering and editor accessors return
the same dimensions and hold-target shape for bundled boards. Personal spray-wall
geometry keeps its existing runtime subscription behind the same adapter boundary.
The angle-options source is separate from geometry: the Quantum angle
query describes angles present in the catalog, not a verified hardware range.

## Catalog acquisition and trust

`@boardsesh/quantum-sync` provides a typed client for
`https://e-walls.eu/api/v1/board/routes-delta`. Bootstrap requests start at page 1
with limit 500 and stage the entire result before import. The client checks
unique route IDs, consistent counts, page progress, resource bounds, and the
exact final `totalCount`. eWalls sets `initialSync` on page 1 and clears it on
continuation pages, which still contain route arrays and can have different
timestamps. Before import, one delta from the first page's opaque `timestamp`
must explicitly report no route changes or deletions. A reported change can
shift offset pages even when the total stays the same, so the worker retries
the bootstrap on a later attempt. The API's snapshot guarantees are unverified.
The stored cursor stays at the first page, and subsequent deltas pass it as
`lastFetch`. Delta routes use `changed`/`deleted` collections and tombstones
carry object IDs. No Blossom, Nostr, SQLite-download, or third-party mirror
path remains.

The scheduled shared-catalogue source requires backend-only configuration:

```text
QUANTUM_API_TOKEN=<shared catalogue bearer credential>
QUANTUM_API_ACCOUNT_ID=<verified upstream account ID>
QUANTUM_API_CATALOG_VISIBILITY=public
QUANTUM_API_BOARD_NAME=<optional advertised board name; empty uses type lookup>
```

Configure the public catalogue lens with Walltopia. Authentication alone does
not establish that an account's data may be published. The worker verifies
`users/current-user` against the pinned account and never borrows a climber's
personal credential. Bearer credentials never enter checkpoint metadata, logs,
or device sync. The client also exposes the documented email login; refresh
semantics are unknown, so a 401 requires renewed credentials rather than an
invented refresh flow.

Only explicitly enabled public routes in that approved catalogue lens are
projected into shared content. Disabled and unknown-visibility records are
withheld before their content is mapped. An explicitly empty light array also
withdraws the route because there are no holds to display. A withdrawal retires
the source across overlapping model scopes, removes it from public browsing and
future exports, and retires its downloaded copy while preserving logged ticks.
A newer upstream revision can restore a retired route with its original holds.
Snapshot and reference exports apply the same eligibility to associated stats,
grades and aliases. Personal response collections never become shared catalogue rows.

The hiding is driven by a capability, not by Quantum checks. Quantum's row in the
board capability table sets `withdrawnCatalogClimbs: 'hidden'`, and every read
that hides a withdrawn climb follows that flag: on the
server through `withdrawnCatalogClimbCondition` and `unavailableCatalogClimbCondition`
in `packages/db`, on the phone through the tombstone predicate in
`@boardsesh/offline-sync/withdrawn-climb`. MoonBoard and Kilter set it to
`'readable'`, so their withdrawn climbs leave browsing but still open by uuid. A
board whose supplier withdraws climbs that must not be shown sets the flag and
adds its name to the device mirror; the mirror's parity test fails until it does.

The API's `-1` angle sentinel stays unknown, rather than becoming a real climb
angle. Known grade representations retain their mapping; unknown representations
stay unknown. Unconfirmed supplier count and rating semantics are retained as
source metadata rather than treated as verified sender counts or community votes.

Diode UUIDs and binary `autocadId` addresses must match the fixed generated
bindings. Light associations resolve through the API diode cache and retain
explicit start/middle/finish roles. Repeated associations with the same normalized
diode UUID and role produce one hold. A missing or malformed light array or
conflicting roles for one diode refuse the batch. Invalid UUIDs, roles, models,
addresses, or supplied physical fields refuse the batch before writes. UUID
case and compact/dashed representations normalize before aliases, membership,
or tombstones are compared. Native fit variants and exact physical diode
membership jointly determine compatible sizes.

API ascents, favorites, and projects stay separate from the shared catalogue.
They are not published or converted into user ticks here. Backdated uploads,
idempotency, and account-specific write authorization need the remaining vendor
contract; this implementation does not automatically upload old ticks.

Catalog routes can exceed Boardsesh's current activation cap. Import preserves
all their holds for browsing and logging; it never truncates a route to fit a BLE
packet. Explicit activation rejects an oversized route before any controller
command.

## Canonical data and shared sync

The importer writes the existing canonical board and climb tables transactionally.
One standard-family climb can carry several compatible size IDs. Controller route
UUID plus physical family determines a stable Boardsesh identity; existing climb
aliases preserve upstream route UUIDs.

Known climb rules go into `characteristics`, and canonical grade, ascent, and
rating fields use the existing stats system. Raw source fields that do not have
those semantics use nullable generic `board_climbs.source_metadata`; no attributed
user is fabricated to force anonymous tags into another table.

The durable catalogue checkpoint uses generic metadata on `board_shared_syncs`.
Its synchronization timestamp remains a timestamp; the separate server cursor
stays opaque. Checkpoints and route membership are scoped by the upstream
account, board name, and type. A stale batch cannot advance a checkpoint acquired
from a superseded base. Tombstones and scope replacement unlist a route only
after its final model membership is gone. Changing the configured catalogue
account or board fails closed until an explicit complete catalogue rebind.

Routine refresh uses the existing `quantum-catalog-sync` background-job family and
six-hour schedule. Lifecycle, retries, deadlines, and attempt fencing reuse the
shared worker infrastructure. Every import/checkpoint write belongs to the
current job transaction. Manual one-shot acquisition remains available through:

```sh
vp exec tsx packages/backend/src/cli/quantum-sync.ts once
```

The importer cannot overwrite a Boardsesh-authored climb or steal an existing
alias/controller identity. Conflict checks run before writes and remain guarded
at the database boundary so a concurrent insert cannot bypass them. A failed
import rolls back catalog and checkpoint changes together.
Published route UUIDs also bind their layout, controller identity, and holds.
An incompatible geometry change under the same UUID refuses the batch rather
than silently changing the meaning of an active controller layer.

API batches update only changed climb and stats rows. Missing source
routes are unlisted once; immutable existing hold rows are retained. An unchanged
route keeps its incremental-sync timestamp even when another route changes.
If a source route's angle changes or becomes unknown, obsolete upstream stats
are retired while local ascents, votes, grades, and historical rows are retained.
Generic size backfills preserve the source's explicit model membership. Physical
diode compatibility is inferred only for authored routes, so fitting a larger
wall cannot silently broaden a source route's allowlist.

Drizzle migration 0353 adds nullable controller-route and source metadata
columns, generic sync metadata, and the controller identity index. SQLite v16
adds nullable controller identity and source ownership columns for the released
v15 schema. It also installs the delivery journal for devices that ran the
Quantum preview's v15. Both upgrades preserve climbs and queued writes. Rebuild
board snapshots at artifact schema v16 so new clients can read both columns.

Before production migration, follow the concurrent-index prerequisite at the top
of migration 0353: add its nullable controller column, build the partial unique
index outside the migrator transaction, and verify `pg_index.indisvalid`. The
migration then skips that completed index. This avoids blocking climb writes
during a full `board_climbs` scan; fresh test/dev databases build it normally.
After the first bulk import into a seeded local database, refresh planner
statistics for `board_climbs`, `board_climb_holds`, and `board_climb_stats` if
query plans still estimate that Quantum rows are absent.

## Rendering and sharing

Permission includes the public catalogue snapshots. Eligible Quantum climbs use
the normal export path, including the controller identity needed to light a
downloaded climb. Public climb pages and Open Graph rendering are a separate
capability from downloading that catalogue.

The mobile and Expo browser builds bundle board artwork for XL, L, M, and
S Fitness from eWalls 2.6.5. Full boards use the cropped art at its source
resolution. Small previews use quarter-resolution copies with the same aspect.
The SVG renderer draws the existing role colours and accessibility shapes over
the image, and keeps the neutral diagram available if decoding fails.

Hold centres are optically registered against the artwork's visible hold
apertures. The measured affine fit is for rendering. S Fitness uses its own fit
and tall artwork aspect. Held-out wall anchors were within 2.2 source pixels.
Standard boards' kicker targets retain the shared transform. Their LED alignment
remains unverified. Setup, play, editor hit testing, and heatmaps use the same
crop and projected positions. See the [artwork provenance and calibration record](../../packages/mobile/src/components/quantum/board-art/README.md).
[#7919](https://github.com/boardsesh/boardsesh/issues/7919) tracks moving the
overlays onto the usual renderer/shader pipeline.

Public sharing remains capability-gated until server rendering supports the board.
[#7918](https://github.com/boardsesh/boardsesh/issues/7918) tracks public climb pages,
Open Graph images, and links. Issue-linked TODOs mark the temporary guards.

## Layer control and presence

Boardsesh currently understands four simultaneous colored layers and caps activation
at 92 distinct diode addresses. Each player controls one layer. These are current application limits; the
firmware's layer capacity and repeated-chunk behavior are unverified. The
provider and encoder reject oversized activation before any command. Commands
must fit one complete, mode-appropriate GATT write; frames are not silently
fragmented. Persistent binary `QB_` boards use writes with response and `QBB_`
boards use writes without response; both require separate roster confirmation.

Discovery prefers the actual `fff0` service over `ffe0` and probes `fff5` for
binary configuration. The older JSON protocol and unknown model types are
explicitly unsupported. Finite activation durations set the explicit-duration
flag; the board-default sentinel remains `ffff`. Scoped removal frames are 20
bytes. Android tries MTUs 512, 247, and 185 and still checks actual write capacity.
Whole notification values accept the documented reserved byte and trailers;
oversized rosters cannot be truncated or reinterpreted as embedded packets.

Lighting uses an explicit free color and a device-local player identity. Changing
color moves the same player. A solo climber has one local player. A shared session
has one player controlled by the phone that started it; other phones can queue
climbs and log ticks. Turns and reconnects do not create more players. Session
control does not transfer to a joining phone, including another phone signed in
to the same account. Replayable partner workout starts do not create a new driver
credential: their response does not establish which phone created the session.
An existing matching local credential remains usable on retry.

Native credentials stay in SecureStore across reconnects. On iOS they use
`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, so an encrypted backup cannot give another
phone the session's controller credential. Browser credentials remain memory-only;
losing that identity does not authorize taking over the old layer. Legacy identities
without proof that they belong to this phone cannot authorize cleanup.
No ordinary Quantum action clears the whole wall. Queue, presence,
reconnect and rendering updates do not arm an implicit layer writer.

The controller roster is read before mutation and confirmed afterward. A new
player activates without a preceding removal. Replacement confirms release of
the expected owned route before activating the next one. Every physical mutation
rechecks the current connection and operation eligibility, including after waits.
Malformed frames and oversized climbs fail before any command is submitted.
Replacement and removal protect other players and require the expected target ownership.
Native and browser adapters use physical-device ownership across transport
instances. Old attempts cannot disconnect a replacement, stop its scan, or cancel
its GATT transaction. Native reconnect also waits for an already-submitted
physical cancellation to settle. Controller credentials remain device-local.

Common control hooks expose availability, the actual press action, labels, and an
exact editor target. Editor actions retain saved/dirty/in-flight checks. Legacy
live preview, frame playback, handoff, and exact-wall rules stay behind the
corresponding control adapter.

Board-layer presence and overlap filtering are generic capabilities, initially
enabled for Quantum. Public reports contain sanitized display data and confirmed
placement evidence, never controller user credentials. App-authored route IDs can
survive edits, so current catalog frames do not prove which holds another phone
physically lit. Recovery preserves that uncertainty instead of guessing.

Missing, stale, malformed, or incomplete layer geometry makes occupancy unknown
and leaves climb results unfiltered. One policy applies before pagination, counts,
random selection, and heatmaps in online and offline search. Persisted filter-key
compatibility is retained while leaf props use generic occupied placements.

## Verification limits

Source validation and read-only mapping checks do not prove a production import
or physical controller acceptance. No production schema or catalog is changed by
these development checks. Before release, test exact model/LED mapping, multiple
phones, eWalls coexistence, ownership changes, reconnects, and cleanup on hardware.
Keep general rollout disabled until that evidence is recorded per model and
firmware. A passing fixture or bundle check is not physical controller acceptance.
