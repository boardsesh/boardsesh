# Quantum Board support

Quantum uses the same board, climb, hold, grade, and sync contracts as the other
boards. Provider-specific acquisition, physical identity checks, drawing, and
Bluetooth commands live behind adapters.

The catalog snapshot is a temporary read-only bootstrap. Direct two-way eWalls
integration is tracked in [#7921](https://github.com/boardsesh/boardsesh/issues/7921)
under the [Quantum support epic](https://github.com/boardsesh/boardsesh/issues/7917).
Do not treat CruxCoach infrastructure as the long-term vendor API.

## Board identity and immutable geometry

| Controller model | Product | Layout | Size | Source controller type |
| --- | ---: | ---: | ---: | --- |
| XL | 91 | 9101 | 9201 | `big` |
| L | 91 | 9101 | 9202 | `medium` |
| M | 91 | 9101 | 9203 | `small` |
| S Fitness | 94 | 9104 | 9204 | `xsmall` |
| Belay | 95 | 9105 | 9205 | `belay` |

XL/L/M share a physical layout, with different size membership and bounds.
[Walltopia documents the shared layout](https://walltopia.com/products/quantum-board/).
The captured source confirms every L and M diode matches XL by identity, LED
address, position, and hold type. Fitness is a separate layout. Belay is a fixed
repeated XL arrangement with separate controller identities; it is not assumed
to have mutable geometry.

The version-one snapshot uses legacy model-local layout IDs 9102 and 9103 for L
and M. The source adapter validates those raw identities before normalizing them
to layout 9101. Callers do not interpret that source encoding.

Physical hold maps and per-size LED membership ship as generated board constants,
following the existing generated catalog pattern. The source and provenance are
recorded in [quantum-board-geometry](quantum-board-geometry/README.md). The
source contains 3,154 model-specific diode rows; shared standard-family holds
have one canonical placement identity. Runtime catalog imports must match the
bundled physical fingerprint, including on the first import. A geometry correction
requires a reviewed source/generator update and a new compatible application
bundle, rather than silently accepting different LED addresses.

Mobile does not fetch a geometry API, hydrate a geometry registry, or store a
separate geometry table in SQLite. Generic rendering and editor accessors return
the same dimensions and hold-target shape for bundled boards. Personal spray-wall
geometry keeps its existing runtime subscription behind the same adapter boundary.
The angle-options source is separate from geometry: the temporary Quantum angle
query describes angles present in the catalog, not a verified hardware range.

## Catalog acquisition and trust

The temporary transport discovers a Nostr event, verifies its BIP-340 signature
against the pinned publisher, validates the manifest, and downloads the referenced
SQLite snapshot through HTTPS/Blossom mirrors. The manifest SHA-256 and byte limits
apply before schema and row validation. Decompression is bounded and temporary
files are private and cleaned up on success, cancellation, or failure.

The signer, event kind, manifest source, and `cruxcoach/quantum-db` tag are code
constants. The source label `ewalls-authorized-snapshot` is the publisher's
self-declaration. Its signature proves continuity with that publisher and data
integrity, not independent authorization from Walltopia or eWalls.

Validation rejects malformed UUIDs, ambiguous schema, duplicate mappings,
unknown model/diode references, invalid coordinates or roles, and aggregate
resource-limit violations. L/M sharing is validated before a common layout is
exposed. The bundled geometry fingerprint is a separate fixed contract from the
catalog's signed publication revision.

Catalog routes can exceed Boardsesh's current activation cap. Import preserves
all their holds for browsing and logging; it never truncates a route to fit a BLE
packet. Explicit activation rejects an oversized route before any controller
command.

## Canonical data and shared sync

The importer writes the existing canonical board and climb tables transactionally.
One standard-family climb can carry several compatible size IDs. Controller route
UUID plus physical family determines a stable Boardsesh identity; existing climb
aliases preserve the snapshot's model-specific app UUIDs.

Known climb rules go into `characteristics`, and canonical grade, ascent, and
rating fields use the existing stats system. Raw source fields that do not have
those semantics use nullable generic `board_climbs.source_metadata`; no attributed
user is fabricated to force anonymous tags into another table.

The durable catalog checkpoint uses generic metadata on `board_shared_syncs`.
Its synchronization timestamp remains a timestamp. The signed temporary source
retains its real publication ordering; a content hash is not claimed to establish
chronology for a future unsigned vendor API.

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

New signed revisions update only changed climb and stats rows. Missing source
routes are unlisted once; immutable existing hold rows are retained. An unchanged
route keeps its incremental-sync timestamp even when another route changes.
Generic size backfills preserve the source's explicit model membership. Physical
diode compatibility is inferred only for authored routes, so fitting a larger
wall cannot silently broaden a source route's allowlist.

Migration 0331 is generated by Drizzle. It adds nullable controller-route/source
metadata columns, generic sync metadata, and the controller identity index. It
creates no Quantum-specific storage tables. Offline migration 15 appends nullable
controller identity and source-ownership marker columns; shipped migrations are
unchanged. The unused unshipped geometry-table migration was removed.

Before production migration, follow the concurrent-index prerequisite at the top
of migration 0331: add its nullable controller column, build the partial unique
index outside the migrator transaction, and verify `pg_index.indisvalid`. The
migration then skips that completed index. This avoids blocking climb writes
during a full `board_climbs` scan; fresh test/dev databases build it normally.

## Rendering and sharing

Full boards, list thumbnails, and prewarming use one renderer-selection policy.
The current Quantum drawing adapter uses SVG for its fixed diode/hold data;
[#7919](https://github.com/boardsesh/boardsesh/issues/7919) tracks moving that input
onto the usual renderer/shader pipeline. Leaf components do not choose a renderer
by board name.

Public sharing remains capability-gated until server rendering supports the board.
[#7918](https://github.com/boardsesh/boardsesh/issues/7918) tracks public climb pages,
Open Graph images, and links. Issue-linked TODOs mark the temporary guards.

## Layer control and presence

Boardsesh currently supports four simultaneous colored layers and caps activation
at 92 distinct diode addresses. The 92-light cap is an application limit, not a
verified manufacturer maximum. The provider and encoder both reject oversized
activation before commands are issued. Commands must fit one acknowledged write;
frames are not silently fragmented.

Current lighting uses an explicit layer choice. The familiar driving flow with
one selected free color and a color indicator follows in
[#7916](https://github.com/boardsesh/boardsesh/issues/7916). Queue, presence,
reconnect, and rendering updates do not arm an implicit layer writer.

The controller roster is read before mutation and confirmed afterward. Replacement
and removal protect other players and require the expected target ownership.
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
