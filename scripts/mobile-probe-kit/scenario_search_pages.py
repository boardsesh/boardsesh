#!/usr/bin/env python3
"""How long each page of the climb list takes to arrive while scrolling.

    scenario_search_pages.py <run-name> <flicks> [marker-file ...]

Fresh launch, then <flicks> steady flicks down the Climbs tab, then the probes.
Prints every page's wait as the list saw it (`search-page`) and, on a downloaded
board, the time inside the on-device query (`offline-request`, lane `local`).

Marker files are pushed before the launch. That is how one build is compared
with itself: the probe build reads a marker at startup and switches a code path
off for that launch only.
"""
import os, statistics, sys, time
import ios
from runs import run_directory

name, flicks = sys.argv[1], int(sys.argv[2])
directory = run_directory(name)
for marker in sys.argv[3:]:
    ios.push_marker(marker)
launched_at = ios.launch()
time.sleep(9)
ios.prepare_session()
ios.require_foreground()
width, height = ios.screen_size()
ios.screenshot(os.path.join(directory, "start.png"))
for _ in range(flicks):
    ios.swipe(width / 2, height * 0.71, width / 2, height * 0.26, 110)
    time.sleep(0.55)
time.sleep(4)
ios.screenshot(os.path.join(directory, "end.png"))
events = ios.pull_probes(directory)

launch_ms = int(launched_at * 1000)
pages = [event for event in events if event["name"] == "search-page"]
for event in pages:
    print(f"  {(event['wallMs'] - launch_ms) / 1000:6.1f}s page {event['page']:3d}: {event['fetchMs']:6d} ms, {event['climbCount']} climbs")
if pages:
    waits = [event["fetchMs"] for event in pages]
    print(f"page wait: n={len(waits)} median={statistics.median(waits)} ms min={min(waits)} max={max(waits)}")
local = [event["ms"] for event in events if event["name"] == "offline-request" and event.get("lane") == "local" and event.get("surface") == "search"]
network = [event["ms"] for event in events if event["name"] == "offline-request" and event.get("lane") == "network" and event.get("surface") == "search"]
if local:
    print(f"on-device query: n={len(local)} median={statistics.median(local)} ms max={max(local)} ms")
if network:
    print(f"network query: n={len(network)} median={statistics.median(network)} ms max={max(network)} ms  <- the board is not downloaded; say so next to any number")
