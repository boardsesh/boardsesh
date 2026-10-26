# Mobile probe kit

Scripts for measuring what a climber sees and waits for on a real phone: thumbnails that appear before their holds, how long a page of climbs takes, how the play drawer opens, what a swipe between climbs shows and whether it lands, how the drawer closes, what the app does while it launches.

The method, the meaning of every number, the traps, and the Android plan are in [`docs/mobile-visible-performance.md`](../../docs/mobile-visible-performance.md). Read that first.

The capture and analysis tools run locally; compact injector fixtures run in the `scripts` test project. Injected sources are for measurement builds only. Python 3, standard library only; `scenario_film.py` also needs ImageMagick.

| File | What it is |
| --- | --- |
| `probe/perf-probe.ts.template` | The module the probe build adds to the app: events, the stall monitor, marker files |
| `probe/apply_probes.py` | Stages standard probes after validating every anchor. `--settle-consent` |
| `probe/apply_opening_probes.py` | Adds opening-readiness probes after the standard stage |
| `probe/apply_launch_markers.py` | Adds launch attribution on top |
| `probe/apply_swipe_probes.py` | Adds the play drawer's swipe and pull-down probes, and the five-climb-queue marker |
| `probe/apply_schema_hold.py` | Keeps a probe build from migrating the phone's offline database |
| `schema_check.py` | The phone's offline database version against the checkout's. Run it before a build |
| `build_ios.sh` | Probes in, Release build, install on the phone, tree put back |
| `ios.py` | The iPhone: gestures through a WebDriverAgent runner, launch and files through `devicectl` |
| `scenario_list_and_drawer.py` | The climb list and the play drawer |
| `scenario_search_pages.py` | Wait per page of climbs |
| `scenario_launch.py` | A cold launch. Needs no UI driver |
| `scenario_film.py` | Hard flicks, filmed, as contact sheets |
| `scenario_play_swipe.py` | Swiping between climbs at four paces, and three kinds of pull-down close |
| `scenario_film_swipe.py` | Thumb-pace swipes, filmed, as a contact sheet |
| `analyze.py` | Summary of a list run |
| `analyze_swipe.py` | Summary of a swipe run, and `swipe-summary.json` for adding runs up |
| `hitches.py` | Places the hitches in an Instruments Animation Hitches trace against a swipe run |
| `launch_timeline.py` | Timeline of a launch, or one line per launch |

```sh
export BOARDSESH_PROBE_UDID=<udid>            # xcrun devicectl list devices
scripts/mobile-probe-kit/build_ios.sh /tmp/probe-build.log --settle-consent \
  scripts/mobile-probe-kit/probe/apply_launch_markers.py
python3 scripts/mobile-probe-kit/scenario_launch.py baseline-1
python3 scripts/mobile-probe-kit/scenario_list_and_drawer.py baseline-list-1 --cold   # needs the UI driver
```

For the swipe scenario, check the schema first and add the swipe probes (and the hold, when the check says the versions differ):

```sh
python3 scripts/mobile-probe-kit/schema_check.py
scripts/mobile-probe-kit/build_ios.sh /tmp/probe-build.log --settle-consent \
  scripts/mobile-probe-kit/probe/apply_launch_markers.py scripts/mobile-probe-kit/probe/apply_swipe_probes.py \
  scripts/mobile-probe-kit/probe/apply_schema_hold.py
python3 scripts/mobile-probe-kit/scenario_play_swipe.py baseline-swipe-1               # needs the UI driver
```

Runs are written to `.boardsesh/probe-runs/<name>/`, which git ignores. Set `BOARDSESH_PROBE_RUNS` to put them elsewhere.

## Supported injector revisions

The standard and opening injectors support the `8b842c4950` baseline, the
`635753d563` PlayCore candidate, and current source families pinned at
`329e73f824` and `cb0f82386b`. Current offline requests may return null locally
and pass an abort signal to the network. Current activation uses one privacy or
credential-generation rejection guard; the historical candidate retains three
loaded-snapshot guards. See the [source-family table](../../docs/mobile-visible-performance.md#opening-a-climb-after-deep-scrolling).

Both scripts finish validating replacements before writing. Missing, duplicated,
mixed, or already-instrumented anchors fail without additional writes. Apply only
to isolated clean checkouts and retain the source revision and script hashes.

Run the focused CI fixtures with:

```sh
vp test run --project scripts scripts/mobile-probe-kit/probe/__tests__/injectors.test.ts --reporter=agent
```
