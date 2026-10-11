#!/usr/bin/env python3
"""Inject the measurement probes into a Boardsesh checkout. See docs/mobile-visible-performance.md.

    apply_probes.py <repo-root> [--settle-consent] [--keep-offline-boards]

Every edit is an exact-text replacement and asserts that its anchor occurs once,
so a probe point that has moved fails loudly instead of silently measuring
nothing. Re-fit the anchor when that happens; the probe's purpose is in the doc.

Never commit the result. Undo:
    git checkout -- packages/mobile && rm -f packages/mobile/src/lib/perf-probe.ts

--settle-consent       Do not show the analytics consent prompt in this build.
                       Consent stays undecided, so analytics stay off. Without
                       it a fresh install waits on the prompt, and answering it
                       records a decision against the signed-in account.
--keep-offline-boards  Ignore the privacy stream in this build. The server sends
                       one PrivacyChanged event per subscribe (every launch), and
                       each one drops every offline board's checkpoints (#6306),
                       so the downloaded board is re-crawled between runs.
"""
import os, sys

args = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
flags = {arg for arg in sys.argv[1:] if arg.startswith("--")}
unknown = flags - {"--settle-consent", "--keep-offline-boards"}
if len(args) != 1 or unknown:
    sys.exit(__doc__)
root = args[0].rstrip("/")
M = root + "/packages/mobile/"
HERE = os.path.dirname(os.path.abspath(__file__))


def edit(path, pairs):
    text = open(M + path).read()
    for old, new in pairs:
        assert text.count(old) == 1, (path, old[:60], text.count(old))
        text = text.replace(old, new)
    open(M + path, "w").write(text)


open(M + "src/lib/perf-probe.ts", "w").write(open(os.path.join(HERE, "perf-probe.ts.template")).read())

PROBE_IMPORT = "import { PERF_PROBE_ENABLED, perfNow, perfProbe } from '../lib/perf-probe';\n"
hook = "src/hooks/use-native-climb-render.ts"
text = open(M + hook).read()
first_import = text.index("import ")
open(M + hook, "w").write(text[:first_import] + PROBE_IMPORT + text[first_import:])
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
            configLength: 0,
          });
        }
"""),
("""  const latestCacheKeyRef = useRef(currentCacheKey);
  latestCacheKeyRef.current = currentCacheKey;
""",
"""  const latestCacheKeyRef = useRef(currentCacheKey);
  latestCacheKeyRef.current = currentCacheKey;
  const overlayWaitProbeRef = useRef<{ key: string; seenAtMs: number; indexHit: boolean; painted: boolean } | null>(
    null,
  );
  if (PERF_PROBE_ENABLED && flatFrames && overlayWaitProbeRef.current?.key !== currentCacheKey) {
    const previousWait = overlayWaitProbeRef.current;
    if (previousWait && !previousWait.painted) {
      perfProbe('overlay-missed', {
        surface: playSurface ? 'play' : prefetch ? 'prefetch' : filledStyle ? 'thumbnail' : 'full',
        shownMs: Math.round(perfNow() - previousWait.seenAtMs),
        indexHit: previousWait.indexHit,
      });
    }
    overlayWaitProbeRef.current = {
      key: currentCacheKey,
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
          });
        }
      }
"""),
("  onOverlayLoad: (loadKey: string | null) => void;", "  onOverlayLoad: (loadKey: string | null, cacheType?: string) => void;"),
])

layered_text = open(M + "src/components/LayeredClimbImage.tsx").read()
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
("""          allowDownscaling={false}
        />
      ))}""", """          allowDownscaling={false}
          onLoad={PERF_PROBE_ENABLED ? reportBackgroundLoad : undefined}
        />
      ))}"""),
("          onLoad={() => {",
 "          onLoad={(event: ImageLoadEventData) => {\n            perfProbe('overlay-shown', { gated: GATED_EXPR, cacheType: event.cacheType, play: overlayTestID != null });"),
("            onOverlayLoad?.(emittingLoadKey);", "            onOverlayLoad?.(emittingLoadKey, event.cacheType);"),
])

layered_text = open(M + "src/components/LayeredClimbImage.tsx").read()
open(M + "src/components/LayeredClimbImage.tsx", "w").write(layered_text.replace("GATED_EXPR", GATED))

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
        inputLength: 0,
        sort: `${String(searchInput.sortBy)}:${searchInput.boardName}/${searchInput.layoutId}/${searchInput.sizeId}@${searchInput.angle}`,
      });
      return response;
    },
"""),
("import { useGradeSourceSearchInput } from './search-grade-source';\n",
 "import { useGradeSourceSearchInput } from './search-grade-source';\nimport { perfNow, perfProbe } from '../../perf-probe';\n"),
])

text = open(M + "app/(tabs)/climbs/index.tsx").read()
press_start = text.index("  const handleClimbPress = useCallback(")
guard = "      if (isPlaceholderDataRef.current) return;\n"
guard_at = text.index(guard, press_start)
text = text[:guard_at + len(guard)] + "      perfProbe('climb-press');\n" + text[guard_at + len(guard):]
skeleton_import = "import { ClimbListRowSkeleton } from '../../../src/components/ClimbListRowSkeleton';\n"
assert text.count(skeleton_import) == 1
text = text.replace(skeleton_import, skeleton_import + "import { perfProbe } from '../../../src/lib/perf-probe';\n")
open(M + "app/(tabs)/climbs/index.tsx", "w").write(text)

edit("app/play.tsx", [
("""  useEffect(() => {
    const handle = requestAnimationFrame(() => setContentMounted(true));""",
 """  useEffect(() => {
    perfProbe('play-route-mounted');
    const handle = requestAnimationFrame(() => setContentMounted(true));"""),
])
text = open(M + "app/play.tsx").read()
first_import = text.index("import ")
open(M + "app/play.tsx", "w").write(text[:first_import] + "import { perfProbe } from '../src/lib/perf-probe';\n" + text[first_import:])

edit("src/components/play-drawer/SwipeBoardCarousel.tsx", [
("""  const isScreenshotMode = process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1';
""",
 """  const isScreenshotMode = process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1';
  const probeBoardMeasured = boardBox != null;
  useEffect(() => {
    perfProbe(probeBoardMeasured ? 'play-board-measured' : 'play-carousel-mounted');
  }, [probeBoardMeasured]);
"""),
])
text = open(M + "src/components/play-drawer/SwipeBoardCarousel.tsx").read()
first_import = text.index("import ")
open(M + "src/components/play-drawer/SwipeBoardCarousel.tsx", "w").write(text[:first_import] + "import { perfProbe } from '../../lib/perf-probe';\n" + text[first_import:])

edit("src/lib/graphql/offline-request.ts", [
("""      localDb = getDatabaseHandle();
""",
"""      localDb = getDatabaseHandle();
      if (PERF_PROBE_ENABLED && variables !== undefined) {
        const probeGateStartedAtMs = perfNow();
        const probeCatalog = localDb ? await canReadPrivateCatalog(localDb) : false;
        const probeCanServe = localDb && probeCatalog ? await operation.canServeLocal(localDb, variables as never) : false;
        perfProbe('offline-gate', {
          surface: String(operation.surface),
          allowed: localAllowed(),
          hasDb: localDb != null,
          catalog: probeCatalog,
          canServe: probeCanServe === true,
          online: isOnline,
          gateMs: Math.round(perfNow() - probeGateStartedAtMs),
        });
      }
"""),
("""        const localResponse = (await operation.resolveLocal(localDb, variables as never)) as TResponse;
""",
"""        const probeLocalStartedAtMs = perfNow();
        const localResponse = (await operation.resolveLocal(localDb, variables as never)) as TResponse;
        perfProbe('offline-request', {
          lane: 'local',
          surface: String(operation.surface),
          ms: Math.round(perfNow() - probeLocalStartedAtMs),
        });
"""),
("""    const networkResponse = await getHttpClient().request<TResponse>(document, sentVariables);
""",
"""    const probeNetworkStartedAtMs = perfNow();
    const networkResponse = await getHttpClient().request<TResponse>(document, sentVariables);
    if (operation) {
      perfProbe('offline-request', {
        lane: 'network',
        surface: String(operation.surface),
        ms: Math.round(perfNow() - probeNetworkStartedAtMs),
        engine: isOfflineEngineEnabled(),
        online: onlineManager.isOnline(),
      });
    }
"""),
])
text = open(M + "src/lib/graphql/offline-request.ts").read()
first_import = text.index("import ")
open(M + "src/lib/graphql/offline-request.ts", "w").write(text[:first_import] + "import { PERF_PROBE_ENABLED, perfNow, perfProbe } from '../perf-probe';\n" + text[first_import:])

KEEP_OFFLINE_BOARDS = [
("""        next: revokeSnapshots,
        // A lost privacy stream invalidates displayed protected material too.
        error: revokeSnapshots,""",
"""        next: () => perfProbe('privacy-event-skipped', { kind: 'next' }),
        error: () => perfProbe('privacy-event-skipped', { kind: 'error' }),"""),
("import { reportHandledError } from '../../lib/error-reporting';\n",
 "import { reportHandledError } from '../../lib/error-reporting';\nimport { perfProbe } from '../../lib/perf-probe';\n"),
]
if "--keep-offline-boards" in flags:
    edit("src/components/privacy/PrivacySyncBridge.tsx", KEEP_OFFLINE_BOARDS)

SETTLE_CONSENT = [
("""    if (killed || process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') {
      updateConsentState({ settled: true });""",
 """    // MEASUREMENT BUILD ONLY. Leaves consent undecided (analytics off).
    if (killed || process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' || process.env.EXPO_PUBLIC_PERF_PROBE === '1') {
      updateConsentState({ settled: true });"""),
]
if "--settle-consent" in flags:
    edit("src/components/onboarding/ConsentGate.tsx", SETTLE_CONSENT)

print("probes applied to", root)
