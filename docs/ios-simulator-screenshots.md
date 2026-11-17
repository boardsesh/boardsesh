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

See [Mobile view stories](mobile-stories.md), [recorded fixtures](mobile-screenshot-fixtures.md) and [the integration gate](mobile-e2e-gate.md).

## Recovering an evicted simulator app cache

For repeated Duo helper startup failures, `duo-startup-diagnostics.yml` is a main-only diagnostic dispatch with a full historical main `source_sha`. It runs that commit's unchanged boot and hinge build/install functions on a fresh Duo, with Xcode 27B52 / SDK 27.2 (24B8118). It does not start the app or capture/store pipeline. The diagnostic parent observes the child independently, so synchronous historical commands retain their own deadlines and failure decisions. Process snapshots contain executable names and PIDs, not arguments or environment values. It samples worker-owned simctl commands, newly appeared launchctl processes whose simulator UDID matches (ownership is checked privately; raw environment text is never retained), and SpringBoard PIDs identified by the helper log: one-second samples, five-second command bounds, at most two per PID and 24 overall. Marker timestamps mean observed-at, not exact native event time. The observer checks a 30-minute worker budget between bounded commands, followed by bounded shutdown; the job has a 35-minute outer ceiling; artifacts are retained even on failure. These diagnostics distinguish a blocked native command from a coordinator that never initializes; they do not convert cleanup failures into success.

If a capture retry fails at “Restore prebuilt simulator app,” retain the missing full cache key and the original application SHA. Do not rerun the campaign's `ios-build` job: GitHub reruns its dependent capture jobs too, including successful shards.

Dispatch `mobile-screenshot-cache-recovery.yml` from `main` with `source_sha` set to that full 40-character lowercase SHA and `expected_cache_key` set to the exact missing key. The workflow requires the commit to be an ancestor of `origin/main`, checks out both application and cache tooling from that commit, and requires the computed toolchain/native-input key to match before building or saving. It uses the existing simulator build and identity validation recipe and writes the cache in main's scope. It does not capture images, publish to a store, or delete caches. A different installed Xcode/SDK fails the key check; do not substitute a different key for an existing campaign.

After the recovery job succeeds, retry only the unsuccessful capture jobs in the original campaign. Keep its successful artifacts and frozen source. A cache created by a temporary branch cannot be restored by the original main run.
