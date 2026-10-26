#!/usr/bin/env python3
"""Inject the measurement probes into a Boardsesh checkout. See docs/mobile-visible-performance.md.

    apply_probes.py <repo-root> [--settle-consent]

Every edit is an exact-text replacement whose anchor must occur exactly once.
All replacements are staged before writing, so a missing, duplicate, or already
instrumented anchor leaves the checkout unchanged. Re-fit moved anchors using
the event's purpose in the doc; never silently skip a measurement.

Use an isolated clean checkout and never commit the injected result. After
capturing measurements, restore only the modifiedMobilePaths printed on success.

--settle-consent       Do not show the analytics consent prompt in this build.
                       Consent stays undecided, so analytics stay off. Without
                       it a fresh install waits on the prompt, and answering it
                       records a decision against the signed-in account.

The old --keep-offline-boards flag is gone: since #6545 nothing in the app
drops the offline boards between runs, so there is nothing to suppress.
"""
import json
from pathlib import Path
import sys

args = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
flags = {arg for arg in sys.argv[1:] if arg.startswith("--")}
unknown = flags - {"--settle-consent"}
if len(args) != 1 or unknown:
    sys.exit(__doc__)
root = Path(args[0]).resolve()
mobile = root / "packages/mobile"
HERE = Path(__file__).resolve().parent
staged = {}


def read(path):
    return staged[path] if path in staged else (mobile / path).read_text()


def require_once(path, source, anchor):
    count = source.count(anchor)
    if count != 1:
        raise ValueError(f"{path}: expected exactly one anchor {anchor[:80]!r}; found {count}")


def edit(path, pairs):
    source = read(path)
    for old, new in pairs:
        require_once(path, source, old)
        source = source.replace(old, new, 1)
    staged[path] = source


def replace_one_of(path, variants):
    source = read(path)
    counts = [source.count(old) for old, _new in variants]
    if sum(counts) != 1:
        raise ValueError(f"{path}: expected exactly one supported anchor variant; found {counts}")
    selected = counts.index(1)
    old, new = variants[selected]
    staged[path] = source.replace(old, new, 1)


def add_import(path, statement):
    source = read(path)
    statement = statement.rstrip("\n")
    if statement in source:
        raise ValueError(f"{path}: already instrumented import {statement!r}")
    first = source.find("import ")
    if first < 0:
        raise ValueError(f"{path}: missing import anchor")
    staged[path] = source[:first] + statement + "\n" + source[first:]


probe = "src/lib/perf-probe.ts"
if (mobile / probe).exists():
    raise ValueError(f"{probe}: standard probes already applied")
staged[probe] = (HERE / "perf-probe.ts.template").read_text()

PROBE_IMPORT = "import { PERF_PROBE_ENABLED, perfNow, perfProbe, perfProbeId } from '../lib/perf-probe';\n"
hook = "src/hooks/use-native-climb-render.ts"
add_import(hook, PROBE_IMPORT)
edit(hook, [
("""    const renderRequest = requestRender(currentCacheKey, renderPriority, () =>
      getOrStartInflightRender(currentCacheKey, () => {
        const configJson = JSON.stringify({
          ...boardConfig.configBase,
          frames: flatFrames,
        });
        return nativeModule.renderHoldsOverlay(configJson, currentCacheKey);""",
"""    const probeRequestedAtMs = perfNow();
    let probeDispatchedAtMs = 0;
    const renderRequest = requestRender(currentCacheKey, renderPriority, () =>
      getOrStartInflightRender(currentCacheKey, () => {
        const configJson = JSON.stringify({
          ...boardConfig.configBase,
          frames: flatFrames,
        });
        probeDispatchedAtMs = perfNow();
        return nativeModule.renderHoldsOverlay(configJson, currentCacheKey);"""),
("""      .then((renderedEntry) => {
        clearRenderStallWatchdog();
""",
"""      .then((renderedEntry) => {
        clearRenderStallWatchdog();
        if (PERF_PROBE_ENABLED && probeDispatchedAtMs > 0) {
          perfProbe('overlay-render', {
            surface: failureTelemetryContext.surface,
            queueMs: Math.round(probeDispatchedAtMs - probeRequestedAtMs),
            nativeMs: Math.round(perfNow() - probeDispatchedAtMs),
            frames: perfProbeId(frames),
          });
        }
"""),
("""  const latestCacheKeyRef = useRef(currentCacheKey);
  latestCacheKeyRef.current = currentCacheKey;
""",
"""  const latestCacheKeyRef = useRef(currentCacheKey);
  latestCacheKeyRef.current = currentCacheKey;
  const overlayWaitProbeRef = useRef<{
    key: string;
    frames: string;
    seenAtMs: number;
    indexHit: boolean;
    painted: boolean;
  } | null>(null);
  if (PERF_PROBE_ENABLED && flatFrames && overlayWaitProbeRef.current?.key !== currentCacheKey) {
    const previousWait = overlayWaitProbeRef.current;
    if (previousWait && !previousWait.painted) {
      perfProbe('overlay-missed', {
        surface: playSurface ? 'play' : prefetch ? 'prefetch' : filledStyle ? 'thumbnail' : 'full',
        shownMs: Math.round(perfNow() - previousWait.seenAtMs),
        indexHit: previousWait.indexHit,
        frames: previousWait.frames,
      });
    }
    overlayWaitProbeRef.current = {
      key: currentCacheKey,
      frames: perfProbeId(frames),
      seenAtMs: perfNow(),
      indexHit: getRenderedOverlay(currentCacheKey) !== undefined,
      painted: false,
    };
  }
"""),
("""    (emittingLoadKey: string | null) => {
      // Before the key-match guards below: a paint is a paint, and the watchdog
      // only ever asks whether expo-image answered.
      clearPaintWatchdog(emittingLoadKey);
""",
"""    (emittingLoadKey: string | null, cacheType?: string) => {
      // Before the key-match guards below: a paint is a paint, and the watchdog
      // only ever asks whether expo-image answered.
      clearPaintWatchdog(emittingLoadKey);
      if (PERF_PROBE_ENABLED) {
        const wait = overlayWaitProbeRef.current;
        if (wait && wait.key === currentCacheKey && !wait.painted) {
          wait.painted = true;
          perfProbe('overlay-painted', {
            surface: failureTelemetryContextRef.current.surface,
            waitMs: Math.round(perfNow() - wait.seenAtMs),
            indexHit: wait.indexHit,
            cacheType: cacheType ?? null,
            frames: wait.frames,
          });
        }
      }
"""),
("  onOverlayLoad: (loadKey: string | null) => void;", "  onOverlayLoad: (loadKey: string | null, cacheType?: string) => void;"),
])

layered_text = read("src/components/LayeredClimbImage.tsx")
background_load_variants = [
    (
        "          onLoad={() => noteBoardArtInMemory(backgroundImageUri(path))}",
        """          onLoad={(event: ImageLoadEventData) => {
            noteBoardArtInMemory(backgroundImageUri(path));
            if (PERF_PROBE_ENABLED) reportBackgroundLoad(event);
          }}""",
    ),
    (
        """          allowDownscaling={false}
        />
      ))}""",
        """          allowDownscaling={false}
          onLoad={PERF_PROBE_ENABLED ? reportBackgroundLoad : undefined}
        />
      ))}""",
    ),
]
replace_one_of("src/components/LayeredClimbImage.tsx", background_load_variants)
GATED = "awaitingOverlay" if "const awaitingOverlay" in layered_text else "false"
edit("src/components/LayeredClimbImage.tsx", [
("import type { ImageErrorEventData } from 'expo-image';\n",
 "import type { ImageErrorEventData, ImageLoadEventData } from 'expo-image';\nimport { PERF_PROBE_ENABLED, perfProbe } from '../lib/perf-probe';\n"),
("  onOverlayLoad?: (loadKey: string | null) => void;", "  onOverlayLoad?: (loadKey: string | null, cacheType?: string) => void;"),
("export function backgroundImageUri(path: string): string {",
 """function reportBackgroundLoad(event: ImageLoadEventData): void {
  perfProbe('background-load', { cacheType: event.cacheType, width: event.source.width });
}

export function backgroundImageUri(path: string): string {"""),
("          onLoad={() => {",
 "          onLoad={(event: ImageLoadEventData) => {\n            perfProbe('overlay-shown', { gated: " + GATED + ", cacheType: event.cacheType, play: overlayTestID != null });"),
("            onOverlayLoad?.(emittingLoadKey);", "            onOverlayLoad?.(emittingLoadKey, event.cacheType);"),
])

edit("src/lib/graphql/hooks/use-infinite-search-climbs.ts", [
("""    queryFn: ({ pageParam }) =>
      offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, {
        input: { ...searchInput, page: pageParam },
      }),
""",
"""    queryFn: async ({ pageParam }) => {
      const probeStartedAtMs = perfNow();
      const response = await offlineAwareRequest<SearchClimbsQueryResponse>(SEARCH_CLIMBS, {
        input: { ...searchInput, page: pageParam },
      });
      perfProbe('search-page', {
        page: pageParam,
        fetchMs: Math.round(perfNow() - probeStartedAtMs),
        climbCount: response.searchClimbs.climbs.length,
        sort: `${String(searchInput.sortBy)}:${searchInput.boardName}/${searchInput.layoutId}/${searchInput.sizeId}@${searchInput.angle}`,
      });
      return response;
    },
"""),
("import { useGradeSourceSearchInput } from './search-grade-source';\n",
 "import { useGradeSourceSearchInput } from './search-grade-source';\nimport { perfNow, perfProbe } from '../../perf-probe';\n"),
])

climbs = "app/(tabs)/climbs/index.tsx"
press_anchor = "  const handleClimbPress = useCallback("
require_once(climbs, read(climbs), press_anchor)
guard = "      if (isPlaceholderDataRef.current) return;\n"
press_signatures = [
    "    (climb: Climb) => {\n",
    "    (climb: Climb, readyBoardArt?: import('../../../src/lib/board-render/ready-board-art').ReadyBoardArtSnapshot) => {\n",
]
replace_one_of(climbs, [
    (
        press_anchor + "\n" + signature + guard,
        press_anchor + "\n" + signature + """      perfProbe('climb-press');
      if (isPlaceholderDataRef.current) {
        perfProbe('climb-open-rejected', { reason: 'placeholder-results' });
        return;
      }
""",
    )
    for signature in press_signatures
])
skeleton_import = "import { ClimbListRowSkeleton } from '../../../src/components/ClimbListRowSkeleton';\n"
edit(climbs, [(skeleton_import, skeleton_import + "import { perfProbe } from '../../../src/lib/perf-probe';\n")])

edit("app/play.tsx", [
("function PlayScreen() {", """function PlayScreen() {
  useEffect(() => { perfProbe('play-route-mounted'); }, []);"""),
])
add_import("app/play.tsx", "import { perfProbe } from '../src/lib/perf-probe';")

edit("src/components/play-drawer/SwipeBoardCarousel.tsx", [
("""  const measuredOverlayWidth = boardBox ? Math.round(boardBox.width * PixelRatio.get()) : null;
""",
 """  const probeBoardMeasured = boardBox != null;
  useEffect(() => {
    perfProbe(probeBoardMeasured ? 'play-board-measured' : 'play-carousel-mounted');
  }, [probeBoardMeasured]);
  const measuredOverlayWidth = boardBox ? Math.round(boardBox.width * PixelRatio.get()) : null;
"""),
])
add_import("src/components/play-drawer/SwipeBoardCarousel.tsx", "import { perfProbe } from '../../lib/perf-probe';")

offline = "src/lib/graphql/offline-request.ts"
owner_checks = [
    name for name in ["isLocalDataOwnerCurrent", "canReadPrivateCatalog"]
    if f"(await {name}(localDb))" in read(offline)
]
if len(owner_checks) != 1:
    raise ValueError(f"{offline}: expected exactly one supported local gate helper; found {owner_checks}")
owner_check = owner_checks[0]
edit("src/lib/graphql/offline-request.ts", [
("""      localDb = getDatabaseHandle();
""",
"""      localDb = getDatabaseHandle();
      if (PERF_PROBE_ENABLED && variables !== undefined) {
        const probeGateStartedAtMs = perfNow();
        const probeOwner = localDb ? await OWNER_CHECK(localDb) : false;
        const probeCanServe = localDb && probeOwner ? await operation.canServeLocal(localDb, variables as never) : false;
        perfProbe('offline-gate', {
          surface: String(operation.surface),
          allowed: localAllowed(),
          hasDb: localDb != null,
          owner: probeOwner,
          canServe: probeCanServe === true,
          online: isOnline,
          gateMs: Math.round(perfNow() - probeGateStartedAtMs),
        });
      }
""".replace("OWNER_CHECK", owner_check)),
])
local_response_anchors = [
    "        const localResponse = (await operation.resolveLocal(localDb, variables as never)) as TResponse;\n",
    "        const localResponse = (await operation.resolveLocal(localDb, variables as never)) as TResponse | null;\n",
]
replace_one_of("src/lib/graphql/offline-request.ts", [
    (anchor, "        const probeLocalStartedAtMs = perfNow();\n" + anchor + """        perfProbe('offline-request', {
          lane: 'local',
          surface: String(operation.surface),
          ms: Math.round(perfNow() - probeLocalStartedAtMs),
        });
""")
    for anchor in local_response_anchors
])
network_response_anchors = [
    "    const networkResponse = await getHttpClient().request<TResponse>(document, sentVariables);\n",
    """    const networkResponse = signal
      ? await getHttpClient().request<TResponse>({ document, variables: sentVariables, signal })
      : await getHttpClient().request<TResponse>(document, sentVariables);
""",
]
replace_one_of("src/lib/graphql/offline-request.ts", [
    (anchor, "    const probeNetworkStartedAtMs = perfNow();\n" + anchor + """    if (operation) {
      perfProbe('offline-request', {
        lane: 'network',
        surface: String(operation.surface),
        ms: Math.round(perfNow() - probeNetworkStartedAtMs),
        engine: isOfflineEngineEnabled(),
        online: onlineManager.isOnline(),
      });
    }
""")
    for anchor in network_response_anchors
])
add_import("src/lib/graphql/offline-request.ts", "import { PERF_PROBE_ENABLED, perfNow, perfProbe } from '../perf-probe';")


SETTLE_CONSENT = [
("""    if (killed || process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') {
      updateConsentState({ settled: true });""",
 """    // MEASUREMENT BUILD ONLY. Leaves consent undecided (analytics off).
    if (killed || process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' || process.env.EXPO_PUBLIC_PERF_PROBE === '1') {
      updateConsentState({ settled: true });"""),
]
if "--settle-consent" in flags:
    edit("src/components/onboarding/ConsentGate.tsx", SETTLE_CONSENT)

for path, contents in staged.items():
    (mobile / path).write_text(contents)
print(json.dumps({"modifiedMobilePaths": list(staged)}))
