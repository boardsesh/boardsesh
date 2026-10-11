#!/usr/bin/env python3
"""Add comparable opening-readiness probes AFTER apply_probes.py.

Usage: apply_opening_probes.py <isolated-repo-root>

Supports the pinned 8b842c4950 baseline and the PlayCore candidate. All anchors
assert exactly once; all changes are staged before any file is written. Never
apply to an uncommitted implementation checkout. Never ship injected sources.
"""
import json
from pathlib import Path
import sys

if len(sys.argv) != 2:
    sys.exit(__doc__)
mobile = Path(sys.argv[1]).resolve() / "packages/mobile"
staged = {}


def read(path):
    return staged.get(path, (mobile / path).read_text())


def replace(path, old, new):
    source = read(path)
    assert source.count(old) == 1, (path, old[:80], source.count(old))
    staged[path] = source.replace(old, new)


def add_import(path, statement):
    source = read(path)
    assert statement not in source, (path, "already instrumented")
    first = source.index("import ")
    staged[path] = source[:first] + statement + "\n" + source[first:]


candidate = (mobile / "src/components/play-drawer/PlayCore.tsx").exists()
probe = "src/lib/perf-probe.ts"
assert "export function perfProbeUi" in read(probe), "Apply standard probes first"
assert "probeOpeningTap" not in read(probe), "Opening probes already applied"
staged[probe] = read(probe) + r'''

// Opening-only diagnostic identity. Raw names, holds, file paths and UUIDs stay
// on the device; the event payloads contain hashes and timings only.
let openingTapSequence = 0;
let openingTarget: { tapId: number; climb: string; frames: string; nonce: number | null } | null = null;
type OpeningArtHint = { quality: string; overlayCacheKey: string; overlayUri: string; overlayGeneration: number };
export function probeOpeningTap(climbUuid: string, frames: string, artwork?: OpeningArtHint): void {
  if (!PERF_PROBE_ENABLED) return;
  openingTarget = { tapId: ++openingTapSequence, climb: perfProbeId(climbUuid), frames: perfProbeId(frames), nonce: null };
  perfProbe('climb-press', {
    ...openingTarget,
    snapshotQuality: artwork?.quality ?? null,
    snapshotKey: artwork ? perfProbeId(artwork.overlayCacheKey) : null,
    snapshotUri: artwork ? perfProbeId(artwork.overlayUri) : null,
    snapshotGeneration: artwork?.overlayGeneration ?? null,
  });
}
export function probeOpeningTarget(nonce: number, climbUuid: string, frames: string): void {
  if (!PERF_PROBE_ENABLED || openingTarget?.climb !== perfProbeId(climbUuid)) return;
  if (openingTarget.nonce === nonce) return;
  openingTarget.nonce = nonce;
  perfProbe('play-opening-target', { ...openingTarget, frames: perfProbeId(frames) });
}
export function probeOpeningDetail(frames: string): { tapId: number | null; nonce: number | null; frames: string } {
  const frameId = perfProbeId(frames);
  return { frames: frameId, tapId: openingTarget?.frames === frameId ? openingTarget.tapId : null,
    nonce: openingTarget?.frames === frameId ? openingTarget.nonce : null };
}
'''

# Observe index mutations, rather than copying/scanning the whole index on a
# tap. Reconstruct the actual render key's state at the tap from this journal.
index = "src/lib/overlay-index.ts"
add_import(index, "import { perfProbe, perfProbeId } from './perf-probe';")
replace(index, "  const entry = { uri, generation: nextOverlayGeneration };", """  const entry = { uri, generation: nextOverlayGeneration };
  perfProbe('overlay-index-write', { key: perfProbeId(cacheKey), uri: perfProbeId(uri), generation: entry.generation });""")
replace(index, "function dropKey(cacheKey: string): boolean {", """function dropKey(cacheKey: string): boolean {
  perfProbe('overlay-index-drop', { key: perfProbeId(cacheKey) });""")
replace(index, "export function clearOverlayIndex(): void {", """export function clearOverlayIndex(): void {
  perfProbe('overlay-index-clear');""")

climbs = "app/(tabs)/climbs/index.tsx"
add_import(climbs, "import { probeOpeningTap } from '../../../src/lib/perf-probe';")
replace(climbs, "      perfProbe('climb-press');", "      probeOpeningTap(climb.uuid, climb.frames" + (", readyBoardArt" if candidate else "") + ");")

route = "app/play.tsx"
add_import(route, "import { probeOpeningTarget } from '../src/lib/perf-probe';")
replace(route, "  const playTargetNonce = playTarget?.nonce;", """  const playTargetNonce = playTarget?.nonce;
  // Correlation only, not a commit metric: child passive effects run before
  // this route's effects and may schedule the first UI geometry marker.
  if (playTarget) probeOpeningTarget(playTarget.nonce, playTarget.climb.uuid, playTarget.climb.frames);""")

hook = "src/hooks/use-native-climb-render.ts"
add_import(hook, "import { probeOpeningDetail } from '../lib/perf-probe';")
replace(hook, "  overlayUri: string | null;", "  probeOverlayCacheKey: string;\n  overlayUri: string | null;")
return_anchor = "  return {\n    artworkIdentity," if candidate else "  return {\n    overlayUri,"
replace(hook, return_anchor, return_anchor.replace("  return {\n", "  return {\n    probeOverlayCacheKey: currentCacheKey,\n"))
replace(hook, "  const currentBoardKey = useMemo(", """  useEffect(() => {
    if (!PERF_PROBE_ENABLED || !playSurface) return;
    const entry = getRenderedOverlay(currentCacheKey);
    perfProbe('play-overlay-selected', {
      ...probeOpeningDetail(frames), key: perfProbeId(currentCacheKey),
      uri: entry ? perfProbeId(entry.uri) : null, generation: entry?.generation ?? null,
      renderWidth: renderWidth ?? null,
    });
  }, [playSurface, currentCacheKey, frames, renderWidth]);
  const currentBoardKey = useMemo(""")

board = "src/components/BoardImageNative.tsx"
add_import(board, "import { perfProbe, perfProbeId, probeOpeningDetail } from '../lib/perf-probe';")
replace(board, "  const {\n    overlayUri,", "  const {\n    probeOverlayCacheKey,\n    overlayUri,")
if candidate:
    # The owner callback below stamps the nonce. This separate native-image
    # event supplies the exact full render key/URI used by the visible stack.
    replace(board, "            if (!bridging) onReadyArtDisplayed?.(displayedArt);", """            if (!bridging) {
              if (playSurface) perfProbe('play-full-art-displayed-native', {
                ...probeOpeningDetail(frames), key: perfProbeId(probeOverlayCacheKey),
                uri: perfProbeId(overlayUri), loadKey: perfProbeId(loadKey), generation: loadKey ? Number(loadKey.split(':')[0]) : null,
                quality: 'full', source: 'onDisplay',
              });
              onReadyArtDisplayed?.(displayedArt);
            }""")
    replace(board, "      liveArtRef.current.onReadyArtDisplayed?.(pending.art);", """      if (playSurface) perfProbe('play-full-art-displayed-native', {
        ...probeOpeningDetail(pending.art.frames), key: perfProbeId(probeOverlayCacheKey),
        uri: perfProbeId(pending.art.overlayUri), loadKey: perfProbeId(pending.art.overlayLoadKey),
        generation: pending.art.overlayLoadKey ? Number(pending.art.overlayLoadKey.split(':')[0]) : null,
        quality: 'full', source: 'bridge-visibility-commit',
      });
      liveArtRef.current.onReadyArtDisplayed?.(pending.art);""")
    core = "src/components/play-drawer/PlayCore.tsx"
    add_import(core, "import { perfProbe, perfProbeId, probeOpeningDetail } from '../../lib/perf-probe';")
    replace(core, "                            currentFrames={displayedClimb.frames}", """                            onReadyArtDisplayed={(art) => perfProbe('play-full-art-displayed', {
                              ...probeOpeningDetail(art.frames), nonce: openTarget?.nonce ?? null,
                              climb: perfProbeId(displayedClimb.uuid), uri: perfProbeId(art.overlayUri), quality: 'full',
                            })}
                            currentFrames={displayedClimb.frames}""")
else:
    # Baseline observes native display without changing its onLoad reveal gate.
    # Observational callback is separate from shipping screenshot markers.
    replace(board, "        onOverlayLoad={onOverlayLoad}", """        onOverlayLoad={onOverlayLoad}
          onProbeArtDisplayed={(loadKey) => {
            if (!playSurface || !overlayUri || loadKey !== overlayLoadKey || (boardName === 'kilter' && backgroundPaths.length === 0)) return;
            perfProbe('play-full-art-displayed', {
              ...probeOpeningDetail(frames), key: perfProbeId(probeOverlayCacheKey),
              uri: perfProbeId(overlayUri), loadKey: perfProbeId(loadKey), generation: loadKey ? Number(loadKey.split(':')[0]) : null, quality: 'full', source: 'onDisplay',
            });
          }}""")
    layered = "src/components/LayeredClimbImage.tsx"
    replace(layered, "type LayeredClimbImageProps = {", """type LayeredClimbImageProps = {
  onProbeArtDisplayed?: (loadKey: string | null) => void;""")
    replace(layered, "  onOverlayLoad,", "  onOverlayLoad,\n  onProbeArtDisplayed,")
    replace(layered, "  const hidden = isBackgrounded || !boardArtVisible;", """  const hidden = isBackgrounded || !boardArtVisible;
  const probeVisibilityRef = useRef({ hidden, epoch: 0 });
  if (probeVisibilityRef.current.hidden !== hidden)
    probeVisibilityRef.current = { hidden, epoch: probeVisibilityRef.current.epoch + 1 };
  const probeAttempt = JSON.stringify([overlayUri, overlayLoadKey, backgroundPaths, recyclingKey, probeVisibilityRef.current.epoch]);
  const probeDisplayedRef = useRef({ attempt: probeAttempt, backgrounds: new Set<string>(), overlay: false, reported: false });
  if (probeDisplayedRef.current.attempt !== probeAttempt)
    probeDisplayedRef.current = { attempt: probeAttempt, backgrounds: new Set<string>(), overlay: false, reported: false };
  const probeReportRef = useRef<() => void>(() => {});
  const probeConcealedAttemptRef = useRef<string | null>(null);
  const probeVisibleAttemptRef = useRef<string | null>(null);""")
    replace(layered, "  if (hidden) {", """  probeReportRef.current = () => {
    const current = probeDisplayedRef.current;
    if (hidden || awaitingOverlay || current.attempt !== probeAttempt || current.reported ||
        (probeConcealedAttemptRef.current === probeAttempt && probeVisibleAttemptRef.current !== probeAttempt) ||
        !current.overlay || missingBackgroundCount > 0 || backgroundPaths.some((path) => !current.backgrounds.has(path))) return;
    current.reported = true;
    onProbeArtDisplayed?.(overlayLoadKey ?? null);
  };
  if (awaitingOverlay) probeConcealedAttemptRef.current = probeAttempt;
  useEffect(() => {
    if (hidden || awaitingOverlay) return;
    if (probeConcealedAttemptRef.current !== probeAttempt) {
      probeReportRef.current();
      return;
    }
    // Match the candidate bridge's visibility accounting: the native opacity
    // commit follows the JS reveal state, so do not publish from that effect.
    const visibilityFrame = requestAnimationFrame(() => {
      if (probeDisplayedRef.current.attempt !== probeAttempt) return;
      probeVisibleAttemptRef.current = probeAttempt;
      probeReportRef.current();
    });
    return () => cancelAnimationFrame(visibilityFrame);
  }, [probeAttempt, hidden, awaitingOverlay]);
  if (hidden) {""")
    replace(layered, "          onLoad={PERF_PROBE_ENABLED ? reportBackgroundLoad : undefined}", """          onLoad={PERF_PROBE_ENABLED ? reportBackgroundLoad : undefined}
          onDisplay={() => {
            if (probeDisplayedRef.current.attempt !== probeAttempt || hidden) return;
            probeDisplayedRef.current.backgrounds.add(path);
            probeReportRef.current();
          }}""")
    replace(layered, "          onError={(event) => onOverlayError?.(event, overlayLoadKey ?? null)}", """          onDisplay={() => {
            if (probeDisplayedRef.current.attempt !== probeAttempt || hidden) return;
            probeDisplayedRef.current.overlay = true;
            probeReportRef.current();
          }}
          onError={(event) => onOverlayError?.(event, overlayLoadKey ?? null)}""")

carousel = "src/components/play-drawer/SwipeBoardCarousel.tsx"
add_import(carousel, "import { runOnUI } from 'react-native-reanimated';")
add_import(carousel, "import { PERF_PROBE_ENABLED, perfProbeUi, probeOpeningDetail } from '../../lib/perf-probe';")
gesture_condition = "gesturesEnabled" if candidate else "enabled && boardBox != null"
replace(carousel, "  const boardSurfaceAnchor = useShowcaseAnchor('board-surface');", """  useEffect(() => {
    if (!PERF_PROBE_ENABLED || !(GESTURE_CONDITION) || !boardBox) return;
    const detail = { ...probeOpeningDetail(currentFrames), width: boardBox.width, height: boardBox.height,
      recognizerConfirmed: false };
    runOnUI(() => { 'worklet'; perfProbeUi('play-gesture-geometry-committed-ui', detail); })();
  }, [currentFrames, enabled, boardBox]);
  const boardSurfaceAnchor = useShowcaseAnchor('board-surface');""".replace("GESTURE_CONDITION", gesture_condition))

for path, source in staged.items():
    (mobile / path).write_text(source)
print(json.dumps({ "variant": "candidate" if candidate else "baseline", "modifiedMobilePaths": list(staged) }))
