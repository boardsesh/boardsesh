# QuantumBoard support

Boardsesh treats QuantumBoard as one fixed five-model catalog, backed by a
signed snapshot and an explicit four-layer BLE controller. This document covers
the trust boundary, canonical database ownership, mobile geometry hydration, and
production runbook.

## Architecture

```text
Pinned Nostr signer        HTTPS / Blossom mirrors
        |                            |
        +-- signed manifest + hash --+
                         |
              @boardsesh/quantum-sync
        strict event, manifest, blob, and SQLite validation
                         |
             transactional backend importer
                         |
             canonical board_* PostgreSQL rows
                 |                    |
       catalog/search queries    Quantum geometry GraphQL
                                      |
                         memory registry + SQLite cache
                                      |
                        render, create, and explicit BLE
                                      |
                     sanitized board-layer presence
```

`@boardsesh/quantum-sync` is pure acquisition and validation code. The backend
runtime owns BIP-340 signature verification, database leases, transactional
imports, and checkpointing. Mobile consumes only canonical GraphQL data; it
does not fetch or interpret the source snapshot.

## Fixed model identity

QuantumBoard uses Boardsesh product `91`, set `1`, and these exact pairs:

| Source model | Display name | `forced_type` | Layout | Product size | Grid  |
| ------------ | ------------ | ------------- | ------ | ------------ | ----- |
| `xl`         | XL           | `big`         | 9101   | 9201         | 15x15 |
| `l`          | L            | `medium`      | 9102   | 9202         | 15x12 |
| `m`          | M            | `small`       | 9103   | 9203         | 12x12 |
| `s`          | S Fitness    | `xsmall`      | 9104   | 9204         | 8x12  |
| `belay`      | Belay Board  | `belay`       | 9105   | 9205         | 8x12  |

The snapshot must contain all five models once, with exactly these IDs,
dimensions, and controller types. No other layout/size combination is valid.
Source placement IDs are model-local, so canonical hole, placement, LED, and
hold IDs use:

```text
(layoutId - 9100) * 1,000,000 + sourcePlacementId
```

LED `position` remains the source `autocad_id`. Geometry coordinates and edges
use `Math.trunc(sourceCoordinate * 1000)`, including truncation toward zero for
negative values.

## Signed snapshot trust

The trust anchors are code constants, not environment configuration:

| Field             | Required value                                                        |
| ----------------- | --------------------------------------------------------------------- |
| Nostr event kind  | `30078`                                                               |
| Signer public key | `70b2740bff77cf65743a7d6ffa5465b3a27105ae26123458cf5450eafb1bd68d`  |
| `d` tag           | `cruxcoach/quantum-db`                                                |
| Manifest source   | `ewalls-authorized-snapshot`                                         |

> `ewalls-authorized-snapshot` is a source label and self-declaration made by
> the pinned signer. It is **not** independent proof that eWalls, QuantumBoard,
> or another manufacturer authorized the snapshot. The signature proves
> continuity with the pinned key and protects integrity; it does not prove the
> legal or organizational claim expressed by the label.

The importer recomputes the Nostr event ID and verifies its BIP-340 Schnorr
signature with `@noble/curves`. It then requires the exact kind, signer, single
`d` tag, source, timestamp, manifest schema, one zstd chunk, HTTPS mirror URLs,
declared size, and SHA-256. Blossom is only a blob transport: mirror possession
does not grant trust without the pinned signed manifest and matching bytes.
Decompression is bounded, and the resulting SQLite file must pass the exact
schema, type, uniqueness, row-count, UUID, relation, and model validations.
Any malformed or ambiguous input rejects the whole snapshot.

The signed catalog published on 2026-08-30 measured 123,603 rows and 9,031,244
UTF-8 bytes across selected string columns. Validation uses these hard row caps:

| Table                  | Measured rows | Hard cap  | Headroom |
| ---------------------- | ------------: | --------: | -------: |
| `quantum_models`       |             5 |         5 |    fixed |
| `quantum_diodes`       |         3,154 |     5,000 |     1.6x |
| `quantum_routes`       |         5,988 |    25,000 |     4.2x |
| `quantum_route_models` |         8,626 |    40,000 |     4.6x |
| `quantum_route_lights` |       105,830 |   350,000 |     3.3x |

The whole snapshot is also capped at 400,000 rows (3.2x measured) and 48 MiB
of source strings (5.6x measured). Callers may lower these validation limits
for tests or constrained runtimes, but cannot raise the hard ceilings.

Compressed and decompressed artifacts stream through private mode-`0600` temp
files and are removed after validation, including failure paths. The production
path does not retain duplicate artifact-sized buffers beside normalized rows.

Anti-rollback runs inside the same database transaction as the import, after a
transaction-scoped advisory lock is acquired. The checkpoint ordering is:

1. Higher signed `manifestCreatedAt` wins.
2. At an equal timestamp, the lexicographically higher deterministic event ID wins.
3. The same event is an unchanged no-op; older events are rejected.
4. A changed hardware fingerprint is rejected until an explicit reviewed
   contract/checkpoint transition is shipped.

This prevents an incomplete relay response from replaying an older valid
snapshot and delisting newer climbs. `board_catalog_sync_state` retains the
latest attempt, success, failure, manifest event/time/hash, and hardware
fingerprint. A failed cycle never erases the last successful checkpoint.

## Canonical import and ownership

One successful transaction upserts the Quantum product, set, Boulder grade
rows, five layouts/sizes/associations, roles, hardware geometry, climbs, holds,
metadata, and per-angle stats into the ordinary `board_*` tables. Important
translations are:

- Source light step `1` is start role `12`; step `3` is finish role `14`; every
  other valid integer is hand role `13`.
- `board_climbs.uuid` is source `app_uuid`; `controller_route_uuid` is source
  route `uuid`. Both must be canonical UUIDs.
- Each climb has one exact frame. Its spatial edges are the min/max coordinates
  of that route's lit diodes, not the model's full product edges.
- Ratings and ascent totals write canonical per-angle stats. Source flags,
  positive characteristics, tags, and grade provenance write
  `quantum_climb_metadata`; malformed or unknown grades remain ungraded.

The signed snapshot is complete, so a successful import first delists every
source-owned Quantum climb, then relists the rows present in that snapshot.
Source-owned means `board_type = 'quantum'`, `user_id IS NULL`, and a non-null
`controller_route_uuid`. Missing routes are never deleted. User-created climbs
have a user ID and are never reconciled or delisted by the importer; their
stable lowercase UUIDv4 `controller_route_uuid` is generated when the climb is
created so the same BLE activation path can light them. A source `app_uuid`
collision with a foreign or user-owned climb rejects the import.

## Geometry hydration and cache

The backend serves `quantumGeometry`/`quantumGeometries` only for an exact model
pair backed by a successful checkpoint with the fixed source label. It joins
canonical sizes, associations, holes, placements, and LEDs. Missing edges,
associations, placements, or LED positions return no geometry rather than a
guessed grid.

Mobile hydrates every model from its local SQLite cache first and then refreshes
from GraphQL, with a six-hour query stale time. Registrations revalidate the
exact model pair, integer edges and coordinates, renderability, and 16-bit LED
positions. A network failure leaves the last known-good cache available, while
a model omitted from an authoritative response is unregistered and deleted
from SQLite so it cannot return after an offline restart. Board discovery stays
gated until all five models are available, so rendering, climb creation, and
BLE never fall back to row-major or inferred geometry. The signed event/hash
becomes the cache revision.

`QuantumGeometryHydrator` renders nothing and does not provide React context.
It runs inside the existing query and database providers, then registers each
validated model in the synchronous external geometry store. Consumers subscribe
to only the model they use, so loading geometry does not rebuild the root
provider tree.

### Rendering surface

Quantum uses the Expo app's runtime geometry renderer. The legacy Next.js
climb routes and synchronous WASM/photo renderer cannot load signed geometry,
so they reject Quantum before rendering instead of treating it as an Aurora
board. Quantum list and climb URLs are therefore excluded from the www sitemap,
and the mobile share action stays hidden until a runtime-geometry public view
exists. Browse, create, queue, tick, and wall control remain available in the
Expo app.

## Four-layer BLE safety

The controller exposes at most four active layers and 92 diodes per layer.
Boardsesh binds four local controller user UUIDs—install-local on native and
page-local on web—to fixed green, cyan, magenta, and yellow slots. A climber must
open the Quantum control sheet and tap one layer to light, replace, or remove it.
Queue navigation, swipes, connection, and current-climb changes never activate a
route. Clearing the wall requires a second confirmation.

Activation sends the climb's canonical `controller_route_uuid`, authoritative
geometry-derived diode IDs, the selected layer's controller UUID, and its color.
The protocol has no separate route-create/upsert operation; app-authored climbs
work because creation persists a stable controller route UUID before any BLE
action. Mutations read the controller roster back and publish only confirmed
state. Foreign players still reserve their physical slot and color and are never
adopted as one of Boardsesh's local layers.

### Privacy boundary

Controller user UUIDs are physical-wall credentials, not Boardsesh account or
party identities. Native stores them in Keychain/Keystore. Expo web keeps them
only in memory for the lifetime of the loaded page and rotates them after a
reload; it never writes them to IndexedDB, local storage, or another browser
persistence layer. They never enter GraphQL, Redis, subscriptions, or analytics.

Raw controller roster route UUIDs are resolved locally to known climb UUIDs and
then removed from the presence report. Presence contains only color, remaining
seconds, resolved climb UUID/angle, and `geometryKnown`; an unresolved foreign
route remains as a layer with null climb metadata. The backend verifies the
climb belongs to the bound Quantum layout and derives placement IDs from the
canonical frame. It never trusts client-supplied placements.

### Overlap filters fail open

Browse filters support off, no shared holds, or at most one shared hold. They
compare a candidate's canonical placement IDs with the sanitized, server-derived
active-layer placements. If presence is missing or stale, a route is foreign,
or any layer geometry is incomplete or malformed, occupancy becomes unknown.
The mobile client disables/removes the overlap constraint and the shared matcher
accepts every candidate. Uncertain presence therefore never hides climbs and
never triggers a BLE action.

## Sync operation

Run the CLI from the repository root:

```bash
# Acquire, validate, and import one snapshot.
bunx tsx packages/backend/src/cli/quantum-sync.ts once

# Run once immediately, then every 360 minutes.
bunx tsx packages/backend/src/cli/quantum-sync.ts daemon
```

Production uses the shared sync image from `Dockerfile.sync`; generate its
context with `vp run docker-context:sync`. The daemon uses the standard database
lease so only one instance runs a cycle, while the transaction advisory lock is
the final writer fence. A failed cycle is recorded and the daemon waits for the
next scheduled run without changing the last good catalog.

Only relay discovery and resource limits are configurable:

| Environment variable                    | Default                                  |
| --------------------------------------- | ---------------------------------------- |
| `QUANTUM_SYNC_RELAYS`                   | Six built-in credential-free WSS relays |
| `QUANTUM_SYNC_MAX_MANIFEST_BYTES`       | `65536`                                  |
| `QUANTUM_SYNC_MAX_EVENTS_PER_RELAY`     | `4`                                      |
| `QUANTUM_SYNC_MAX_COMPRESSED_BYTES`     | `67108864`                               |
| `QUANTUM_SYNC_MAX_DECOMPRESSED_BYTES`   | `268435456`                              |
| `QUANTUM_SYNC_MAX_MIRROR_URLS`          | `8`                                      |
| `QUANTUM_SYNC_MAX_FUTURE_EVENT_SECONDS` | `300`                                    |
| `QUANTUM_SYNC_RELAY_TIMEOUT_MS`         | `10000`                                  |
| `QUANTUM_SYNC_MIRROR_TIMEOUT_MS`        | `60000`                                  |

`QUANTUM_SYNC_RELAYS` is a comma-separated list of 1-32 credential-free `wss:`
URLs. Its default is
`wss://relay.primal.net,wss://relay.damus.io,wss://relay.wellorder.net,wss://nos.lol,wss://relay.oxtr.dev,wss://blossom.cruxcoach.org/nostr`.
Limit values must be positive safe integers, and the decompressed cap cannot be
smaller than the compressed cap. Pre-signature relay retention has additional
hard ceilings of 65,536 manifest bytes and eight events per relay. The mirror
timeout is a whole-attempt deadline covering DNS, connection setup, redirects,
headers, and body transfer. Standard backend database variables such as
`DATABASE_URL` still apply. There are
deliberately no signer, event-kind, `d`-tag, source, or daemon-period environment
overrides.

## Validation and incident runbook

Run the relevant checks from the repository root. Tests use synthetic fixtures;
they do not download a live catalog.

```bash
vp run typecheck:quantum-sync
vp run typecheck:backend
vp test run --project quantum-sync --reporter=agent
vp test run --project backend \
  packages/backend/src/services/quantum-catalog-mapping.test.ts \
  packages/backend/src/services/quantum-catalog-sync.test.ts \
  packages/backend/src/services/quantum-catalog-import.test.ts \
  --reporter=agent
vp run typecheck:mobile
vp run test:mobile
vp run check:mobile-bundle
vp run docker-context:sync
```

For an operational failure:

1. Inspect the `quantum` / `ewalls-authorized-snapshot` row in
   `board_catalog_sync_state`; compare `last_attempt_at`, `last_success_at`, and
   `last_error` before retrying `once`.
2. For relay, mirror, timeout, or size errors, fix only the operational relay or
   limit setting and rerun once. The last good catalog remains usable.
3. For signature, manifest, hash, SQLite, UUID, or relation errors, quarantine
   the input. Do not bypass validation or import the blob manually.
4. For rollback or hardware-fingerprint drift, do not clear the checkpoint.
   Confirm the publisher/change out of band and use a reviewed migration or
   contract change that deliberately advances the pinned hardware checkpoint.
5. Verify the success timestamp/event ID advances, all five geometries resolve,
   and a controller activation appears only after an explicit layer tap.

Any future change under the shared or mobile BLE paths requires the repository's
Fable review before merge.
