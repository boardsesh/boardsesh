#!/usr/bin/env python3
"""A cold launch, left alone, then the probes. Needs no UI driver.

    scenario_launch.py <run-name> [settle-seconds] [marker-file ...]

Launches the app in a fresh process, waits (12 s by default) while it loads its
first page, pulls the probes and prints the launch timeline. Any marker files
named are pushed first; see the doc for the ones the probe build understands.

Run it at least three times per build. The first launch after an install is
slower (cold file cache) and is worth keeping apart.
"""
import os, subprocess, sys, time
import ios
from runs import run_directory

name = sys.argv[1]
settle = float(sys.argv[2]) if len(sys.argv) > 2 else 12
directory = run_directory(name)
for marker in sys.argv[3:]:
    ios.push_marker(marker)
ios.launch()
time.sleep(settle)
ios.pull_probes(directory)
subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "launch_timeline.py"), directory], check=True)
