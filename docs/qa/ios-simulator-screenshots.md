# Ios screenshots

Use isolated view stories for deterministic captures:

```sh
vp run mobile:ios-shots -- --story climbs--populated --theme dark --shutdown
vp run mobile:ios-shots -- --story player--lit --shutdown
```

The story root loads presentation providers and injected fixture props. It does not start authentication, SQLite, sync, BLE or backend queries. Capture waits for layout and required assets. A missing story, render failure or readiness timeout fails the command.

`--story` accepts the IDs listed at `dev/stories`. `--theme` accepts `dark`, `light` or `system`; `--variant` accepts `liquidGlass`, `material` or `auto`. Use `navigate --story <id>` with an existing capture session, or `screenshot --story <id>` to save a still from it. `--shutdown` closes the capture device after the run.

Legacy `--to board-view`, `board-sheet`, `session-detail`, `logbook` and `progress` aliases now select their view stories. Raw `screenshot*` query commands are rejected. Ordinary `--to` application routes remain available for manual integration inspection and use real application state.

For complete store/help/CPP captures use `vp run mobile:screenshots -- --flow <flow>`. The main runner preserves established device, locale and filename recipes while selecting isolated stories. Run `--flow smoke` separately to exercise real screens against recorded backend responses.

Before app launch, iOS capture bounds `simctl boot` to 120 seconds and `simctl bootstatus -b` to 600 seconds. Capture uses fresh simulators whose first boot performs system setup; the release launch smoke's 180-second readiness budget produced three boot timeouts across iPhone and iPad capture attempts before app installation. The longer capture budget remains bounded and still requires a successful boot-status command. Either command failing stops the attempt. Each command logs its start, elapsed time and status, separating boot time from later installation and app readiness. Command arguments, budgets, output and exit status are saved under `SCREENSHOT_DEBUG_DIR/ios-boot-*` before failure propagates; without that variable, evidence goes under the system temporary directory's `boardsesh-ios-boot` folder. Command intent is written before execution so an externally canceled command remains identifiable.

The iOS story runner separately waits 120 seconds for a fresh `[stories] root ready` marker and allows up to three app relaunches before failing. A successful launch command alone is not readiness. With `SCREENSHOT_DEBUG_DIR` set, each failed launch preserves its launch result, native log, process state, failure screenshot and available crash reports in a separate `ios-native-*` directory before retry or simulator shutdown.

Story links open in portrait so iPad system-confirmation taps do not use rotated landscape accessibility coordinates. The runner tolerates an absent confirmation, retries a visible “Open in Boardsesh?” prompt at most three times, and asserts it disappeared. After confirmation it switches to the requested capture orientation. The dev story harness withholds the story canvas until window dimensions match that orientation, so the fresh story-ready marker still requires final-orientation content, assets and layout. A Stories index with the system prompt still visible indicates navigation failure, not missing board artwork. These checks require native validation; a successful Maestro tap alone does not prove navigation.

Production screenshot-driving hooks have been removed. Showcase and tutorial video recorders retain live integration behavior through dev-only transport injection and real application controls. Native Live Activity captures still use the actual system API through the isolated dev setup.

See [Mobile view stories](../mobile/mobile-stories.md), [recorded fixtures](mobile-screenshot-fixtures.md) and [the integration gate](mobile-e2e-gate.md).

## Recovering an evicted simulator app cache

For repeated Duo helper startup failures, `duo-startup-diagnostics.yml` is a main-only diagnostic dispatch with a full historical main `source_sha`. Its optional `runner` selects `xcode-27` (default) or `xcode-27-xlarge` for a controlled capacity comparison; the larger runner requires organization access and uses paid capacity. Both choices retain the same toolchain checks, helper, and 35-minute job limit. It runs that commit's unchanged boot and hinge build/install functions on a fresh Duo, with Xcode 27B52 / SDK 27.2 (24B8118). It does not start the app or capture/store pipeline. The diagnostic parent observes the child independently, so synchronous historical commands retain their own deadlines and failure decisions. Process snapshots contain executable names and PIDs, not arguments or environment values. It samples worker-owned simctl commands, newly appeared launchctl processes whose simulator UDID matches (ownership is checked privately; raw environment text is never retained), and SpringBoard PIDs identified by the helper log: one-second samples, five-second command bounds, at most two per PID and 24 overall. Marker timestamps mean observed-at, not exact native event time. The observer checks a 30-minute worker budget between bounded commands, followed by bounded shutdown; the job has a 35-minute outer ceiling; artifacts are retained even on failure. These diagnostics distinguish a blocked native command from a coordinator that never initializes; they do not convert cleanup failures into success. Constructor-marked SpringBoard and launchctl PIDs become candidates independently of global process discovery, using their first observed marker time. Before sampling, a targeted check requires the same executable, a process birth no later than that observation, and the owned simulator UDID; candidates expire after 120 seconds. A bounded direct-child query also discovers worker-owned simctl commands when global discovery fails. Discovery records preserve raw status, signal, timeout/error and elapsed duration, plus poll intervals, load averages and free memory; private ownership environments are never serialized.

The standard screenshot matrix now sends only the iPhone Duo to `xcode-27-xlarge`;
the other four devices, the Pro Max probe, and CPP captures remain on `xcode-27`.
The same historical hinge helper and toolchain succeeded on xlarge in run
`44068744445` after standard-runner diagnostics showed severe host pressure.
Chinese campaign `44497174438`, Duo job `135486652928`, reproduced cleanup
timeouts on the standard runner: both attempts reached `coordinator ready`,
then a 60-second `launchctl unsetenv` command timed out before any frames.
The second attempt's readback still showed `DYLD_INSERT_LIBRARIES` set.
Runner selection changes capacity; the helper, cleanup requirements, command
deadlines, capture retries, and screenshot validation remain unchanged.

If a capture retry fails at “Restore prebuilt simulator app,” retain the missing full cache key and the original application SHA. Do not rerun the campaign's `ios-build` job: GitHub reruns its dependent capture jobs too, including successful shards.

Dispatch `mobile-screenshot-cache-recovery.yml` from `main` with `source_sha` set to that full 40-character lowercase SHA and `expected_cache_key` set to the exact missing key. The workflow requires the commit to be an ancestor of `origin/main`, checks out both application and cache tooling from that commit, and requires the computed toolchain/native-input key to match before building or saving. It uses the existing simulator build and identity validation recipe and writes the cache in main's scope. It does not capture images, publish to a store, or delete caches. A different installed Xcode/SDK fails the key check; do not substitute a different key for an existing campaign.

After the recovery job succeeds, retry only the unsuccessful capture jobs in the original campaign. Keep its successful artifacts and frozen source. A cache created by a temporary branch cannot be restored by the original main run.

### Frozen d585 campaign recovery (November 2026)

`final-ios-screenshot-recovery.yml` is limited to campaign `43938833365` at
`d5855045ff8170e4e72f9f2edfd1a2d5d396390d`. Its original 220 reviewed PNGs are
artifact `14317567067`, ZIP SHA256
`84df9aaeccf8991c73781c777925b7b5332c5e822560432e92f1d803de19ba18`.
Only the eight German Duo images are missing. Standard-runner diagnostics showed
severe host pressure before helper installation; the identical historical helper
and toolchain succeeded on `xcode-27-xlarge` in run `44068744445`. Recovery changes
runner capacity, preserving original app, capture/framing tooling, fixtures,
cache identity, readiness gates and bounded retries.

1. Dispatch `phase=capture` on `main`, leaving `upload=false`. The existing exact
   simulator cache must be present; use the separate cache recovery workflow if
   it was evicted. The capture job retains original raw/framed artifacts plus
   `recovered-de-duo-d585` with source and per-image checksums.
2. Review all eight raw/framed images. Retain that successful run ID, immutable
   recovery artifact ID and SHA256 of its downloaded ZIP. No listing is changed
   by this phase.
3. Dispatch `phase=finalize`, `upload=true`, supplying those three reviewed
   identifiers. The verifier checks both runs' metadata, frozen source, ZIP
   checksums, safe paths and exact inventories; it preserves every original byte.
   All 228 PNGs must pass the historical dimension gate and absolute content floor.
   The recovery-specific transition check described below handles only the 40
   reviewed baseline-ratio differences.
4. Before upload, `recovered-complete-ios-d585` retains the complete tree and
   provenance manifest. Publication holds both `mobile-screenshots-ios` and `mobile-store-draft` writer
   locks, requires
   the approved editable/manual 2.7.1 version and valid build 8 **record IDs**, then
   invokes only the historical screenshots lane. The post-upload audit requires
   228 COMPLETE assets with matching locale, display slot, position, filename and
   MD5. Full pre/post audit comparison permits changes only to the default
   screenshot sets and audit timestamp; CPPs, listing text, build and review
   records must remain unchanged.

The workflow never publishes a baseline, changes a binary or listing text,
modifies CPPs, or submits review. `recovery-publication-evidence` retains audits
and the manifest even when publication or readback fails. A failed readback is
not success; inspect that evidence before considering further writes. This
workflow deliberately cannot recover other campaigns or substitute other images.

#### Reviewed October-to-November content transition

The October 30 baseline (`c080874f59b59f222c162e8936ad93f06019e73d`, run
`40985850650`) predates the isolated story layouts. The first recovery merge
omitted `presentation.json`, so the content gate compared framed PNG sizes with
baseline raw-capture sizes. Recovery now requires all 30 original presentation
sidecars, validates their exact image inventories and framed checksums, and copies
the authenticated bytes unchanged. Their checksums are retained in the complete
artifact manifest. This corrects 52 of the 92 reported failures.

The remaining 40 are reviewed changes in the pictured content: board-focused
player versus player/browser, unselected left panes in Home/Climbs, three fixture
rows versus six live rows, the dedicated wall sheet versus climb-list capsule,
and the darker reviewed physical Live Activity wallpaper. They are recorded in
`scripts/final-ios-content-transition.json` with exact current/baseline PNG
checksums, raw byte measurements and per-path reasons.

Only this recovery workflow uses `final-ios-content-transition.ts`. It loads the
original content classifier from the verified d585 checkout, requires the same
complete 228-image current and baseline inventories, and applies the unchanged
absolute floor first. It then requires **exactly** those 40 original ratio
failures, with both images and measurements matching their reviewed records.
Missing baselines, changed bytes, changed measurements, duplicate records, new
failures and floor failures stop publication. The general screenshot gate and
40% threshold are unchanged; no baseline is republished. These records cannot
approve a future capture or a different baseline.
