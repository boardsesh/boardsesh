// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

import { requireOptionalNativeModule } from 'expo-modules-core';
import { File } from 'expo-file-system';

/**
 * Shape of the native module. All fields are optional because we need
 * to bridge two binary generations:
 *
 *  - Marker-aware binaries export `renderHoldsOverlayWithMarkers`, which
 *    understands shape, brush, and size override fields in the config.
 *  - Overlay-only binaries export `renderHoldsOverlay`,
 *    which writes a transparent PNG containing only the hold markers.
 *  - Old binaries export `renderComposite`, which composites the holds on
 *    top of background images and writes a single combined PNG. Calling
 *    it with an empty `backgroundPaths` array produces the same
 *    transparent holds-only output we want from the new API.
 *
 * This shim lets a JS-only EAS OTA update reach testers without forcing
 * everyone to install a fresh native build first.
 */
type BoardRendererNativeModule = {
  renderHoldsOverlayWithMarkers?(configJson: string, cacheKey: string): Promise<string>;
  renderHoldsOverlay?(configJson: string, cacheKey: string): Promise<string>;
  renderComposite?(configJson: string, backgroundPaths: string[], cacheKey: string): Promise<string>;
};

// requireOptionalNativeModule returns null (silently) when the module
// isn't linked into the running binary — e.g. in Expo Go, or a dev
// client built before the native module was added. Using the throwing
// `requireNativeModule` here would log a noisy `Cannot find native
// module 'BoardRenderer'` error in the JS console even though the
// hook's fallback path handles it gracefully.
export const boardRendererNative = requireOptionalNativeModule<BoardRendererNativeModule>('BoardRenderer');
export const MARKER_RENDERER_UNAVAILABLE_MESSAGE =
  'Marker shape, size, and brush overrides require a rebuilt BoardRenderer native binary';
export const BOARDSESH_RENDERER_UNAVAILABLE_MESSAGE =
  'The Boardsesh render mode requires a rebuilt BoardRenderer native binary';

// Heuristic: does this error look like "the native binary doesn't actually
// implement this method"? Some Expo NativeModulesProxy configurations
// answer `typeof fn === 'function'` for any property, then throw at
// invocation time. We want to fall through to renderComposite in that
// case, but NOT swallow legitimate render errors (out of memory, invalid
// JSON, disk full, etc.) — those should propagate so the hook's catch
// can log them.
function looksLikeMissingNativeMethod(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!message) return false;
  return (
    /is not a function/i.test(message) ||
    /method not found/i.test(message) ||
    /unknown method/i.test(message) ||
    /no such method/i.test(message) ||
    /unimplemented/i.test(message)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonDefaultMultiplier(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value !== 1;
}

/**
 * Parse a render config once so both capability predicates below can read it.
 * A config that isn't valid JSON, or isn't an object, answers `null` — every
 * predicate then reads "no special capability needed" and the render goes down
 * the classic path, where the native side surfaces the real parse error.
 */
function parseRenderConfig(configJson: string): Record<string, unknown> | null {
  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(configJson);
  } catch {
    return null;
  }
  return isRecord(parsedConfig) ? parsedConfig : null;
}

/** Does this config ask for the Boardsesh drawing (issue #2202)? */
function configRequestsBoardseshMode(parsedConfig: Record<string, unknown> | null): boolean {
  return parsedConfig?.render_mode === 'aura';
}

function configRequiresModernRenderer(parsedConfig: Record<string, unknown> | null): boolean {
  if (!parsedConfig) return false;
  // stroke_width_multiplier is deliberately NOT a gate here (unlike
  // shape_size_multiplier below). renderHoldsOverlay and
  // renderHoldsOverlayWithMarkers call the identical native renderOverlay()
  // underneath (see BoardRendererModule.swift/.kt) — the "WithMarkers" name is
  // purely a JS-side capability signal for whether a binary is new enough to
  // trust, not a different render path. RenderConfig::stroke_width_multiplier
  // is a plain #[serde(default)] f32 with no `deny_unknown_fields` on the
  // struct (see board-renderer/core/src/types.rs), so on a binary that
  // predates the field entirely, serde just ignores the unrecognized JSON key
  // and renders at the built-in default — never a parse failure. Gating on it
  // would instead throw MARKER_RENDERER_UNAVAILABLE_MESSAGE unconditionally
  // (issue #2202: Grasshopper's board-level stroke default is now non-1.0
  // even with zero user overrides), leaving the overlay permanently blank on
  // any native binary that predates renderHoldsOverlayWithMarkers, instead of
  // falling back to the classic path and just rendering without the boost.
  if (isNonDefaultMultiplier(parsedConfig.shape_size_multiplier)) return true;

  const holdStateMap = parsedConfig.hold_state_map;
  if (!isRecord(holdStateMap)) return false;
  return Object.values(holdStateMap).some((stateInfo) => {
    if (!isRecord(stateInfo)) return false;
    return typeof stateInfo.shape === 'string' && stateInfo.shape !== 'circle';
  });
}

/**
 * The three-generation fallthrough, with no capability gate of its own: the
 * caller has already decided whether this config is safe for the binary in
 * hand. `requiresModernRenderer` is that decision for marker overrides.
 *
 * Split out of `renderHoldsOverlay` so `probeBoardseshRendererSupport` can
 * reach the native renderer without recursing through the Boardsesh gate that
 * the probe is what answers.
 */
async function renderThroughNative(
  configJson: string,
  cacheKey: string,
  requiresModernRenderer: boolean,
): Promise<string> {
  if (!boardRendererNative) {
    throw new Error('BoardRenderer native module is not available');
  }

  if (requiresModernRenderer) {
    if (typeof boardRendererNative.renderHoldsOverlayWithMarkers !== 'function') {
      throw new Error(MARKER_RENDERER_UNAVAILABLE_MESSAGE);
    }
    try {
      return await boardRendererNative.renderHoldsOverlayWithMarkers(configJson, cacheKey);
    } catch (error) {
      if (looksLikeMissingNativeMethod(error)) {
        throw new Error(MARKER_RENDERER_UNAVAILABLE_MESSAGE);
      }
      throw error;
    }
  }

  if (typeof boardRendererNative.renderHoldsOverlay === 'function') {
    // Fast path: typeof said it's a function. On most binaries this just
    // works. On binaries whose NativeModulesProxy lies about method
    // presence, the call throws synchronously or rejects — catch both
    // shapes and fall through to renderComposite only when the error
    // matches the "missing native method" pattern.
    try {
      return await boardRendererNative.renderHoldsOverlay(configJson, cacheKey);
    } catch (error) {
      if (!looksLikeMissingNativeMethod(error)) {
        // Real render failure (OOM, bad JSON, etc.) — propagate so the
        // hook's catch logs it.
        throw error;
      }
      // Fall through to renderComposite below.
    }
  }
  // TODO(remove): backwards-compat shim for the overlay-only refactor.
  //   WHY:   pre-refactor native binaries only export `renderComposite`,
  //          so a JS-only OTA update has to keep working on testers who
  //          haven't installed a fresh preview build yet.
  //   WHEN:  safe to delete once every active EAS preview channel
  //          (`preview-1` through `preview-4`) has been rebuilt onto a
  //          binary that exports `renderHoldsOverlay`.
  //   HOW:   run `vp dlx eas-cli@16 channel:view preview-N` for N=1..4 and
  //          confirm each channel's runtime version maps to a build SHA
  //          that postdates the overlay-only commit. Easiest path: run
  //          `vp run mobile:preview-build` for all four channels, then
  //          drop this branch + the `renderComposite` field on
  //          `BoardRendererNativeModule`.
  if (typeof boardRendererNative.renderComposite === 'function') {
    // Old binary path. Empty backgroundPaths means the host-side
    // compositor draws nothing under the overlay, so the resulting PNG
    // is the same transparent holds-only image the new API produces.
    return boardRendererNative.renderComposite(configJson, [], cacheKey);
  }
  throw new Error('BoardRenderer native module exposes no usable render function');
}

// ── Boardsesh capability probe (issue #2202) ───────────────────────────────
// A method name can't answer "does this binary understand render_mode" the way
// `renderHoldsOverlayWithMarkers` answered the marker question: RenderConfig has
// no `deny_unknown_fields`, and every Boardsesh field is `#[serde(default)]`
// (packages/board-renderer/core/src/types.rs), so a library built before the mode
// existed accepts the exact same config, ignores every key, and hands back a
// classic render. Silently. The only honest question is therefore behavioural —
// ask the library to draw something only the Boardsesh path can draw, and see
// whether it did.
//
// The probe is an 8x8 render with no holds and a fully opaque white veil. On a
// Boardsesh-capable library `paint_veil` fills the whole pixmap white (there are
// no lit silhouettes to punch out); on a stale one the veil key is dropped and
// the classic renderer produces the same empty transparent pixmap it produces
// for the classic config. Same config, two modes, two cache keys: different
// outputs means the mode is real.

const PROBE_CONFIG_BASE = {
  board_width: 8,
  board_height: 8,
  output_width: 8,
  frames: '',
  thumbnail: false,
  holds: [],
  hold_state_map: {},
} as const;

const CLASSIC_PROBE_CONFIG_JSON = JSON.stringify({ ...PROBE_CONFIG_BASE, render_mode: 'classic' });
const BOARDSESH_PROBE_CONFIG_JSON = JSON.stringify({
  ...PROBE_CONFIG_BASE,
  render_mode: 'aura',
  veil: { color: '#FFFFFF', opacity: 1 },
});

/**
 * Cache keys for one probe run.
 *
 * Unique per run, deliberately. The native modules key their on-disk PNG cache
 * by exactly this string and return the cached file untouched when it exists
 * (BoardRendererModule.swift / .kt), so a fixed key would let the PNGs a
 * PRE-upgrade launch wrote answer for the POST-upgrade library — a permanent
 * false negative that only a cache wipe would clear.
 *
 * The prefix keeps them out of the hook's warm-up scan too, which only adopts
 * files starting with the current `v<RENDERER_VERSION>_` (see
 * warmupRenderedOverlaysOnce in use-native-climb-render.ts) — and sweeps
 * anything else, which is a second safety net under the explicit delete below.
 */
function probeCacheKeys(): { classic: string; boardsesh: string } {
  const runId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
  return { classic: `boardsesh-probe-classic-${runId}`, boardsesh: `boardsesh-probe-veil-${runId}` };
}

/**
 * A comparable fingerprint of one probe render. The native modules return a
 * `file://` URI, so this reads the PNG back: size first (an opaque white 8x8 and
 * a fully transparent one differ there already) and the bytes behind it, so two
 * same-size-different-pixels outputs can never read as identical.
 *
 * `null` means "couldn't read it" — the probe treats that as unsupported rather
 * than guessing, since a Boardsesh render we can't verify is one we shouldn't
 * ship to the wall.
 */
async function readProbeFingerprint(uri: string): Promise<string | null> {
  try {
    const probeFile = new File(uri);
    if (!probeFile.exists) return null;
    return `${probeFile.size ?? -1}:${await probeFile.base64()}`;
  } catch {
    return null;
  }
}

/** Best-effort removal of a probe PNG from the overlay cache directory. */
function discardProbeOutput(uri: string): void {
  try {
    new File(uri).delete();
  } catch {
    // The next warm-up sweeps it: it carries no current-version prefix.
  }
}

let boardseshSupportProbe: Promise<boolean> | null = null;

async function runBoardseshSupportProbe(): Promise<boolean> {
  if (!boardRendererNative) return false;
  const probeOutputs: string[] = [];
  try {
    const keys = probeCacheKeys();
    // `false` for requiresModernRenderer: neither probe config carries a
    // shape_size_multiplier or a per-state `shape`, so the marker gate would
    // answer false anyway — and forcing the marker method would make an old
    // binary fail the probe for the wrong reason.
    probeOutputs.push(await renderThroughNative(CLASSIC_PROBE_CONFIG_JSON, keys.classic, false));
    probeOutputs.push(await renderThroughNative(BOARDSESH_PROBE_CONFIG_JSON, keys.boardsesh, false));

    const [classicFingerprint, boardseshFingerprint] = await Promise.all(probeOutputs.map(readProbeFingerprint));
    if (!classicFingerprint || !boardseshFingerprint) return false;
    return classicFingerprint !== boardseshFingerprint;
  } catch {
    // A render that fails outright (no native module, disk full, a binary with
    // no usable render function) is not a Boardsesh-capable one as far as this
    // session is concerned.
    return false;
  } finally {
    for (const uri of probeOutputs) discardProbeOutput(uri);
  }
}

/**
 * Does the native library in this binary actually implement the Boardsesh
 * render mode?
 *
 * Memoised for the JS runtime's lifetime: the answer is a property of the
 * linked binary, which cannot change without a relaunch, and the probe costs two
 * native round-trips plus two file reads. Concurrent callers share the one
 * in-flight promise, so the native side sees exactly two renders per launch.
 */
export function probeBoardseshRendererSupport(): Promise<boolean> {
  boardseshSupportProbe ??= runBoardseshSupportProbe();
  return boardseshSupportProbe;
}

/** Test-only handle: forget the memoised probe result so the next call re-runs it. */
export function _resetBoardseshProbeForTests(): void {
  boardseshSupportProbe = null;
}

export async function renderHoldsOverlay(configJson: string, cacheKey: string): Promise<string> {
  if (!boardRendererNative) {
    throw new Error('BoardRenderer native module is not available');
  }

  const parsedConfig = parseRenderConfig(configJson);

  // Boardsesh gate first, and only for Boardsesh configs: a classic config never
  // touches the probe, never waits on it, and reaches the native renderer with
  // byte-identical arguments to before this gate existed.
  if (configRequestsBoardseshMode(parsedConfig) && !(await probeBoardseshRendererSupport())) {
    throw new Error(BOARDSESH_RENDERER_UNAVAILABLE_MESSAGE);
  }

  return renderThroughNative(configJson, cacheKey, configRequiresModernRenderer(parsedConfig));
}
