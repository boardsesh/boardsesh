#!/usr/bin/env python3
"""Summarise one run of scenario_list_and_drawer.py.

    analyze.py <run-directory> [label]

Reads <run>/probe-events.json (the phone's probes) and <run>/events.json (the
host's phase marks). The numbers to compare between two builds are, per phase:

  shown N: behind placeholder / at once from memory / at once NOT from memory
      A thumbnail "at once NOT from memory" is the defect: the board appeared
      and its holds had to be decoded afterwards, so they popped in. "Behind
      placeholder" is the cost of preventing that: the row waited as a grey
      block. Report both; neither alone says whether a change helped.
  rows painted ... wait p50/p90/max
      From a row getting a new climb to its holds being on screen.
  JS gaps
      Time the JS thread went 34 ms or more without running a frame callback.
      Divide by rows painted when comparing builds that scroll different
      distances.
  open: ...
      Milliseconds from the tap to each stage of the play drawer.
"""
import json, sys, statistics as st

run = sys.argv[1]
events = json.load(open(run + "/probe-events.json"))
try:
    marks = json.load(open(run + "/events.json"))
except FileNotFoundError:
    marks = []

def pct(values, q):
    if not values: return None
    values = sorted(values)
    return values[min(len(values) - 1, int(round(q * (len(values) - 1))))]

def describe(values):
    if not values: return "n=0"
    return f"n={len(values)} p50={pct(values, .5)} p90={pct(values, .9)} max={max(values)}"

def summarise(events, title):
    print(f"== {title} ({len(events)} events)")
    for surface in ("thumbnail", "play", "full"):
        painted = [e for e in events if e["name"] == "overlay-painted" and e.get("surface") == surface]
        missed = [e for e in events if e["name"] == "overlay-missed" and e.get("surface") == surface]
        if not painted and not missed: continue
        hit = [e["waitMs"] for e in painted if e.get("indexHit")]
        miss = [e["waitMs"] for e in painted if not e.get("indexHit")]
        cache_types = {}
        for e in painted: cache_types[e.get("cacheType")] = cache_types.get(e.get("cacheType"), 0) + 1
        print(f"  {surface}: painted {len(painted)}, never painted {len(missed)}")
        print(f"     wait when index had it : {describe(hit)}")
        print(f"     wait when it had to render: {describe(miss)}")
        print(f"     image cache types: {cache_types}")
        if missed: print(f"     shown without overlay (never painted) ms: {describe([e['shownMs'] for e in missed])}")
    for surface in ("thumbnail", "play", "full", "prefetch"):
        renders = [e for e in events if e["name"] == "overlay-render" and e.get("surface") == surface]
        if renders:
            print(f"  native render [{surface}]: native {describe([e['nativeMs'] for e in renders])} | queue {describe([e['queueMs'] for e in renders])} | config chars p50={pct([e['configLength'] for e in renders], .5)}")
    shown = [e for e in events if e["name"] == "overlay-shown" and not e.get("play")]
    if shown:
        ungated = [e for e in shown if not e.get("gated")]
        bare = [e for e in ungated if e.get("cacheType") != "memory"]
        print(f"  thumbnails shown: {len(shown)} | held behind placeholder {len(shown) - len(ungated)} | shown at once {len(ungated)}, of which NOT from memory (bare board until decode) {len(bare)}")
    pages = [e for e in events if e["name"] == "search-page"]
    if pages: print(f"  search pages: {[(e['page'], e['fetchMs']) for e in pages]}")
    gaps = [e["gapMs"] for e in events if e["name"] == "js-frame-gap"]
    print(f"  JS frame gaps >=34ms: {describe(gaps)} total={sum(gaps)}ms")
    backgrounds = {}
    for e in events:
        if e["name"] == "background-load":
            key = f"{e.get('cacheType')}@{e.get('width')}"
            backgrounds[key] = backgrounds.get(key, 0) + 1
    if backgrounds: print(f"  background loads: {backgrounds}")
    # Drawer opens: from each climb-press to the play overlay paint.
    presses = [e for e in events if e["name"] == "climb-press"]
    for press in presses:
        after = [e for e in events if press["atMs"] <= e["atMs"] <= press["atMs"] + 6000]
        def first(name, **match):
            for e in after:
                if e["name"] == name and all(e.get(k) == v for k, v in match.items()): return round(e["atMs"] - press["atMs"])
            return None
        play_render = next((e for e in after if e["name"] == "overlay-render" and e.get("surface") == "play"), None)
        play_paint = next((e for e in after if e["name"] == "overlay-painted" and e.get("surface") == "play"), None)
        print("  open: route=%s carousel=%s measured=%s photo=%s holds-painted=%s (index hit %s, %s) | play render: %s" % (
            first("play-route-mounted"), first("play-carousel-mounted"), first("play-board-measured"),
            next((round(e["atMs"] - press["atMs"]) for e in after if e["name"] == "background-load" and (e.get("width") or 0) >= 1000), None),
            first("overlay-painted", surface="play"),
            None if not play_paint else play_paint.get("indexHit"), None if not play_paint else play_paint.get("cacheType"),
            None if not play_render else f"queue {play_render['queueMs']} native {play_render['nativeMs']}"))

summarise(events, sys.argv[2] if len(sys.argv) > 2 else run.rsplit("/", 1)[-1])

def phase(label, start_event, end_event):
    start = next((m["wall"] for m in marks if m["event"] == start_event), None)
    end = next((m["wall"] for m in marks if m["event"].startswith(end_event) and (start is None or m["wall"] > start)), None)
    if start is None or end is None: return
    window = [e for e in events if start <= e["wallMs"] <= end]
    painted = [e for e in window if e["name"] == "overlay-painted" and e.get("surface") == "thumbnail"]
    missed = [e for e in window if e["name"] == "overlay-missed" and e.get("surface") == "thumbnail"]
    waits = [e["waitMs"] for e in painted]
    late = [w for w in waits if w > 50]
    gaps = [e["gapMs"] for e in window if e["name"] == "js-frame-gap"]
    renders = [e for e in window if e["name"] == "overlay-render" and e.get("surface") == "thumbnail"]
    if renders: print(f"   [{label}] thumbnail renders: native {describe([e['nativeMs'] for e in renders])} queue {describe([e['queueMs'] for e in renders])}")
    shown = [e for e in window if e["name"] == "overlay-shown" and not e.get("play")]
    bare = [e for e in shown if not e.get("gated") and e.get("cacheType") != "memory"]
    if shown: print(f"   [{label}] shown {len(shown)}: behind placeholder {sum(1 for e in shown if e.get('gated'))}, at once from memory {sum(1 for e in shown if not e.get('gated') and e.get('cacheType') == 'memory')}, at once NOT from memory {len(bare)}")
    print(f"-- {label}: rows painted {len(painted)} (index hit {sum(1 for e in painted if e.get('indexHit'))}), never painted {len(missed)}, "
          f"wait {describe(waits)}, >50ms: {len(late)}, JS gaps {describe(gaps)} total={sum(gaps)}ms")

phase("load (new rows)", "load-start", "load-end")
phase("fast up (seen rows)", "up-start", "up-end")
phase("fast down (seen rows)", "down-start", "down-end")
