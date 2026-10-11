"""iPhone side of the probe kit.

Gestures and screenshots go through a WebDriverAgent runner on the phone;
launching the app and moving files go through `xcrun devicectl`. See
docs/mobile-visible-performance.md for how to start the runner and forward its
ports.

Environment:
  BOARDSESH_PROBE_UDID        the phone's UDID (required for launch and file moves)
  BOARDSESH_PROBE_BUNDLE_ID   default com.boardsesh.app
  BOARDSESH_PROBE_WDA_URL     default http://127.0.0.1:8231
  BOARDSESH_PROBE_MJPEG_URL   default http://127.0.0.1:8232
"""
import base64, glob, json, os, shutil, subprocess, tempfile, time, urllib.request

BUNDLE_ID = os.environ.get("BOARDSESH_PROBE_BUNDLE_ID", "com.boardsesh.app")
WDA_URL = os.environ.get("BOARDSESH_PROBE_WDA_URL", "http://127.0.0.1:8231")
MJPEG_URL = os.environ.get("BOARDSESH_PROBE_MJPEG_URL", "http://127.0.0.1:8232")
PROBE_DIRECTORY = "Documents/perf-probe"


def udid():
    value = os.environ.get("BOARDSESH_PROBE_UDID")
    if not value:
        raise SystemExit("Set BOARDSESH_PROBE_UDID to the phone's UDID (xcrun devicectl list devices).")
    return value


# --- WebDriverAgent ----------------------------------------------------------


def call(method, path, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(WDA_URL + path, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode())


def session():
    """The runner's session id. A relaunch of the app ends the old one, so a remembered id is checked first."""
    remembered = call("GET", "/status").get("sessionId")
    if remembered:
        try:
            call("GET", f"/session/{remembered}/window/size")
            return remembered
        except Exception:
            pass
    created = call("POST", "/session", {"capabilities": {"alwaysMatch": {}}})
    return created["value"]["sessionId"] if "sessionId" in created.get("value", {}) else created["sessionId"]


def prepare_session(extra_settings=None):
    """A session that does not wait for the app to go idle before each gesture.

    With the defaults every swipe waits for animations to settle first, which
    turns a flick into a slow drag and a scroll test into a test of patience.
    """
    session_id = session()
    settings = {"waitForIdleTimeout": 0, "animationCoolOffTimeout": 0}
    settings.update(extra_settings or {})
    call("POST", f"/session/{session_id}/appium/settings", {"settings": settings})
    return session_id


def require_foreground():
    active = call("GET", "/wda/activeAppInfo")["value"]["bundleId"]
    if active != BUNDLE_ID:
        raise SystemExit(f"The foreground app is {active}, not {BUNDLE_ID}. Unlock the phone and dismiss whatever is on top.")


def screen_size():
    size = call("GET", f"/session/{session()}/window/size")["value"]
    return size["width"], size["height"]


def screenshot(path):
    open(path, "wb").write(base64.b64decode(call("GET", "/screenshot")["value"]))


def tap(x, y):
    call("POST", f"/session/{session()}/wda/tap", {"x": float(x), "y": float(y)})


def swipe(x1, y1, x2, y2, duration_ms=200, hold_ms=0):
    """One finger down at (x1, y1), moved to (x2, y2) over duration_ms, lifted.

    The runner adds about 0.75 s around each call, so flicks land roughly once a
    second however short the pauses between them.
    """
    actions = [{"type": "pointer", "id": "finger1", "parameters": {"pointerType": "touch"}, "actions": [
        {"type": "pointerMove", "duration": 0, "x": float(x1), "y": float(y1)},
        {"type": "pointerDown", "button": 0},
        {"type": "pause", "duration": int(hold_ms)},
        {"type": "pointerMove", "duration": int(duration_ms), "x": float(x2), "y": float(y2)},
        {"type": "pointerUp", "button": 0},
    ]}]
    call("POST", f"/session/{session()}/actions", {"actions": actions})


def record_stream(out_directory, seconds):
    """Write the runner's screen stream to numbered JPEGs, with the host time of each frame in stamps.json.

    About 25 frames a second, with gaps while a gesture is being injected. It
    shows what was on screen; it is not a frame-timing measurement.
    """
    os.makedirs(out_directory, exist_ok=True)
    started = time.time()
    index, buffered, stamps = 0, b"", []
    with urllib.request.urlopen(MJPEG_URL, timeout=10) as stream:
        while time.time() - started < seconds:
            chunk = stream.read(65536)
            if not chunk:
                break
            buffered += chunk
            while True:
                start = buffered.find(b"\xff\xd8")
                end = buffered.find(b"\xff\xd9", start + 2) if start != -1 else -1
                if start == -1 or end == -1:
                    break
                frame, buffered = buffered[start:end + 2], buffered[end + 2:]
                with open(os.path.join(out_directory, f"f{index:05d}.jpg"), "wb") as image:
                    image.write(frame)
                stamps.append(round(time.time() - started, 4))
                index += 1
    json.dump(stamps, open(os.path.join(out_directory, "stamps.json"), "w"))
    return stamps


# --- devicectl ---------------------------------------------------------------


def launch():
    """Start the app in a fresh process. This is what makes a launch measurement a cold one."""
    subprocess.run(["xcrun", "devicectl", "device", "process", "launch", "--device", udid(), "--terminate-existing", BUNDLE_ID],
                   check=True, capture_output=True)
    return time.time()


def push_marker(name):
    """Drop an empty-ish file into the app's Documents. The probe module reads and deletes it at the next launch."""
    with tempfile.TemporaryDirectory() as scratch:
        marker = os.path.join(scratch, name)
        open(marker, "w").write(name + "\n")
        subprocess.run(["xcrun", "devicectl", "device", "copy", "to", "--device", udid(), "--domain-type", "appDataContainer",
                        "--domain-identifier", BUNDLE_ID, "--source", marker, "--destination", f"Documents/{name}"],
                       check=True, capture_output=True)


def pull_probes(run_directory):
    """Copy the probe chunks off the phone and merge them into <run>/probe-events.json, oldest first."""
    target = os.path.join(run_directory, "probe")
    shutil.rmtree(target, ignore_errors=True)
    os.makedirs(target)
    subprocess.run(["xcrun", "devicectl", "device", "copy", "from", "--device", udid(), "--domain-type", "appDataContainer",
                    "--domain-identifier", BUNDLE_ID, "--source", PROBE_DIRECTORY, "--destination", target],
                   check=True, capture_output=True)
    events = []
    for path in sorted(glob.glob(os.path.join(target, "**", "chunk-*.json"), recursive=True)):
        events.extend(json.load(open(path)))
    events.sort(key=lambda event: event["atMs"])
    json.dump(events, open(os.path.join(run_directory, "probe-events.json"), "w"))
    return events
