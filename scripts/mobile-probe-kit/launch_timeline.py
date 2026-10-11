#!/usr/bin/env python3
"""What happened between the first render and the first page of climbs.

    launch_timeline.py <run-directory>            the timeline of one launch
    launch_timeline.py --summary <run> [<run>..]  one line per launch, to compare builds

Time 0 is the first probe event, which is the first render of the root layout
when the launch markers are applied (apply_launch_markers.py), and that is
about 1.2 s after the process starts on an iPhone 13 Pro. Without the markers
the first event comes later and the early stalls are simply not recorded: an
absent stall in such a run proves nothing.

A GAP line is the JS thread going that long without running a frame callback.
Gaps of about 105 ms in a row before the database is ready are the frame
callback being throttled behind the splash screen, not work.
"""
import collections, json, sys

QUIET = {"overlay-shown", "overlay-painted", "background-load", "overlay-missed"}


def load(run):
    events = json.load(open(run + "/probe-events.json"))
    if not events:
        raise SystemExit(f"{run}: no probe events. Was the build made with EXPO_PUBLIC_PERF_PROBE=1?")
    return events, events[0]["atMs"]


def summary(run):
    events, base = load(run)
    page = next((event for event in events if event["name"] == "search-page"), None)
    end = page["atMs"] - base if page else 4000
    stalls = [event["gapMs"] for event in events if event["name"] == "js-frame-gap" and event["atMs"] - base <= end + 600 and event["gapMs"] >= 115]
    reads = sum(1 for event in events if event["name"] == "offline-request" and event.get("surface") == "climb_detail")
    first = events[0]["name"] + (":" + str(events[0].get("c")) if events[0].get("c") else "")
    print(f"{run.rstrip('/').split('/')[-1]:16s} starts at {first:20s} first page at {end:5.0f} ms"
          f" (waited {page['fetchMs'] if page else '-'} ms) | stalls >= 115 ms: {stalls} sum {sum(stalls)} | climb reads {reads}")


def timeline(run, window_ms=5000):
    events, base = load(run)
    counts, rows = collections.Counter(), []
    for event in events:
        at = event["atMs"] - base
        if at > window_ms:
            break
        name = event["name"]
        detail = {key: value for key, value in event.items() if key not in ("name", "atMs", "wallMs")}
        if name == "render":
            counts["render:" + event["c"]] += 1
            rows.append((at, f"render {event['c']} #{counts['render:' + event['c']]}"))
        elif name == "js-frame-gap":
            if event["gapMs"] >= 80:
                rows.append((at, f"GAP {event['gapMs']} ms  (JS blocked {at - event['gapMs']:.0f} -> {at:.0f})"))
        elif name == "offline-request":
            counts[f"request:{event['surface']}:{event['lane']}"] += 1
            if event["surface"] == "search":
                rows.append((at, f"search answered in {event['ms']} ms ({event['lane']})"))
        elif name == "offline-gate":
            counts["gate:" + event["surface"]] += 1
            if event["surface"] == "search":
                rows.append((at, f"search gate {event['gateMs']} ms"))
        elif name in QUIET:
            counts[name] += 1
        else:
            rows.append((at, f"{name} {json.dumps(detail)[:140]}"))
    previous = 0
    for at, text in rows:
        note = f"   <-- {at - previous:4.0f} ms since the previous line" if at - previous >= 120 else ""
        print(f"{at:7.0f} ms  {text}{note}")
        previous = at
    print("counts:", dict(counts))


if __name__ == "__main__":
    arguments = sys.argv[1:]
    if not arguments:
        raise SystemExit(__doc__)
    if arguments[0] == "--summary":
        for run in arguments[1:]:
            summary(run)
    else:
        timeline(arguments[0], float(arguments[1]) if len(arguments) > 1 else 5000)
