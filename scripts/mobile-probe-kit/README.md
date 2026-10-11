# Mobile probe kit

Scripts for measuring what a climber sees and waits for on a real phone: thumbnails that appear before their holds, how long a page of climbs takes, how the play drawer opens, what the app does while it launches.

The method, the meaning of every number, the traps, and the Android plan are in [`docs/mobile-visible-performance.md`](../../docs/mobile-visible-performance.md). Read that first.

These are local tools. Nothing here runs in CI or ships in the app. Python 3, standard library only; `scenario_film.py` also needs ImageMagick.

| File | What it is |
| --- | --- |
| `probe/perf-probe.ts.template` | The module the probe build adds to the app: events, the stall monitor, marker files |
| `probe/apply_probes.py` | Adds the probes to a checkout. `--settle-consent`, `--keep-offline-boards` |
| `probe/apply_launch_markers.py` | Adds launch attribution on top |
| `build_ios.sh` | Probes in, Release build, install on the phone, tree put back |
| `ios.py` | The iPhone: gestures through a WebDriverAgent runner, launch and files through `devicectl` |
| `scenario_list_and_drawer.py` | The climb list and the play drawer |
| `scenario_search_pages.py` | Wait per page of climbs |
| `scenario_launch.py` | A cold launch. Needs no UI driver |
| `scenario_film.py` | Hard flicks, filmed, as contact sheets |
| `analyze.py` | Summary of a list run |
| `launch_timeline.py` | Timeline of a launch, or one line per launch |

```sh
export BOARDSESH_PROBE_UDID=<udid>            # xcrun devicectl list devices
scripts/mobile-probe-kit/build_ios.sh /tmp/probe-build.log --settle-consent --keep-offline-boards \
  scripts/mobile-probe-kit/probe/apply_launch_markers.py
python3 scripts/mobile-probe-kit/scenario_launch.py baseline-1
python3 scripts/mobile-probe-kit/scenario_list_and_drawer.py baseline-list-1 --cold   # needs the UI driver
```

Runs are written to `.boardsesh/probe-runs/<name>/`, which git ignores. Set `BOARDSESH_PROBE_RUNS` to put them elsewhere.
