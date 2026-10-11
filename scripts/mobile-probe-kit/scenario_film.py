#!/usr/bin/env python3
"""Film hard flicks through loaded rows and lay the frames out as contact sheets.

    scenario_film.py <run-name> [--warm]

The probes count thumbnails that appeared before their holds were ready. This
is the other half: frames of what was actually on screen, to look at. It needs
ImageMagick (`magick`) for the sheets.

Cold by default (the overlay cache is emptied at launch). It waits 34 s after
launch before touching anything: the list refetches several times while the app
starts, and a refetch resets the scroll position mid-capture.

Read the sheets for a row whose board is there and whose holds are not. A row
that is a flat grey block is being held back on purpose until its holds are
ready; count those separately.
"""
import json, os, subprocess, sys, threading, time
import ios
from runs import run_directory

name = sys.argv[1]
directory = run_directory(name)
if "--warm" not in sys.argv:
    ios.push_marker("perf-probe-cold")
ios.launch()
time.sleep(34)
ios.prepare_session({"mjpegServerFramerate": 30, "mjpegScalingFactor": 40, "mjpegServerScreenshotQuality": 45})
ios.require_foreground()
width, height = ios.screen_size()
middle = width / 2
# A slow walk first so several pages are loaded, then the filmed flicks.
for _ in range(6):
    ios.swipe(middle, height * 0.71, middle, height * 0.26, 110)
    time.sleep(1.2)
time.sleep(3)

frames = os.path.join(directory, "frames")
recorder = threading.Thread(target=ios.record_stream, args=(frames, 12))
recorder.start()
time.sleep(0.4)
started, marks = time.time(), []
for index in range(7):
    marks.append({"t": round(time.time() - started + 0.4, 2), "event": f"flick-{index}"})
    ios.swipe(middle, height * 0.71, middle, height * 0.166, 70)
    time.sleep(0.25)
recorder.join()
json.dump(marks, open(os.path.join(directory, "events.json"), "w"))
stamps = json.load(open(os.path.join(frames, "stamps.json")))
print(len(stamps), "frames;", "flicks at", [mark["t"] for mark in marks])

# Two sheets of 24 frames, each starting half a second after a flick: the list is moving fastest there.
for sheet, flick_index in (("a", 2), ("b", 4)):
    low, high = marks[flick_index]["t"] + 0.5, marks[flick_index]["t"] + 1.8
    selected = [index for index, stamp in enumerate(stamps) if low <= stamp <= high][:24]
    listing = os.path.join(directory, f"sheet-{sheet}.txt")
    open(listing, "w").write("\n".join(os.path.join(frames, f"f{index:05d}.jpg") for index in selected))
    subprocess.run(["magick", "montage", "@" + listing, "-tile", "8x3", "-geometry", "234x506+2+2", "-background", "#303030",
                    os.path.join(directory, f"sheet-{sheet}.jpg")], check=True)
    print(os.path.join(directory, f"sheet-{sheet}.jpg"))
