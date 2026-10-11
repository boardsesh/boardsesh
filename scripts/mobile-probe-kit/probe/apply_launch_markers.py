#!/usr/bin/env python3
"""Add launch attribution markers on top of apply_probes.py. See docs/mobile-visible-performance.md.

    apply_launch_markers.py <repo-root>

Adds a `render` event at every render of the components the app mounts at
launch, the saved queue coming back, the queue's climb reads, and which climb
each detail read was for. The first of them, in the root layout, is what
starts the stall monitor early enough to see the launch at all.

A marker whose anchor is missing is skipped and named, because these follow the
code more loosely than the probes do: a skipped marker costs one line of the
timeline, not the run.
"""
import sys

if len(sys.argv) != 2:
    sys.exit(__doc__)
M = sys.argv[1].rstrip("/") + "/packages/mobile/"
skipped = []


def read(path):
    try:
        return open(M + path).read()
    except FileNotFoundError:
        return None


def add_import(text, import_line):
    if import_line in text:
        return text
    first_import = text.index("import ")
    return text[:first_import] + import_line + "\n" + text[first_import:]


def mark_render(path, signature_start, component, probe_import_path):
    """A render marker as the first statement of a component whose signature may span several lines."""
    text = read(path)
    if text is None or text.count(signature_start) != 1:
        skipped.append(f"render {component}")
        return
    start = text.index(signature_start)
    line_end = text.index("\n", start)
    first_line = text[start:line_end]
    if first_line.rstrip().endswith("{") and first_line.count("(") == first_line.count(")"):
        insert_at = line_end
    else:
        # The parameter list closes on a line that starts with `}` and ends with `{`.
        position = line_end + 1
        while True:
            next_end = text.index("\n", position)
            line = text[position:next_end]
            if line.startswith("}") and line.rstrip().endswith("{"):
                insert_at = next_end
                break
            position = next_end + 1
    text = text[:insert_at] + f"\n  perfProbe('render', {{ c: '{component}' }});" + text[insert_at:]
    open(M + path, "w").write(add_import(text, f"import {{ perfProbe }} from '{probe_import_path}';"))


def edit(path, label, pairs, probe_import_path=None):
    text = read(path)
    if text is None or any(text.count(old) != 1 for old, _ in pairs):
        skipped.append(label)
        return
    for old, new in pairs:
        text = text.replace(old, new)
    if probe_import_path:
        text = add_import(text, f"import {{ perfProbe }} from '{probe_import_path}';")
    open(M + path, "w").write(text)


mark_render("app/_layout.tsx", "function RootLayout() {", "RootLayout", "../src/lib/perf-probe")
mark_render("app/(tabs)/_layout.tsx", "export default function TabLayout() {", "TabLayout", "../../src/lib/perf-probe")
# The screen's body, not the `ClimbList` wrapper around it: the wrapper renders once and says nothing.
mark_render("app/(tabs)/climbs/index.tsx", "function ClimbListInner() {", "ClimbListInner", "../../../src/lib/perf-probe")
mark_render("src/providers/auth-provider.tsx", "export function AuthProvider({", "AuthProvider", "../lib/perf-probe")
mark_render("src/providers/database-provider.tsx", "export function DatabaseProvider({", "DatabaseProvider", "../lib/perf-probe")
mark_render("src/providers/queue-provider.tsx", "export function QueueProvider({", "QueueProvider", "../lib/perf-probe")
mark_render("src/providers/bluetooth-provider.tsx", "export function BluetoothProvider({", "BluetoothProvider", "../lib/perf-probe")
mark_render("src/components/play-drawer/PlayDrawer.tsx", "export function PlayDrawer({", "PlayDrawer", "../../lib/perf-probe")
mark_render("src/components/play-drawer/QueueList.tsx", "function QueueListComponent({", "QueueList", "../../lib/perf-probe")
mark_render("src/components/queue-control/persistent-queue-bar.tsx", "export function PersistentQueueBar() {", "PersistentQueueBar", "../../lib/perf-probe")
mark_render("src/components/queue-control/QueueBottomAccessory.tsx", "export function QueueBottomAccessory() {", "QueueBottomAccessory", "../../lib/perf-probe")
mark_render("src/lib/live-activity/live-activity-bridge.tsx", "export function LiveActivityBridge({", "LiveActivityBridge", "../perf-probe")

# The saved queue coming back.
edit("src/providers/queue/use-queue-persistence.ts", "queue-restore", [
("      const snapshot = await getStoredQueueSnapshot(owner);\n",
 "      perfProbe('queue-restore', { step: 'read-start' });\n      const snapshot = await getStoredQueueSnapshot(owner);\n      perfProbe('queue-restore', { step: 'read-done', items: snapshot?.queue?.length ?? -1 });\n"),
("      restoreQueueSnapshot(snapshot);\n    };",
 "      restoreQueueSnapshot(snapshot);\n      perfProbe('queue-restore', { step: 'dispatched' });\n    };"),
], "../../lib/perf-probe")

# How many climbs each queue hook asks for, per run of its effect.
edit("src/providers/queue/use-queue-regrade.ts", "queue-regrade-run", [
("    const targetUuids = [...uuids];\n",
 "    const targetUuids = [...uuids];\n    perfProbe('queue-regrade-run', { targets: targetUuids.length, queue: queue.length, angle });\n"),
], "../../lib/perf-probe")
edit("src/providers/queue/use-queue-resolve-climbs.ts", "queue-resolve-run", [
("    if (!requests.size) return;\n",
 "    perfProbe('queue-resolve-run', { wanted: requests.size, queue: queue.length });\n    if (!requests.size) return;\n"),
], "../../lib/perf-probe")

# Which climb each detail read was for, so repeats can be counted.
edit("src/lib/graphql/offline-request.ts", "climb on offline-request", [
("""        perfProbe('offline-request', {
          lane: 'local',
          surface: String(operation.surface),
          ms: Math.round(perfNow() - probeLocalStartedAtMs),
        });
""",
"""        perfProbe('offline-request', {
          lane: 'local',
          surface: String(operation.surface),
          ms: Math.round(perfNow() - probeLocalStartedAtMs),
          climb: String((variables as { climbUuid?: string } | undefined)?.climbUuid ?? ''),
          angle: Number((variables as { angle?: number } | undefined)?.angle ?? -1),
        });
"""),
])

print("launch markers applied" + (f"; skipped: {', '.join(skipped)}" if skipped else ""))
