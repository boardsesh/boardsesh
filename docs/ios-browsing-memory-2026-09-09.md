# iOS browsing memory investigation — 9 September 2026

This investigation uses the reviewed app at `c84dfacc8` with opt-in memory
instrumentation. It preserves readiness gates, app data, and cache limits. No
application retention defect has been established. Simulator observations do not
establish physical-device memory or performance budgets.

The delivery branch preserves newer changes on `main`, including #5334's list
thumbnail preservation. These captures describe the frozen reviewed source at
`c84dfacc8`; they do not measure that newer application behavior.

## Controlled setup

- Simulator: **Boardsesh Performance Comparison 2026-09-08**, iPhone 17 Pro,
  iOS 26.5, `EF3B3CC1-A130-4254-82A6-6ADCA7423106`.
- Source: dedicated `/private/tmp/boardsesh-memory-profile-baseline` checkout;
  Release executable with an embedded Hermes bundle. Instrumentation is enabled
  with `EXPO_PUBLIC_PROFILE_MEMORY=1` and startup readiness observation with
  `EXPO_PUBLIC_PROFILE_STARTUP=1`.
- Account: local seeded `test@boardsesh.com`; its actual backend user ID is checked
  against the manifest. Tokens are never exported by memory diagnostics.
- Board: The Pump Station, Tension layout 10, size 6, sets 12 and 13, at 40°.
  Actual runtime configuration and effective Aura rendering are checked.
- Workload: 400 unique, compatible climbs frozen from the production Drizzle
  search against the local catalogue, ordered by ascents descending. The first
  is **Masquerade**, the last **A Fine Line**. Frame hashes accompany UUIDs as
  source provenance; runtime observations check UUIDs and configuration, not
  the bytes of the currently loaded climb frames.
- Backend: the local seeded database and backend at `http://localhost:8198`.

The shared simulator lease covers installation, navigation, and captures. The
runner checks executable and bundle hashes, process start identity, runtime ID,
command identity, sequence, and checkpoint timestamps. No simulator erase,
application uninstall, keychain reset, or cache-policy adjustment is used.

## Measurement contract

List and carousel workloads use the production list, row recycler, activation
path, drawer, renderer, and prefetch components. Profile-only scalar commands
scroll to UUID-checked production list indexes; carousel browsing uses native
swipes. They do not inject substitute climb objects or fixture views.

Replay revisits the first twenty climbs. Expanding cycles introduce twenty
additional target climbs each time. Viewport overlap and prefetch observations
are exported separately, so twenty targets do not imply only twenty rendered
climbs. `renderKeys` includes cache hits and cancelled requests; it is not an
allocation count.

Each workload warms disk artifacts through normal rendering in a separate
process. The measured Release process then runs two warm-up cycles followed by
twenty measured cycles, sampling settled surface, after browsing, confirmed
background/cache-clear completion, and settled Home. Incomplete rendering,
missing visibility, overflow, stale observations, and process replacement reject
the capture. Idle controls replay a completed run's elapsed checkpoint schedule,
with a two-second tolerance for both checkpoint requests and sample completion.

Cache inventories include thumbnail/overlay PNGs, native SDImageCache files, and
Expo image assets. Comparisons check paths, sizes, and SHA256; raw timestamps are
retained but normal cache hits change them. Matching file hashes cannot establish
identical LRU ordering, decoded image state, or allocator state. A completed run
alone does not establish equivalence with another run's starting cache.

## Ownership capability

The first Instruments probe omitted the simulator target and could not locate
the app PID. It is a targeting failure, not an unavailable-tool conclusion.
With the explicit simulator target, Allocations attached but its ten-second
recording did not complete within thirty seconds. The owned recorder group was
stopped; the incomplete trace is retained and excluded from measurements.

`leaks --outputGraph` and `vmmap -summary` produced usable local artifacts.
An unrestricted live `heap --addresses=all` report exceeded the bounded output
limit and reported restricted process contents. Reading a bounded heap summary
from the saved memory graph succeeded instead.

The initial, unauthenticated pre-browse capability graph contained 331,952 malloc nodes and
77,989,754 allocated bytes; `leaks` reported zero unreachable leaks. This single
Home observation is setup evidence only, excluded from authenticated comparisons,
and does **not** establish absence of browsing retention. Comparing
surviving objects and inspecting their reference chains remains necessary before
attributing growth to an application owner. Allocation stack logging and Hermes
inspection are separate supplemental capabilities, not prerequisites silently
assumed to exist in an ordinary Release process.

## Completed ordinary measurements

The list replay completed all 88 checkpoints in one measured Release process
over 28.29 minutes. Its two warm-up cycles are excluded from the distributions
below. Idle and expanding/carousel comparisons are still pending.

| List replay checkpoint | Minimum MiB | Median MiB | p95 MiB | Maximum MiB |
| --- | ---: | ---: | ---: | ---: |
| Settled list | 270.2 | 291.6 | 294.6 | 295.9 |
| After browsing | 270.2 | 291.6 | 294.3 | 295.8 |
| Confirmed background | 266.8 | 288.2 | 291.0 | 292.5 |
| Settled Home | 271.3 | 292.3 | 294.5 | 295.5 |

Home rose from 271.3 MiB in measured cycle one to 294.2 MiB in cycle twenty
(+22.9 MiB). The first warm-up Home reading was 260.4 MiB. Replaying twenty
targets observed the same 27 distinct visible UUIDs, 30 mounted/prefetched UUIDs,
and 36 render keys including other Home art. The overlay index stayed at its
existing 200-entry limit. Measured foreground checkpoints reported 19 image
surfaces and 66 image layers; all background checkpoints reported zero. Pending
renders and cache clears were zero at every accepted checkpoint.

All 416 starting cache files (8,424,031 bytes) retained identical paths, sizes,
and hashes through cycle twenty. This excludes disk-cache population growth as
an explanation for this particular sequence; it does not attribute its footprint
growth to an application owner. The matched idle control and graph comparison
are required before further interpretation.

The [individual samples](ios-browsing-memory-2026-09-09/list-replay.samples.csv)
include warm-ups, phase timing, run identity, UUID cardinalities, and counters.
The [formatted manifest](ios-browsing-memory-2026-09-09/climbs-manifest.json) records
all 400 targets and catalogue hashes. [Provenance](ios-browsing-memory-2026-09-09/provenance.json)
includes the original manifest's byte hash, source hashes, and executable identity.

## Implementation verification

The delivery branch is based on `main` at `fcab9e144`. Repository typechecking,
lint, 9,378 mobile tests in 866 files, forty focused runner tests, and iOS/Android
and browser Metro bundle checks pass on that branch, including browser shell
and WASM assets.
The frozen instrumented capture build separately passed simulator startup smoke
and screenshot checks before measurement. No BLE code was changed.

## Rejected setup attempts

- The initial local build stopped because Sentry source-map upload required
  authentication. Local profiling was rebuilt with uploads disabled.
- The first two replay attempts rejected an absent authenticated account before
  measurement. The saved session used a different local backend signing key.
  The same fixture account was reauthenticated through the existing native
  credentials function in a temporary verified Debug shell, then the exact
  instrumented Release executable was restored. App data and other keychain
  entries were preserved; the temporary Metro was stopped before measurement.

## Evidence

Local raw evidence is retained under `.boardsesh/memory-profile-2026-09-09/`:
source and generated-input hashes, native fingerprint, build logs, executable
identities, frozen manifest, individual snapshots and samples, validity verdicts,
memory graphs, bounded tool reports, and screenshots. Invalid attempts remain in
separate directories. See [the profiling guide](ios-profiling.md) for the reusable
runner and capture contract.
