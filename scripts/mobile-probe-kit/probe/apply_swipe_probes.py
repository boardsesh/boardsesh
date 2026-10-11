#!/usr/bin/env python3
"""Add the play drawer's swipe and swipe-down probes on top of apply_probes.py. See docs/mobile-visible-performance.md.

    apply_swipe_probes.py <repo-root>

A swipe between climbs and the pull-down close both run on the UI thread, so
these probes stamp the UI thread's clock (`uiWallMs`) and sample the gesture's
own shared value at every UI frame (`ui-frames`). What each event is for:

  swipe-begin              the carousel's pan activated (10 px of travel). `tookOver`:
                           the last fling was still running and this swipe carried on from it
  swipe-release            finger up: offset, velocity, and which way it commits
  swipe-blocked            far or fast enough to change the climb, but no page was mounted
                           that way. `jsBehind`: because the JS thread had not rendered the
                           last step yet, rather than the queue ending there
  swipe-settled            the fling finished: outgoing board off screen, the anchor moved
  swipe-taken-over         the next swipe ended the fling early instead
  swipe-reset-ui           the carousel is at rest with the new climb in the middle
  swipe-commit-js(-done)   the JS thread heard of the step, which is when the incoming board
                           stopped in the middle; it has asked the queue for the climb (later
                           than the first when an earlier step was still being rendered)
  swipe-reset-js           the JS thread committed a render with that climb current
  swipe-js-caught-up       the UI thread heard that the JS thread has rendered every step
  carousel-render          which climbs the carousel has boards for, and how far the incoming
                           board travels to reach the middle (`slide`)
  dismiss-begin / -release / -settled / -interrupted   the pull-down close
  dismiss-complete-js, dismiss-route-dismiss-js, play-route-unmounted
  queue-limited            the `perf-probe-queue-5` marker cut the restored queue
                           down for this launch; the saved queue is untouched

Every edit asserts its anchor occurs once, like apply_probes.py.
"""
import sys

if len(sys.argv) != 2:
    sys.exit(__doc__)
M = sys.argv[1].rstrip("/") + "/packages/mobile/"


def edit(path, pairs, imports=()):
    text = open(M + path).read()
    for old, new in pairs:
        assert text.count(old) == 1, (path, old[:70], text.count(old))
        text = text.replace(old, new)
    for import_line in imports:
        if import_line not in text:
            first_import = text.index("import ")
            text = text[:first_import] + import_line + "\n" + text[first_import:]
    open(M + path, "w").write(text)


edit("src/components/play-drawer/use-carousel-gesture.ts", [
("""      const direction = flingDirection.value;
      if (direction === 0) return;
""",
"""      const direction = flingDirection.value;
      if (direction === 0) return;
      perfProbeUi(carry ? 'swipe-taken-over' : 'swipe-settled', { direction: direction > 0 ? 'next' : 'previous' });
      perfProbeUi('swipe-reset-ui');
"""),
("""      .onStart((event) => {
        'worklet';
        hasTriggeredHaptic.value = false;
""",
"""      .onStart((event) => {
        'worklet';
        hasTriggeredHaptic.value = false;
        perfProbeUiFramesStart('swipe', translateX, isAnimating);
        perfProbeUi('swipe-begin', { tookOver: isAnimating.value });
"""),
("""        const direction = commitDirection === 'next' ? 1 : commitDirection === 'previous' ? -1 : 0;

""",
"""        const direction = commitDirection === 'next' ? 1 : commitDirection === 'previous' ? -1 : 0;
        perfProbeUi('swipe-release', {
          offset: Math.round(offset),
          velocityX: Math.round(velocity),
          commit: direction !== 0 && canStep(direction) ? (commitDirection ?? 'none') : 'none',
        });
        if (direction !== 0 && !canStep(direction)) {
          perfProbeUi('swipe-blocked', {
            wouldCommit: commitDirection ?? 'none',
            jsBehind: anchorPage.value !== jsState.value.center || jsState.value.processedStep !== uiSteps.value,
          });
        }

"""),
], ["import { perfProbeUi, perfProbeUiFramesStart } from '../../lib/perf-probe';"])

# The pager: the JS thread hearing of a step and asking the queue for the climb, and
# the UI thread hearing that the JS thread has rendered every step it took.
edit("src/components/play-drawer/use-swipe-pager.ts", [
("""    (direction: 1 | -1, step: number) => {
      waitingStepsRef.current.push({ direction, step });
""",
"""    (direction: 1 | -1, step: number) => {
      perfProbe('swipe-commit-js', { direction: direction === 1 ? 'next' : 'previous', step });
      waitingStepsRef.current.push({ direction, step });
"""),
("""      navigation?.onPrevious();
    }
""",
"""      navigation?.onPrevious();
    }
    perfProbe('swipe-commit-js-done', { step: next.step });
"""),
("""      if (state.processedStep !== uiSteps.value) return;
""",
"""      if (state.processedStep !== uiSteps.value) return;
      perfProbeUi('swipe-js-caught-up', { center: state.center, step: state.processedStep });
"""),
], ["import { perfProbe, perfProbeUi } from '../../lib/perf-probe';"])

# apply_probes.py already imports `perfProbe` into the carousel; importing a name twice does not compile.
edit("src/components/play-drawer/SwipeBoardCarousel.tsx", [
("""  const renderSlot = (page: number, frames: string | null, isCurrent: boolean) => (
""",
"""  perfProbe('carousel-render', {
    center: centerPage,
    slide: Math.round(boardWidthForSwipe),
    current: perfProbeId(currentFrames),
    next: perfProbeId(nextFrames),
    previous: perfProbeId(prevFrames),
    boards: [neighboursMounted ? prevFrames : null, currentFrames, neighboursMounted ? nextFrames : null]
      .map((frames) => perfProbeId(frames))
      .filter(Boolean)
      .join(','),
  });
  const renderSlot = (page: number, frames: string | null, isCurrent: boolean) => (
"""),
], ["import { perfProbeId } from '../../lib/perf-probe';"])

drawer = "src/components/play-drawer/PlayDrawer.tsx"
edit(drawer, [
("""    navigationState.canNext ? swipePageId(navigationState.nextItem) : null,
  );
""",
"""    navigationState.canNext ? swipePageId(navigationState.nextItem) : null,
  );
  // The JS thread has committed a render with this climb in the middle.
  useEffect(() => {
    perfProbe('swipe-reset-js', { queue: queue.length, center: swipeCenterPage });
  }, [swipeCenterPage]);
"""),
], ["import { perfProbe } from '../../lib/perf-probe';"])
# How often the whole drawer renders per swipe. apply_launch_markers.py adds the same line; do not add it twice.
drawer_text = open(M + drawer).read()
if "perfProbe('render', { c: 'PlayDrawer' });" not in drawer_text:
    signature = "export function PlayDrawer({"
    assert drawer_text.count(signature) == 1
    position = drawer_text.index("\n", drawer_text.index(signature)) + 1
    while True:
        line_end = drawer_text.index("\n", position)
        line = drawer_text[position:line_end]
        if line.startswith("}") and line.rstrip().endswith("{"):
            break
        position = line_end + 1
    drawer_text = drawer_text[:line_end] + "\n  perfProbe('render', { c: 'PlayDrawer' });" + drawer_text[line_end:]
    open(M + drawer, "w").write(drawer_text)

edit("src/components/play-drawer/use-drawer-dismiss-gesture.ts", [
("""      .onUpdate((event) => {
        'worklet';
        if (isDismissing.value) return;
        // Once the carousel owns the gesture""",
"""      .onStart(() => {
        'worklet';
        perfProbeUiFramesStart('dismiss', translateY, isDismissing);
        perfProbeUi('dismiss-begin', { atTop: startedAtTop.value, scrollY: Math.round(scrollYSV.value) });
      })
      .onUpdate((event) => {
        'worklet';
        if (isDismissing.value) return;
        // Once the carousel owns the gesture"""),
("""        if (committed) {
          isDismissing.value = true;
""",
"""        perfProbeUi('dismiss-release', {
          committed,
          translateY: Math.round(translateY.value),
          velocityY: Math.round(event.velocityY),
          height: dismissHeight ? Math.round(dismissHeight.value) : -1,
        });
        if (committed) {
          isDismissing.value = true;
"""),
("""              (finished) => {
                if (finished) {
                  runOnJS(commitDismiss)();
""",
"""              (finished) => {
                perfProbeUi(finished ? 'dismiss-settled' : 'dismiss-interrupted');
                if (finished) {
                  perfProbeUiFramesStop('settled');
                  runOnJS(commitDismiss)();
"""),
], ["import { perfProbeUi, perfProbeUiFramesStart, perfProbeUiFramesStop } from '../../lib/perf-probe';"])

edit("src/components/play-drawer/use-play-swipe-dismiss.ts", [
("""    removalRequestedRef.current = true;
    setOffscreen(true);
""",
"""    removalRequestedRef.current = true;
    perfProbe('dismiss-complete-js');
    setOffscreen(true);
"""),
("""        if (navigation.isFocused()) {
          router.dismiss();
        } else {
          // A different modal covered""",
"""        if (navigation.isFocused()) {
          perfProbe('dismiss-route-dismiss-js');
          router.dismiss();
        } else {
          // A different modal covered"""),
], ["import { perfProbe } from '../../lib/perf-probe';"])

# apply_probes.py already imports `perfProbe` into the route.
edit("app/play.tsx", [
("""    const handle = requestAnimationFrame(() => setContentMounted(true));
    return () => cancelAnimationFrame(handle);
""",
"""    const handle = requestAnimationFrame(() => setContentMounted(true));
    return () => {
      perfProbe('play-route-unmounted');
      cancelAnimationFrame(handle);
    };
"""),
])

# A short queue for one launch (the `perf-probe-queue-5` marker), without touching the saved one.
edit("src/lib/queue-snapshot-store.ts", [
("""const QUEUE_SNAPSHOT_KEY = 'boardsesh_local_queue_snapshot_v1';
""",
"""const QUEUE_SNAPSHOT_KEY = 'boardsesh_local_queue_snapshot_v1';
const QUEUE_SNAPSHOT_WRITE_KEY = PERF_PROBE_QUEUE_LIMIT > 0 ? `${QUEUE_SNAPSHOT_KEY}_probe` : QUEUE_SNAPSHOT_KEY;

function limitQueueForProbe(snapshot: LocalQueueSnapshot): LocalQueueSnapshot {
  const currentIndex = snapshot.queue.findIndex((item) => item.uuid === snapshot.currentClimbQueueItem?.uuid);
  const end = currentIndex < 0 ? snapshot.queue.length : currentIndex + 1;
  const queue = snapshot.queue.slice(Math.max(0, end - PERF_PROBE_QUEUE_LIMIT), end);
  perfProbe('queue-limited', { from: snapshot.queue.length, to: queue.length });
  return { ...snapshot, queue };
}
"""),
("""  const snapshot = await getPreference<LocalQueueSnapshot>(QUEUE_SNAPSHOT_KEY);
  if (!snapshot) return null;
""",
"""  const storedSnapshot = await getPreference<LocalQueueSnapshot>(QUEUE_SNAPSHOT_KEY);
  const snapshot = storedSnapshot && PERF_PROBE_QUEUE_LIMIT > 0 ? limitQueueForProbe(storedSnapshot) : storedSnapshot;
  if (!snapshot) return null;
"""),
("setPreference(QUEUE_SNAPSHOT_KEY, references)", "setPreference(QUEUE_SNAPSHOT_WRITE_KEY, references)"),
("removePreference(QUEUE_SNAPSHOT_KEY)", "removePreference(QUEUE_SNAPSHOT_WRITE_KEY)"),
], ["import { PERF_PROBE_QUEUE_LIMIT, perfProbe } from './perf-probe';"])

print("swipe probes applied")
