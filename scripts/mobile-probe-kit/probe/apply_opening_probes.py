#!/usr/bin/env python3
"""Add comparable opening-readiness probes AFTER apply_probes.py.

Usage: apply_opening_probes.py <isolated-repo-root>

Supports the pinned 8b842c4950 baseline, the historical PlayCore candidate,
and current nullable-local/abortable-network checkouts. All anchors must occur
exactly once; all changes are staged before any file is written. Never
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
    return staged[path] if path in staged else (mobile / path).read_text()


def replace(path, old, new):
    source = read(path)
    count = source.count(old)
    if count != 1:
        raise ValueError(f"{path}: expected exactly one anchor {old[:80]!r}; found {count}")
    staged[path] = source.replace(old, new, 1)


def add_import(path, statement):
    source = read(path)
    if statement in source:
        raise ValueError(f"{path}: already instrumented import {statement!r}")
    first = source.find("import ")
    if first < 0:
        raise ValueError(f"{path}: missing import anchor")
    staged[path] = source[:first] + statement + "\n" + source[first:]


candidate = (mobile / "src/components/play-drawer/PlayCore.tsx").exists()
probe = "src/lib/perf-probe.ts"
if not (mobile / probe).exists() or read(probe).count("export function perfProbeUi(") != 1:
    raise ValueError(f"{probe}: apply standard probes first (expected one perfProbeUi anchor)")
if "probeOpeningTap" in read(probe):
    raise ValueError(f"{probe}: opening probes already applied")
staged[probe] = read(probe) + r'''

import { createContext, useContext, useEffect, useRef } from 'react';
import { useNavigation } from 'expo-router';

type OpeningProbeOwner = { id: number; translateY: SharedValue<number> };
export const OpeningProbeRouteContext = createContext<OpeningProbeOwner | null>(null);
let openingOwnerSequence = 0;
const retiredOpeningOwners = new Set<number>();
export function useOpeningProbeOwner(): OpeningProbeOwner | null {
  return useContext(OpeningProbeRouteContext);
}
export function useOpeningProbeRouteOwner(translateY: SharedValue<number>): OpeningProbeOwner {
  const ownerRef = useRef<OpeningProbeOwner | null>(null);
  if (!ownerRef.current) ownerRef.current = { id: ++openingOwnerSequence, translateY };
  const owner = ownerRef.current;
  const navigation = useNavigation();
  useEffect(() => {
    let mounted = true;
    let removalAttempt = 0;
    const unsubscribe = navigation.addListener('beforeRemove', (event) => {
      const attempt = ++removalAttempt;
      retiredOpeningOwners.add(owner.id);
      queueMicrotask(() => {
        if (mounted && removalAttempt === attempt && event.defaultPrevented)
          retiredOpeningOwners.delete(owner.id);
      });
    });
    return () => { mounted = false; retiredOpeningOwners.add(owner.id); unsubscribe(); };
  }, [navigation, owner]);
  return owner;
}

// Opening-only diagnostic identity. Raw names, holds, file paths and UUIDs stay
// on the device; the event payloads contain hashes and timings only.
let openingTapSequence = 0;
let openingTarget: { tapId: number; climb: string; frames: string; nonce: number | null; routeOwnerId: number | null } | null = null;
type OpeningArtHint = { quality: string; overlayCacheKey: string; overlayUri: string; overlayGeneration: number };
export function probeOpeningTap(climbUuid: string, frames: string, artwork?: OpeningArtHint): void {
  if (!PERF_PROBE_ENABLED) return;
  openingTarget = { tapId: ++openingTapSequence, climb: perfProbeId(climbUuid), frames: perfProbeId(frames), nonce: null, routeOwnerId: null };
  perfProbe('climb-press', {
    ...openingTarget,
    snapshotQuality: artwork?.quality ?? null,
    snapshotKey: artwork ? perfProbeId(artwork.overlayCacheKey) : null,
    snapshotUri: artwork ? perfProbeId(artwork.overlayUri) : null,
    snapshotGeneration: artwork?.overlayGeneration ?? null,
  });
}
export function probeOpeningTarget(owner: OpeningProbeOwner, nonce: number, climbUuid: string, frames: string): void {
  if (!PERF_PROBE_ENABLED || retiredOpeningOwners.has(owner.id) || openingTarget?.climb !== perfProbeId(climbUuid)) return;
  if (openingTarget.nonce === nonce && openingTarget.routeOwnerId === owner.id) return;
  openingTarget.nonce = nonce;
  openingTarget.routeOwnerId = owner.id;
  perfProbe('play-opening-target', { ...openingTarget, frames: perfProbeId(frames) });
}
export function probeOpeningDetail(frames: string, owner: OpeningProbeOwner | null): { tapId: number | null; nonce: number | null; frames: string; routeOwnerId: number | null } {
  const frameId = perfProbeId(frames);
  const target = openingTarget;
  const matching = owner && !retiredOpeningOwners.has(owner.id) && target?.routeOwnerId === owner.id && target.frames === frameId;
  return { frames: frameId, routeOwnerId: owner?.id ?? null, tapId: matching ? target.tapId : null,
    nonce: matching ? target.nonce : null };
}
export function probeOpeningRejected(climbUuid: string, reason: string, loadedCount: number | null = null): void {
  if (!PERF_PROBE_ENABLED || openingTarget?.climb !== perfProbeId(climbUuid)) return;
  perfProbe('climb-open-rejected', { ...openingTarget, reason, loadedCount });
}
function recordOpeningGeometry(detail: PerfProbeDetail): void {
  const target = openingTarget;
  if (!target || typeof detail.routeOwnerId !== 'number' || retiredOpeningOwners.has(detail.routeOwnerId) ||
      detail.routeOwnerId !== target.routeOwnerId || detail.tapId !== target.tapId || detail.nonce !== target.nonce) return;
  perfProbe('play-gesture-geometry-committed-ui', detail);
}
export function probeOpeningGeometryUi(detail: PerfProbeDetail): void {
  'worklet';
  if (PERF_PROBE_ENABLED) runOnJS(recordOpeningGeometry)({ ...detail, uiWallMs: Date.now() });
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
add_import(climbs, "import { probeOpeningTap, probeOpeningRejected } from '../../../src/lib/perf-probe';")
replace(climbs, "      perfProbe('climb-press');", "      probeOpeningTap(climb.uuid, climb.frames" + (", readyBoardArt" if candidate else "") + ");")
replace(climbs, "        perfProbe('climb-open-rejected', { reason: 'placeholder-results' });",
        "        probeOpeningRejected(climb.uuid, 'placeholder-results');")

if candidate:
    activation = "src/lib/playlists/use-playlist-activation.ts"
    add_import(activation, "import { probeOpeningRejected } from '../perf-probe';")
    legacy_guard = "      if (!loadedSnapshotCurrent || privacyGeneration !== getPrivacyRevocationGeneration()) return Promise.resolve();"
    single_guards = [
        "      if (privacyGeneration !== getPrivacyRevocationGeneration()) return Promise.resolve();",
        "      if (credentialGeneration !== getCredentialGeneration()) return Promise.resolve();",
    ]
    guard_counts = [read(activation).count(anchor) for anchor in [legacy_guard, *single_guards]]
    if sum(guard_counts) != 1:
        raise ValueError(f"{activation}: expected exactly one supported activation guard; found {guard_counts}")
    if guard_counts[0] == 1:
        replace(activation,
            "      if (!loadedSnapshotCurrent || privacyGeneration !== getPrivacyRevocationGeneration()) return Promise.resolve();",
            """      if (!loadedSnapshotCurrent || privacyGeneration !== getPrivacyRevocationGeneration()) {
        probeOpeningRejected(requestedClimb.uuid,
          !loadedSnapshotCurrent ? 'withdrawn-loaded-snapshot' : 'stale-activation-scope', suppliedClimbs.length);
        return Promise.resolve();
      }""")
        replace(activation,
            "      if (capturedGeneration !== undefined && capturedGeneration !== privacyGeneration) return Promise.resolve();",
            """      if (capturedGeneration !== undefined && capturedGeneration !== privacyGeneration) {
        probeOpeningRejected(requestedClimb.uuid, 'stale-row-object', suppliedClimbs.length);
        return Promise.resolve();
      }""")
        replace(activation,
            "      if (!loadedClimb && initialPrivacyGeneration.current !== privacyGeneration) return Promise.resolve();",
            """      if (!loadedClimb && initialPrivacyGeneration.current !== privacyGeneration) {
        probeOpeningRejected(requestedClimb.uuid, 'row-not-reauthorized', suppliedClimbs.length);
        return Promise.resolve();
      }""")

    else:
        if "capturedGeneration !== undefined" in read(activation) or "initialPrivacyGeneration.current !== privacyGeneration" in read(activation):
            raise ValueError(f"{activation}: unsupported mixed activation guards")
        guard = single_guards[guard_counts[1:].index(1)]
        replace(activation, guard,
            guard.replace(" return Promise.resolve();", """ {
        probeOpeningRejected(requestedClimb.uuid, 'stale-activation-scope', allClimbs.length);
        return Promise.resolve();
      }"""))

route = "app/play.tsx"
add_import(route, "import { OpeningProbeRouteContext, useOpeningProbeRouteOwner, probeOpeningTarget } from '../src/lib/perf-probe';")
serving_condition = "playTarget && canConsumeTarget(playTarget.nonce)" if "canConsumeTarget" in read(route) else "playTarget"
replace(route, "  const queueSheetRef = useRef<QueueSheetHandle>(null);", """  const probeOwner = useOpeningProbeRouteOwner(swipeDismiss.translateY);
  // Correlation only, not a commit metric: child passive effects run before
  // this route's effects and may schedule the first UI geometry marker.
  if (SERVING_CONDITION) probeOpeningTarget(probeOwner, playTarget.nonce, playTarget.climb.uuid, playTarget.climb.frames);
  const queueSheetRef = useRef<QueueSheetHandle>(null);""".replace("SERVING_CONDITION", serving_condition))
replace(route, "    <Link.AppleZoomTarget>", "    <OpeningProbeRouteContext.Provider value={probeOwner}>\n    <Link.AppleZoomTarget>")
replace(route, "    </Link.AppleZoomTarget>", "    </Link.AppleZoomTarget>\n    </OpeningProbeRouteContext.Provider>")

hook = "src/hooks/use-native-climb-render.ts"
add_import(hook, "import { probeOpeningDetail, useOpeningProbeOwner } from '../lib/perf-probe';")
replace(hook, "  overlayUri: string | null;", "  probeOverlayCacheKey: string;\n  overlayUri: string | null;")
return_anchor = "  return {\n    artworkIdentity," if candidate else "  return {\n    overlayUri,"
replace(hook, return_anchor, return_anchor.replace("  return {\n", "  return {\n    probeOverlayCacheKey: currentCacheKey,\n"))
replace(hook, "  const currentBoardKey = useMemo(", """  const probeOwner = useOpeningProbeOwner();
  useEffect(() => {
    if (!PERF_PROBE_ENABLED || !playSurface) return;
    const entry = getRenderedOverlay(currentCacheKey);
    perfProbe('play-overlay-selected', {
      ...probeOpeningDetail(frames, probeOwner), key: perfProbeId(currentCacheKey),
      uri: entry ? perfProbeId(entry.uri) : null, generation: entry?.generation ?? null,
      renderWidth: renderWidth ?? null,
    });
  }, [playSurface, currentCacheKey, frames, renderWidth]);
  const currentBoardKey = useMemo(""")

board = "src/components/BoardImageNative.tsx"
add_import(board, "import { perfProbe, perfProbeId, probeOpeningDetail, useOpeningProbeOwner } from '../lib/perf-probe';")
replace(board, "  const {\n    overlayUri,", "  const probeOwner = useOpeningProbeOwner();\n  const {\n    overlayUri,")
replace(board, "  const {\n    overlayUri,", "  const {\n    probeOverlayCacheKey,\n    overlayUri,")
if candidate:
    # The owner callback below stamps the nonce. This separate native-image
    # event supplies the exact full render key/URI used by the visible stack.
    replace(board, "            if (!bridging) onReadyArtDisplayed?.(displayedArt);", """            if (!bridging) {
              if (playSurface) perfProbe('play-full-art-displayed-native', {
                ...probeOpeningDetail(frames, probeOwner), key: perfProbeId(probeOverlayCacheKey),
                uri: perfProbeId(overlayUri), loadKey: perfProbeId(loadKey), generation: loadKey ? Number(loadKey.split(':')[0]) : null,
                quality: 'full', source: 'onDisplay',
              });
              onReadyArtDisplayed?.(displayedArt);
        }""")
    replace(board, "      liveArtRef.current.onReadyArtDisplayed?.(pending.art);", """      if (playSurface) perfProbe('play-full-art-displayed-native', {
        ...probeOpeningDetail(pending.art.frames, probeOwner), key: perfProbeId(probeOverlayCacheKey),
        uri: perfProbeId(pending.art.overlayUri), loadKey: perfProbeId(pending.art.overlayLoadKey),
        generation: pending.art.overlayLoadKey ? Number(pending.art.overlayLoadKey.split(':')[0]) : null,
        quality: 'full', source: 'bridge-visibility-commit',
      });
      liveArtRef.current.onReadyArtDisplayed?.(pending.art);""")
    core = "src/components/play-drawer/PlayCore.tsx"
    add_import(core, "import { perfProbe, perfProbeId, probeOpeningDetail, useOpeningProbeOwner } from '../../lib/perf-probe';")
    replace(core, "  const isAnonymous = viewer === 'anonymous';", "  const probeOwner = useOpeningProbeOwner();\n  const isAnonymous = viewer === 'anonymous';")
    replace(core, "                            currentFrames={displayedClimb.frames}", """                            onReadyArtDisplayed={(art) => perfProbe('play-full-art-displayed', {
                              ...probeOpeningDetail(art.frames, probeOwner), nonce: openTarget?.nonce ?? null,
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
              ...probeOpeningDetail(frames, probeOwner), key: perfProbeId(probeOverlayCacheKey),
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
legacy_reanimated_import = "import Animated, { useAnimatedStyle, type AnimatedStyle, type SharedValue } from 'react-native-reanimated';"
current_reanimated_import = """import Animated, {
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
  type AnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';"""
import_counts = [read(carousel).count(anchor) for anchor in [legacy_reanimated_import, current_reanimated_import]]
if sum(import_counts) != 1:
    raise ValueError(f"{carousel}: expected exactly one supported Reanimated import; found {import_counts}")
if import_counts[0] == 1:
    replace(carousel, legacy_reanimated_import, legacy_reanimated_import.replace("{ useAnimatedStyle", "{ runOnUI, useAnimatedStyle"))
add_import(carousel, "import { PERF_PROBE_ENABLED, probeOpeningGeometryUi, probeOpeningDetail, useOpeningProbeOwner } from '../../lib/perf-probe';")
gesture_condition = "gesturesEnabled" if candidate else "enabled && boardBox != null"
replace(carousel, "  const boardSurfaceAnchor = useShowcaseAnchor('board-surface');", """  const probeOwner = useOpeningProbeOwner();
  const probeRouteTranslation = probeOwner?.translateY;
  useEffect(() => {
    if (!PERF_PROBE_ENABLED || !(GESTURE_CONDITION) || !boardBox) return;
    const detail = { ...probeOpeningDetail(currentFrames, probeOwner), width: boardBox.width, height: boardBox.height,
      recognizerConfirmed: false };
    runOnUI(() => {
      'worklet';
      if (probeRouteTranslation && probeRouteTranslation.value !== 0) return;
      probeOpeningGeometryUi(detail);
    })();
  }, [currentFrames, enabled, boardBox]);
  const boardSurfaceAnchor = useShowcaseAnchor('board-surface');""".replace("GESTURE_CONDITION", gesture_condition))

for path, source in staged.items():
    (mobile / path).write_text(source)
print(json.dumps({ "variant": "candidate" if candidate else "baseline", "modifiedMobilePaths": list(staged) }))
