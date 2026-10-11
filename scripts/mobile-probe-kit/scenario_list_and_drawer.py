#!/usr/bin/env python3
"""The climb list and the play drawer, one measured run.

    scenario_list_and_drawer.py <run-name> [--cold]

Fresh launch, then four fixed phases on the Climbs tab:
  1. load      34 slow flicks down, slow enough for every page to arrive. Every row is new.
  2. opens     three climbs opened and closed after all that scrolling.
  3. fast up   ten hard flicks back up through rows already seen.
  4. fast down ten hard flicks down again, then one more open.

--cold empties the hold-overlay cache at launch, so every thumbnail has to be
rendered. Run cold for a comparison: a warm cache hides the render queue.

The same script on two builds is the comparison. Do not change the gestures
between them.
"""
import subprocess, sys, time, os
import ios
from runs import Marks, run_directory

name = sys.argv[1]
directory = run_directory(name)
if "--cold" in sys.argv:
    ios.push_marker("perf-probe-cold")
ios.launch()
time.sleep(9)
ios.prepare_session()
ios.require_foreground()

width, height = ios.screen_size()
middle = width / 2
marks = Marks()
# Fractions of the screen height. A flick has to start below the header and
# above the bottom bar: one that begins on either of them does not scroll.
WALK = (0.735, 0.285)
FAST_UP = (0.2725, 0.829)
FAST_DOWN = (0.735, 0.178)


def flick(count, path, duration_ms=110, pause=0.35):
    for _ in range(count):
        ios.swipe(middle, height * path[0], middle, height * path[1], duration_ms)
        time.sleep(pause)


def open_and_close(row_fraction):
    y = height * row_fraction
    marks.mark(f"tap-{row_fraction}")
    ios.tap(width * 0.385, y)
    time.sleep(3.0)
    ios.screenshot(os.path.join(directory, f"open-{row_fraction}.png"))
    ios.swipe(middle, height * 0.14, middle, height * 0.9, 180)  # swipe the player down
    time.sleep(1.6)


ios.screenshot(os.path.join(directory, "at-start.png"))
marks.mark("load-start")
flick(34, WALK, pause=0.9)
marks.mark("load-end")
time.sleep(3.0)
ios.screenshot(os.path.join(directory, "after-load.png"))
for row in (0.39, 0.53, 0.675):
    open_and_close(row)
marks.mark("up-start")
flick(10, FAST_UP, duration_ms=60, pause=0.2)
marks.mark("up-end")
time.sleep(2.0)
marks.mark("down-start")
flick(10, FAST_DOWN, duration_ms=60, pause=0.2)
marks.mark("down-end")
time.sleep(3.0)
ios.screenshot(os.path.join(directory, "after-down.png"))
open_and_close(0.53)
marks.mark("end")
marks.save(directory)
ios.pull_probes(directory)
subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "analyze.py"), directory, name], check=True)
