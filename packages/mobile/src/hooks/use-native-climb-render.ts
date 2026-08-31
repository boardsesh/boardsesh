import { useCallback, useEffect, useMemo, useState, useRef, useSyncExternalStore } from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import {
  boardRenderFailed,
  buildBoardRenderTelemetryProps,
  classifyBoardRenderErrorCode,
  type BoardRenderConfigFailureKind,
  type BoardRenderErrorCode,
  type BoardRenderFailureSurface,
  type BoardRenderImageLoadFailureKind,
  type BoardRenderNativeFailureKind,
} from '@boardsesh/analytics';
import { listOverlayCacheEntries, onOverlayCacheHydrated, overlayCacheEntryExists } from './overlay-cache-warmup';
import { RENDERER_VERSION } from './renderer-version';
import {
  HOLD_STATE_MAP,
  getBoardStrokeWidthMultiplier,
  getHoldDisplayColor,
  parseFramesSegments,
} from '@boardsesh/board-constants/hold-states';
import {
  getWallLightness,
  isWithinSpillRange,
  loadBoardArtGeometry,
  type BoardArtGeometry,
} from '@boardsesh/board-art-geometry';
import { getBoardRenderData } from '../lib/board-details';
import {
  ensureBackgroundsCached,
  tryGetBackgroundPathsSync,
  type BackgroundColorScheme,
  type BackgroundVariant,
} from '../lib/background-image-cache';
import { useAppColorScheme } from '../providers/theme-provider';
import { addErrorBreadcrumb, reportError } from '../lib/error-reporting';
import { track } from '../lib/analytics';
import { sweepBoardArtCache } from '../lib/sweep-caches';
import { measureFreeCacheSpaceBytes } from '../lib/cache-dir-io';
import {
  cacheRenderedOverlay,
  getRenderedOverlay,
  invalidateRenderedOverlay,
  _renderedOverlaysForTests,
  _resetOverlayIndexForTests,
  type RenderedOverlayEntry,
} from '../lib/overlay-index';
import {
  DEFAULT_HOLD_COLOR_SIGNATURE,
  DEFAULT_HOLD_BRUSH_THICKNESS,
  DEFAULT_HOLD_MARKER_SHAPE,
  DEFAULT_HOLD_SHAPE_SIZE,
  buildHoldColorOverrideSignature,
  buildHoldRenderOverrideSignature,
  getEffectiveHoldStateColor,
  getEffectiveHoldStateShape,
  useHoldColorOverrides,
  type HoldColorOverrides,
  type HoldShapeOverrides,
} from '../lib/hold-color-overrides';
import { buildAuraRenderFields } from '@boardsesh/board-look';
import {
  boardFieldColorForScheme,
  buildBoardRenderSignature,
  requestedBoardRenderMode,
  resolveEffectiveRenderSettings,
  resolveVeilOpacity,
  useBoardRenderSettings,
  type BoardRenderSettings,
  type BoardseshRenderSettings,
  type EffectiveBoardRenderSettings,
} from '../lib/board-render-settings';
import {
  getBoardseshRendererSupport,
  getBoardseshSupportProbe,
  getBoardseshSupportRevision,
  setBoardseshRendererSupport,
  setBoardseshSupportProbe,
  subscribeToBoardseshSupport,
} from './boardsesh-renderer-support';

const MARKER_RENDERER_UNAVAILABLE_MESSAGE =
  'Marker shape, size, and brush overrides require a rebuilt BoardRenderer native binary';
// Restated rather than imported: the native-module wrapper that throws it is
// loaded through a lazy require() (see getNativeModule), and a static import
// here would pull expo-modules-core into every consumer of this hook. Pinned
// against the wrapper's own constant by the Boardsesh render suite.
const BOARDSESH_RENDERER_UNAVAILABLE_MESSAGE =
  'The Boardsesh render mode requires a rebuilt BoardRenderer native binary';

/**
 * Inputs to the native climb renderer. Just the climb identity — no
 * render-size or quality knobs. The hook always renders at the board's
 * native pixel dimensions (from getBoardRenderData) and the consuming
 * <Image> scales it down via contentFit="contain" for small surfaces
 * like the list thumbnail.
 *
 * Note: no `mirrored` input here. Callers (ClimbListThumbnail,
 * BoardImageNative) flip with a CSS scaleX(-1) so a single cached PNG serves
 * both orientations; the renderer config is always pinned to `mirrored: false`.
 * If we ever need true Rust-side mirroring (e.g. for an export pipeline that
 * doesn't go through <Image>), thread it back in, change configBase.mirrored,
 * and restore the cache-key suffix together — don't desync the cache from
 * what gets rendered.
 */
type NativeClimbRenderParams = {
  frames: string;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  /**
   * Use the filled hold style (0.3-opacity fill + thicker stroke + larger
   * markers) instead of the default stroke-only "full" style. The list
   * thumbnail passes true so lit holds read as solid dots once scaled to
   * ~76px; the full-size play view leaves it false (thin strokes stay
   * legible when large). Threaded into the cache key so the two styles
   * cache as separate PNGs.
   */
  filledStyle?: boolean;
  /**
   * Target overlay width in pixels for small surfaces (list thumbnail,
   * accessory thumbnail). The Rust renderer rasterizes the holds-only PNG
   * at this width instead of the board's native ~1080px, so the consuming
   * <Image> never has to downscale a large source on the main thread (the
   * cause of the iOS app hang). Omit for the full-size play view, which
   * renders at native board width. Clamped to the board width (never
   * upscales). Selects the bundled `thumb` background variant by default
   * (override with `backgroundVariant`).
   */
  renderWidth?: number;
  /**
   * Force the bundled board-photo resolution independently of `renderWidth`.
   * The board photo is shared per board-config (one decode across every climb
   * on the wall), so the play-drawer carousel renders the per-climb overlay at
   * display size (a small `renderWidth`) while keeping the photo crisp
   * (`backgroundVariant="full"`). Defaults to `thumb` when `renderWidth` is set,
   * `full` otherwise.
   */
  backgroundVariant?: BackgroundVariant;
  /**
   * Synchronously verify a generated file before exposing its URI. Used by the
   * Android session notification, which hands the path to native compositing
   * without mounting an expo-image that could report onError.
   */
  verifyOverlayFile?: boolean;
  /**
   * This is THE board the climber is looking at — the play drawer's current
   * card, and nothing else. Two things key off it, and both would be wrong
   * without an explicit opt-in:
   *
   *  * `surface: 'play'` on every failure event. Twelve other call sites render
   *    at full size (preview cards and rails, the preview sheet, the reaction
   *    menu, the wall kiosk hero, the carousel's off-screen peek), so a rate
   *    that pooled them would not describe anything anyone saw.
   *  * the paint watchdog, which only makes sense for a board on screen that a
   *    climber is waiting on.
   */
  playSurface?: boolean;
  /**
   * Draw under a DIFFERENT board-render settings bundle than the climber's
   * stored one — the board-look carousel, whose cards each show the same climb
   * under a different preset.
   *
   * Only the board-render half is overridden. Hold colours, marker shapes and
   * the CVD palettes still come from `useHoldColorOverrides()` below, so a
   * preview always draws in the climber's OWN colours and picking a preset can
   * never be a back door into the accessibility store.
   *
   * Substituted before the mode/veil/signature chain, so the override reaches
   * `buildBoardRenderSignature` and therefore the cache key: each preset caches
   * as its own PNG, and a card whose settings equal the climber's real ones
   * SHARES the real PNG rather than displacing it.
   *
   * MUST be referentially stable across renders (a module constant, or memoized
   * on the values it derives from). A fresh object every render re-fires the
   * overlay effect on every tick. Undefined — every real surface — reads the
   * store.
   */
  renderSettingsOverride?: BoardRenderSettings;
  /**
   * Draw under a DIFFERENT set of hold role colours than the climber's stored
   * ones — the colour-vision palette rail, whose cards each show the same climb
   * on the same board under a different palette.
   *
   * The colour half of the same "draw this card differently" seam
   * `renderSettingsOverride` is the board half of; either can be used without
   * the other. `{}` is meaningful and NOT the same as omitting it: an empty map
   * draws the board's own shipped palette (the rail's "Default" card), while
   * `undefined` reads the store (every real surface, and the rail's "Custom"
   * card).
   *
   * Read-only by construction: it never writes the hold-colour override store,
   * so previewing a palette cannot reach the physical board's LEDs, and the
   * climber's stored colours are unchanged the moment the card unmounts.
   *
   * Substituted before the signature chain, so the override reaches
   * `buildHoldRenderOverrideSignature` and therefore the cache key: each palette
   * caches as its own PNG, and a card whose colours equal the climber's real
   * ones SHARES the real PNG rather than displacing it.
   *
   * MUST be referentially stable across renders (a module constant, or memoized
   * on the values it derives from) — for the same reason
   * `renderSettingsOverride` must be: a fresh object every render re-fires the
   * overlay effect on every tick.
   */
  holdColorOverride?: HoldColorOverrides;
  /**
   * Ceiling for the veil's opacity on this surface, overriding the strength the
   * climber's settings and the board's measured wall would otherwise resolve to.
   *
   * For surfaces where the UNLIT holds still have a job to do — the create
   * editor, where the next hold to tap is one of them — a `strong` wash hides
   * the targets. Editing surfaces pass `EDITING_MAX_VEIL_OPACITY`. Only ever
   * lowers: a board that already resolves below the cap is untouched, and its
   * PNG stays byte-identical to (and shares the cache with) the uncapped one.
   */
  maxVeilOpacity?: number;
};

type NativeClimbRenderResult = {
  /**
   * file:// URI of the holds-only PNG, or null until the Rust render
   * completes (or forever if the native module is unavailable, e.g.
   * Expo Go). Consumers stack this on top of `backgroundPaths`.
   */
  overlayUri: string | null;
  /**
   * Changes whenever this consumer must make expo-image perform a fresh load,
   * including a regeneration that writes back to the same file:// URI.
   */
  overlayLoadKey: string | null;
  /** Exact-attempt callbacks consumed by LayeredClimbImage's overlay Image. */
  onOverlayLoad: (loadKey: string | null) => void;
  onOverlayError: (event: { error: string }, loadKey: string | null) => void;
  /**
   * Report whether an overlay `<Image>` is mounted right now: its load key while
   * one is, `null` when there is none. Drives the paint watchdog, which must
   * never run against a surface rendering no image at all.
   */
  onOverlayMounted: (mountedLoadKey: string | null) => void;
  /** Revalidate immediately before a non-Image native consumer uses the path. */
  verifyOverlayForNativeUse: (uri: string | null, loadKey: string | null) => string | null;
  /**
   * Filesystem paths (no scheme) of the bundled board background images
   * that resolved successfully. Returned synchronously when bundled-asset
   * paths are already materialized (production builds), populated after
   * an async pass otherwise.
   */
  backgroundPaths: string[];
  /**
   * Number of background layers the renderer expected but could not
   * resolve (manifest miss, asset resolution failure, etc). Consumers
   * MUST render a visible placeholder per missing layer — the no-network
   * rule means we never fall back to a server, so missing layers have to
   * be visible-broken to the user instead of invisibly-broken.
   */
  missingBackgroundCount: number;
  /**
   * The drawing this render actually used, after the climber's settings, the
   * rollout flags and the installed library have all had their say. Surfaced so
   * the settings screen can show what is on the wall rather than what was asked
   * for.
   */
  effectiveRenderSettings: EffectiveBoardRenderSettings;
  /**
   * Whether the linked native library can draw the Boardsesh mode. `null` until
   * the probe answers — which only happens once someone asks for the mode.
   */
  boardseshRendererAvailable: boolean | null;
};

/**
 * Deduplicate concurrent renders for the same cache key. Entries
 * self-delete via `.finally` when the underlying render settles, so under
 * normal usage the map only holds a handful of in-flight promises at any
 * moment. The hard cap is defence against a pathological burst (e.g. a
 * huge list scrolled before any render completes) leaving stale entries
 * if components unmount mid-render.
 */
export type { RenderedOverlayEntry } from '../lib/overlay-index';

type NativeRenderState = {
  key: string;
  entry: RenderedOverlayEntry | null;
  loadAttempt: number;
};

type LoadedNativeRenderState = NativeRenderState & { entry: RenderedOverlayEntry };

function isLoadedNativeRender(state: NativeRenderState | null): state is LoadedNativeRenderState {
  return state?.entry != null;
}

function isExactNativeRender(
  current: NativeRenderState | null,
  expected: LoadedNativeRenderState,
): current is LoadedNativeRenderState {
  return (
    isLoadedNativeRender(current) &&
    current.key === expected.key &&
    current.entry.uri === expected.entry.uri &&
    current.entry.generation === expected.entry.generation &&
    current.loadAttempt === expected.loadAttempt
  );
}

const inflightRenders = new Map<string, Promise<RenderedOverlayEntry>>();
const INFLIGHT_RENDERS_MAX = 50;

// Render signatures the installed renderer told us it cannot honour (an old
// native binary that predates marker support throws
// MARKER_RENDERER_UNAVAILABLE_MESSAGE). Module-scoped: one refusal is a
// property of the binary, not of the climb, so every hook instance learns from
// it. `unsupportedSignatureRevision` is the useSyncExternalStore tick — without
// it a Set mutated inside a promise catch would never reach the components that
// have to re-resolve which overrides they can still ask for.
const unsupportedRenderSignatures = new Set<string>();
const unsupportedSignatureListeners = new Set<() => void>();
let unsupportedSignatureRevision = 0;

function markRenderSignatureUnsupported(renderSignature: string): void {
  if (unsupportedRenderSignatures.has(renderSignature)) return;
  unsupportedRenderSignatures.add(renderSignature);
  unsupportedSignatureRevision += 1;
  for (const listener of unsupportedSignatureListeners) listener();
}

function subscribeToUnsupportedSignatures(onStoreChange: () => void): () => void {
  unsupportedSignatureListeners.add(onStoreChange);
  return () => {
    unsupportedSignatureListeners.delete(onStoreChange);
  };
}

function getUnsupportedSignatureRevision(): number {
  return unsupportedSignatureRevision;
}

// ── Boardsesh render-mode capability (issue #2202) ─────────────────────────
// Separate from `unsupportedRenderSignatures` on purpose. A marker refusal is
// about ONE signature and degrades that signature's geometry; a Boardsesh
// refusal is about the linked LIBRARY and has to move every surface in the app
// back to the classic drawing at once — recording it as an unsupported
// signature would instead drop the climber's marker overrides, which the
// binary can draw perfectly well.
//
// The state itself lives in ./boardsesh-renderer-support (a caller that only
// needs to READ it — the board-render A/B telemetry in queue-provider.tsx —
// can import just that, without this file's `expo-asset`-importing native
// render graph); re-exported here unchanged for every existing call site and
// test seam in this file.
export { _resetBoardseshSupportForTests, _getBoardseshSupportForTests } from './boardsesh-renderer-support';

/**
 * Ask the native library once per JS lifetime whether it can draw the Boardsesh
 * mode. Safe to call on every render — it self-guards, and it costs the two
 * probe renders only for someone whose settings actually ask for the mode.
 *
 * A native module that has not registered yet is NOT recorded as unsupported:
 * getNativeModule() retries across renders, and latching false on the first of
 * those attempts would pin the whole app to classic for a fast-refresh timing
 * blip. Leaving the answer at `null` reads as unavailable anyway, so nothing
 * renders on an unverified library while we wait.
 *
 * Exported for the board-look step, which has to know the answer BEFORE it
 * decides whether offering a Boardsesh preview would be honest — it cannot wait
 * for a render to start the probe, because the whole question it asks is which
 * drawing to render.
 */
export function ensureBoardseshSupportProbed(): void {
  if (getBoardseshRendererSupport() !== null || getBoardseshSupportProbe()) return;
  const nativeModule = getNativeModule();
  if (!nativeModule) {
    // `getNativeModule` retries across renders and only latches its failure
    // after exhausting the budget. Once it HAS given up there will never be a
    // binary to ask, so leaving the answer at `null` strands every consumer
    // that waits for one — notably queue-provider, which withholds
    // `Climb View Opened` while the mode is unresolved and would then report no
    // views at all for the whole session. (That is reachable only now that the
    // app default asks for the Boardsesh drawing: before, an unresolved answer
    // simply meant classic.) Deferred through the probe slot for the same
    // reason the real probe is: a synchronous store notification here would
    // fire during render.
    if (moduleLoadAttempted) {
      setBoardseshSupportProbe(Promise.resolve().then(() => setBoardseshRendererSupport(false)));
    }
    return;
  }
  const probeSupport = nativeModule.probeBoardseshRendererSupport;
  // Always async, even for a wrapper with no probe (an injected test double):
  // a synchronous store notification here would fire during render.
  setBoardseshSupportProbe(
    Promise.resolve(typeof probeSupport === 'function' ? probeSupport() : false).then(
      (supported) => setBoardseshRendererSupport(supported === true),
      () => setBoardseshRendererSupport(false),
    ),
  );
}

export const _BOARDSESH_RENDERER_UNAVAILABLE_MESSAGE_FOR_TESTS = BOARDSESH_RENDERER_UNAVAILABLE_MESSAGE;

const EMPTY_HOLD_COLOR_OVERRIDES: HoldColorOverrides = {};
const EMPTY_HOLD_SHAPE_OVERRIDES: HoldShapeOverrides = {};

/** The override set the installed renderer can actually draw, plus its signature. */
export type EffectiveRenderOverrides = {
  signature: string;
  colors: HoldColorOverrides;
  shapes: HoldShapeOverrides;
  brushThickness: number;
  shapeSize: number;
};

/**
 * Pick the richest override set the renderer has not refused.
 *
 * A refusal is about marker GEOMETRY — shape, size, brush — which only the
 * marker-aware binaries draw. Colours are honoured by every binary ever
 * shipped, so the fallback keeps them and drops the geometry, rather than
 * dropping the overlay entirely. Before issue #4495 the caller simply stopped
 * rendering on a refused signature, so one unsupported setting blanked the
 * holds on every climb — the opposite of the "falls back to default rendering"
 * this code has always claimed.
 *
 * The signature must stay in lock-step with the overrides it describes: it is
 * the cache key, so returning a degraded config under the full signature would
 * persist wrong pixels under a key a capable renderer later reuses.
 */
export function resolveEffectiveRenderOverrides(
  colors: HoldColorOverrides,
  shapes: HoldShapeOverrides,
  brushThickness: number,
  shapeSize: number,
  renderSignature: string,
): EffectiveRenderOverrides {
  if (!unsupportedRenderSignatures.has(renderSignature)) {
    return { signature: renderSignature, colors, shapes, brushThickness, shapeSize };
  }

  const colorSignature = buildHoldColorOverrideSignature(colors);
  if (colorSignature !== renderSignature && !unsupportedRenderSignatures.has(colorSignature)) {
    return {
      signature: colorSignature,
      colors,
      shapes: EMPTY_HOLD_SHAPE_OVERRIDES,
      brushThickness: DEFAULT_HOLD_BRUSH_THICKNESS,
      shapeSize: DEFAULT_HOLD_SHAPE_SIZE,
    };
  }

  // Colours alone were refused too (or there were none to keep). Fall all the
  // way back to the board's own palette — DEFAULT_HOLD_COLOR_SIGNATURE is never
  // recorded as unsupported, so this always renders something.
  return {
    signature: DEFAULT_HOLD_COLOR_SIGNATURE,
    colors: EMPTY_HOLD_COLOR_OVERRIDES,
    shapes: EMPTY_HOLD_SHAPE_OVERRIDES,
    brushThickness: DEFAULT_HOLD_BRUSH_THICKNESS,
    shapeSize: DEFAULT_HOLD_SHAPE_SIZE,
  };
}

// FIFO, keyed on getBoardConfig's `configKey` — board identity, style, width and
// the render signature. Sized so a screen full of preview cards can never evict
// the config the play view is actively rendering from. Worst case is the Board
// look screen, which now hosts TWO rails at once:
//   6  the live board's own configs: play view (full width, stroke-only), list
//      thumbnail (filled, ~400px) and accessory thumbnail — doubled, because the
//      field colour is part of the signature and a light/dark flip mid-session
//      mints a second set of all three.
//   6  the presets rail: one signature per preset card.
//   6  the colour-vision palette rail: default, four palettes and custom, each
//      carrying its own colour signature.
//  12  one re-mint of both rails after a card is tapped, which changes the
//      current settings every card is drawn against.
// 30 preview configs + 6 live = 36, rounded up to 40 for headroom. Each entry is
// one board's holds array plus its hold-state map — tens of KB — so the ceiling
// is cheap; the cost of setting it too low is a re-render of the live board, not
// a leak.
const BOARD_CONFIG_CACHE_MAX = 40;

// The synchronous overlay index (the `renderedOverlays` map, its insertion /
// read / invalidation helpers, and the access clock the disk sweeper protects
// live keys with) lives in ../lib/overlay-index. It was extracted so the sweeper
// can forget keys whose PNG it just deleted without importing this hook — see
// that module for why the cycle mattered.

/**
 * Everything `Board Render Failed` needs that is not the failure itself. Built
 * once per hook instance (`useMemo`) so both failure paths — the native
 * rejection and the expo-image load error — report against exactly the same
 * board, and neither has to re-derive the common props by hand.
 */
type RenderFailureTelemetryContext = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  effective: EffectiveBoardRenderSettings;
  surface: BoardRenderFailureSurface;
  /** The requested overlay width, or null for a native-width render. */
  renderWidth: number | null;
  framesLength: number;
};

/**
 * Hard ceiling on `Board Render Failed` events per JS lifetime.
 *
 * The bug this telemetry exists for is a device that fails EVERY render after a
 * point, and `getOrStartInflightRender` clears the settled promise, so every
 * recycled FlashList row tries again — the same shape that once produced 50
 * Sentry events in 50 minutes (issue #3647). 25 events is more than enough to
 * see which stage, which kind and which error code a session is stuck on;
 * beyond that the extra rows say nothing new and cost PostHog volume.
 */
const RENDER_FAILURE_EVENT_CAP = 25;

/**
 * A much tighter budget for the config stage, and its OWN budget rather than a
 * share of the 25 above.
 *
 * A config mismatch is a property of a climb-and-board pair, so one list scroll
 * across a board whose sets do not cover a climb's holds can produce it on every
 * row. Sharing one budget would let that spend the whole session's telemetry on
 * a single answer and silence the native and image_load signals — which are the
 * ones that move. Ten is plenty to establish that a board is serving climbs it
 * cannot draw.
 */
const CONFIG_FAILURE_EVENT_CAP = 10;

/**
 * Render failures seen this JS lifetime, ALL stages. Keeps counting past every
 * cap, and rides along on every event and Sentry report as
 * `failures_this_session` / `failuresThisSession` — so a stream that stops reads
 * as truncated rather than as a device that failed exactly that many times.
 */
let renderFailuresThisSession = 0;
/** Events actually sent, per budget. Only these two gate emission. */
let configFailureEventsSent = 0;
let renderFailureEventsSent = 0;

/**
 * Cache keys already reported as a config mismatch, across every hook instance.
 *
 * Module-level, not per instance: a FlashList recycles rows, so a per-instance
 * guard would still report the same climb once per row that happens to land on
 * it. A mismatch cannot change for a given cache key — the key already encodes
 * the board, the sets and the frames — so the first answer is the only one.
 *
 * Bounded and insertion-ordered, so a long browse evicts the oldest keys rather
 * than growing without limit; re-reporting a climb from 200 keys ago is a much
 * cheaper failure than a set that never stops growing.
 */
const CONFIG_MISMATCH_KEY_MEMORY = 200;
const reportedConfigMismatchKeys = new Set<string>();

/** @returns true the FIRST time this cache key is seen, false afterwards. */
function claimConfigMismatchKey(cacheKey: string): boolean {
  if (reportedConfigMismatchKeys.has(cacheKey)) return false;
  if (reportedConfigMismatchKeys.size >= CONFIG_MISMATCH_KEY_MEMORY) {
    const oldestKey = reportedConfigMismatchKeys.keys().next().value;
    if (oldestKey !== undefined) reportedConfigMismatchKeys.delete(oldestKey);
  }
  reportedConfigMismatchKeys.add(cacheKey);
  return true;
}

/** One failure, as the two reporting paths describe it. */
type RenderFailureNote = {
  errorCode: BoardRenderErrorCode;
  context: RenderFailureTelemetryContext;
  /** `config`-stage only: how frame 0's lit ids lined up with the board. */
  holdMatch?: { litCount: number; unmatchedCount: number };
} & (
  | { stage: 'native'; failureKind: BoardRenderNativeFailureKind }
  | { stage: 'image_load'; failureKind: BoardRenderImageLoadFailureKind }
  | { stage: 'config'; failureKind: BoardRenderConfigFailureKind }
);

/**
 * Record one render failure: a Sentry breadcrumb every time, and a
 * `Board Render Failed` event until the session cap is reached.
 *
 * Returns the running failure count so the caller can put it on its own Sentry
 * report — the once-per-kind guard there means the FIRST failure is the only one
 * that ever gets reported, and without this number that report cannot say
 * whether it was a one-off or the start of a storm.
 *
 * Nothing derived from the message, the cache key or the file path reaches
 * either destination: the message is bucketed to a closed set of error codes by
 * `classifyBoardRenderErrorCode` first.
 */
function noteRenderFailure(note: RenderFailureNote): number {
  const { errorCode, context } = note;
  renderFailuresThisSession += 1;
  const failuresThisSession = renderFailuresThisSession;

  addErrorBreadcrumb({
    category: 'board-render',
    message: `Board render failed: ${note.stage}/${note.failureKind}/${errorCode}`,
    level: 'warning',
    data: {
      boardName: context.boardName,
      layoutId: context.layoutId,
      sizeId: context.sizeId,
      surface: context.surface,
      renderMode: context.effective.mode,
      failuresThisSession,
    },
  });

  // Two independent budgets — see CONFIG_FAILURE_EVENT_CAP for why the config
  // stage must not be able to spend the one the other stages rely on.
  if (note.stage === 'config') {
    if (configFailureEventsSent >= CONFIG_FAILURE_EVENT_CAP) return failuresThisSession;
    configFailureEventsSent += 1;
  } else {
    if (renderFailureEventsSent >= RENDER_FAILURE_EVENT_CAP) return failuresThisSession;
    renderFailureEventsSent += 1;
  }

  const shared = {
    ...buildBoardRenderTelemetryProps(context.effective, {
      boardName: context.boardName,
      layoutId: context.layoutId,
      sizeId: context.sizeId,
    }),
    surface: context.surface,
    error_code: errorCode,
    render_width: context.renderWidth,
    frames_length: context.framesLength,
    failures_this_session: failuresThisSession,
    // Omitted entirely off the config stage, so a `native` event never carries
    // a meaningless zero that a query would have to special-case.
    ...(note.holdMatch ? { lit_count: note.holdMatch.litCount, unmatched_count: note.holdMatch.unmatchedCount } : {}),
  };
  // Branch rather than spread a `{ stage, failure_kind }` pair: the two are one
  // discriminated pair in `BoardRenderFailedInput`, and keeping the branch is
  // what makes a mismatched combination a compile error instead of a cast.
  let event;
  if (note.stage === 'native') {
    event = boardRenderFailed({ ...shared, stage: 'native', failure_kind: note.failureKind });
  } else if (note.stage === 'image_load') {
    event = boardRenderFailed({ ...shared, stage: 'image_load', failure_kind: note.failureKind });
  } else {
    event = boardRenderFailed({ ...shared, stage: 'config', failure_kind: note.failureKind });
  }
  track(event.name, event.properties);
  return failuresThisSession;
}

type OverlayLoadTelemetryKind = BoardRenderImageLoadFailureKind;

const reportedOverlayLoadTelemetry = new Set<OverlayLoadTelemetryKind>();

/** Sentry's half: one report per failure class per JS lifetime, and no event. */
function reportOverlayLoadDiagnosticOnce(
  kind: OverlayLoadTelemetryKind,
  boardName: BoardName,
  failuresThisSession: number,
): void {
  if (reportedOverlayLoadTelemetry.has(kind)) return;
  reportedOverlayLoadTelemetry.add(kind);
  reportError(new Error(`Generated overlay image load failed: ${kind}`), {
    level: 'warning',
    tags: {
      feature: 'mobile_board_renderer',
      boardName,
      overlayLoadFailure: kind,
    },
    extra: { failuresThisSession },
  });
}

/**
 * Report one overlay load failure — ONE `Board Render Failed` per callback.
 *
 * The two destinations answer different questions, so they get different
 * budgets. PostHog is counting IMAGES THAT FAILED, so a single `onError` must
 * produce exactly one event: the terminal path used to fire the entry kind and
 * `retry_exhausted` together, which made two real errors read as three failures
 * and burned the session budget a third early. `kind` is therefore what actually
 * became of this image.
 *
 * Sentry is diagnosing CLASSES OF FAILURE, so it still wants both — knowing a
 * key was present-but-undecodable AND that the retry was spent is the useful
 * pair. `alsoDiagnose` carries that second class, and its once-per-kind guard is
 * unchanged (a report there is a page, and #3647 is exactly this shape).
 */
function reportOverlayLoadFailure(params: {
  kind: OverlayLoadTelemetryKind;
  /** A second class for Sentry only — never a second event. */
  alsoDiagnose?: OverlayLoadTelemetryKind;
  errorCode: BoardRenderErrorCode;
  context: RenderFailureTelemetryContext;
}): void {
  const { kind, alsoDiagnose, errorCode, context } = params;
  const failuresThisSession = noteRenderFailure({
    stage: 'image_load',
    failureKind: kind,
    errorCode,
    context,
  });
  if (alsoDiagnose) reportOverlayLoadDiagnosticOnce(alsoDiagnose, context.boardName, failuresThisSession);
  reportOverlayLoadDiagnosticOnce(kind, context.boardName, failuresThisSession);
}

/**
 * Why a render failed, at a cardinality Sentry can group on.
 *
 * `disk_full` is the device being out of space, which is a user condition rather
 * than a defect in this code: the write cannot succeed, and every recycled
 * FlashList row tries again.
 */
type RenderFailureKind = 'disk_full' | 'render_failed';

/** iOS's NSFileManager wording, plus the POSIX shapes Android surfaces. */
const DISK_FULL_PATTERN = /out of space|ENOSPC|No space left/i;

/**
 * Below this much free space, a failed write is the disk — whatever language the
 * OS said so in.
 *
 * A board overlay PNG is a few hundred KB, so 32 MB is far more headroom than one
 * write needs: this is not "would this render have fit", it is "this phone is out
 * of room", the same condition the English wording describes. The margin covers
 * the gap between our probe and the write, and iOS's habit of refusing writes
 * before the volume literally hits zero.
 */
const DISK_FULL_FREE_SPACE_BYTES = 32 * 1024 * 1024;

/**
 * @param freeDiskBytes free space on the cache volume, or null when unavailable.
 *
 * The message match is the fast path, but `NSError.localizedDescription` is
 * TRANSLATED: on a Spanish, French or German phone a full volume reads "no hay
 * espacio suficiente" / "n'a plus d'espace" / "nicht genügend Speicherplatz" and
 * matches none of the English wording. Misclassifying that as `render_failed`
 * costs exactly the storm this whole path exists to stop — no back-off, no sweep,
 * every recycled row re-encoding a PNG it cannot write. Free space is the same
 * question asked in a way no locale can change the answer to.
 */
export function classifyRenderFailure(message: string, freeDiskBytes: number | null = null): RenderFailureKind {
  if (DISK_FULL_PATTERN.test(message)) return 'disk_full';
  if (freeDiskBytes !== null && freeDiskBytes < DISK_FULL_FREE_SPACE_BYTES) return 'disk_full';
  return 'render_failed';
}

const reportedRenderFailures = new Set<RenderFailureKind>();

/**
 * One Sentry event per failure class per JS lifetime, carrying a STABLE message.
 *
 * Both halves are load-bearing. Without the once-guard, a full device produced
 * one `level: error` event per recycled row — 50 events in 50 minutes from a
 * single device (BOARDSESH-C6/C7/C8), because `getOrStartInflightRender` clears
 * the settled promise so every recycle re-renders and re-reports. And without
 * the stable synthetic message, the guard alone would not have been enough:
 * Sentry groups on the message, and the raw error interpolates the FILENAME
 * ("You can't save the file \"v5_….png\"…"), so each distinct cache key minted a
 * NEW issue group. That is why one device produced three of them. The original
 * error rides along as `cause`, and the filename lands in `extra` where it is
 * still readable but no longer part of the fingerprint.
 */
function reportRenderFailureOnce(params: {
  kind: RenderFailureKind;
  error: unknown;
  message: string;
  boardName: BoardName;
  extra: Record<string, unknown>;
}): void {
  const { kind, error, message, boardName, extra } = params;
  if (reportedRenderFailures.has(kind)) return;
  reportedRenderFailures.add(kind);
  const isDiskFull = kind === 'disk_full';
  reportError(new Error(`Board overlay render failed: ${kind}`, { cause: error }), {
    // A device with no free space is expected behaviour we back off from, not a
    // bug to page on.
    level: isDiskFull ? 'warning' : 'error',
    tags: {
      feature: 'mobile_board_renderer',
      boardName,
      renderFailure: kind,
      ...(isDiskFull ? { expected_disk_full: 'true' } : {}),
    },
    extra: { ...extra, renderErrorMessage: message },
  });
}

/**
 * How long the render path stays quiet after the device reports a full disk.
 *
 * The overlay stays null and the wall photo still shows — the existing
 * missing-layer contract — so the cost of backing off is a plain board rather
 * than a blank screen. The cost of NOT backing off is a phone with no free space
 * burning battery re-encoding PNGs it cannot write.
 */
const DISK_PRESSURE_BACKOFF_MS = 60_000;
let diskPressureUntilMs = 0;

function isDiskPressureLatched(nowMs = Date.now()): boolean {
  return nowMs < diskPressureUntilMs;
}

/** How long until the current back-off lifts. Zero when nothing is latched. */
function diskPressureRemainingMs(nowMs = Date.now()): number {
  return Math.max(0, diskPressureUntilMs - nowMs);
}

/**
 * How many times one mounted surface will come back after a back-off lifts.
 *
 * The back-off exists so a full device stops re-encoding PNGs it cannot write —
 * but a play view the user is staring at has no prop change to bring it back, so
 * without a re-trigger its overlay stays missing for the life of the mount even
 * after the sweep freed 200 MB. Bounded rather than unlimited because the retry
 * costs a full render on a device that may still be full: three attempts covers
 * the sweep landing and a user deleting photos in the next couple of minutes,
 * and then this surface gives up until it is remounted or its props change.
 */
const DISK_PRESSURE_MAX_RETRIES = 3;

/**
 * How long the hook waits before its one self-retry after a native render
 * rejected for a reason that is not the disk.
 *
 * Long enough that whatever transient condition broke the render (a memory
 * spike from a burst of swipes, a native context the OS reclaimed) has a chance
 * to clear, short enough that a climber staring at a board with no holds gets it
 * back rather than reaching for the app switcher. One attempt, then this key is
 * done — see `retriedCacheKeysRef`.
 */
const RENDER_RETRY_DELAY_MS = 1500;

/**
 * How long the full-size board waits for expo-image to say ANYTHING about an
 * overlay it was handed.
 *
 * The remaining suspect in the Aura 12x12 report is a correctly rendered file
 * that iOS never paints: the same climbs draw fine on Android and on the host,
 * so the PNG is not the problem. expo-image is supposed to answer with `onLoad`
 * or `onError`; silence for this long is a third outcome nothing was watching
 * for. 4s is far past a local file decode (tens of ms) and short enough that the
 * event lands in the same session as the swipe that caused it.
 *
 * Observation only — see the watchdog effect. Play board only: a list of
 * thumbnails would arm one of these per row.
 */
const OVERLAY_PAINT_TIMEOUT_MS = 4000;

function latchDiskPressure(): void {
  diskPressureUntilMs = Date.now() + DISK_PRESSURE_BACKOFF_MS;
  // Free what we can while we are backed off. The sweeper's own per-trigger rate
  // limit keeps this to one sweep even if several rows fail at once.
  void sweepBoardArtCache({ trigger: 'disk-pressure' }).catch(() => {
    // Best-effort: a sweep that fails on a full disk changes nothing about the
    // back-off, which is the part that stops the storm.
  });
}

/** Test-only handles for the failure-reporting guards. */
export function _resetRenderFailureStateForTests(): void {
  reportedRenderFailures.clear();
  diskPressureUntilMs = 0;
  renderFailuresThisSession = 0;
  configFailureEventsSent = 0;
  renderFailureEventsSent = 0;
  reportedConfigMismatchKeys.clear();
}

/** Test-only view of the two per-lifetime event budgets. */
export const _RENDER_FAILURE_EVENT_CAP_FOR_TESTS = RENDER_FAILURE_EVENT_CAP;
export const _CONFIG_FAILURE_EVENT_CAP_FOR_TESTS = CONFIG_FAILURE_EVENT_CAP;

/**
 * One-time eager scan of the native module's PNG cache directory. The
 * Swift/Kotlin modules write to {cache}/board-thumbnails/<cacheKey>.png;
 * we list it once at JS startup and populate `renderedOverlays` so prior
 * sessions' renders are sync-hit-available without waiting for the
 * native bridge round-trip.
 *
 * Skips quietly if the directory doesn't exist yet (clean install, first
 * launch). Wrapped in try/catch because filesystem failures here are
 * non-fatal — worst case the hook does the async render on first call.
 */
const CACHE_DIR_NAME = 'board-thumbnails';
let warmupRun = false;

function warmupRenderedOverlaysOnce(): void {
  if (warmupRun) return;
  warmupRun = true;
  try {
    const entries = listOverlayCacheEntries(CACHE_DIR_NAME);
    if (!entries) return;
    // Only PNGs from the current RENDERER_VERSION can be reused. Older
    // version prefixes (e.g. v1_*) describe a different render format and
    // would never be matched by cacheKey lookups, so loading them into
    // the map just wastes memory. Opportunistically delete those stale
    // files to reclaim disk while we're already walking the directory.
    const currentVersionPrefix = `v${RENDERER_VERSION}_`;
    for (const entry of entries) {
      if (typeof entry.uri !== 'string') continue;
      // Files only — skip subdirectories. expo-file-system returns
      // File and Directory instances; File has a .name like "<key>.png".
      const name = entry.name;
      if (!name || !name.endsWith('.png')) continue;
      if (!name.startsWith(currentVersionPrefix)) {
        // Stale leftover from a prior RENDERER_VERSION. Best-effort delete;
        // any failure (permissions, race with another writer) is non-fatal
        // — the file simply lingers until the OS reclaims cache space.
        try {
          entry.delete?.();
        } catch {
          // Swallow — never let a delete failure crash the warmup.
        }
        continue;
      }
      const cacheKey = name.slice(0, -'.png'.length);
      cacheRenderedOverlay(cacheKey, entry.uri);
    }
  } catch {
    // Filesystem errors at startup shouldn't break the app — the hook's
    // render path will repopulate the map as climbs are viewed.
  }
}

// On web the persisted overlays live in the async Cache API, so the first
// synchronous warm-up can run before hydration finishes and see an empty
// snapshot. Re-run the warm-up once hydration resolves so prior-session
// overlays land in the map for first paint. Native hydration is synchronous
// (disk list) and this fires immediately as a no-op re-run. The re-run is
// purely additive — the store already evicted stale-version entries during
// hydration, so the snapshot only carries current-version overlays.
onOverlayCacheHydrated(() => {
  warmupRun = false;
  warmupRenderedOverlaysOnce();
});

/** Test-only handle for re-running the warm-up against a fresh mock list. */
export function _resetWarmupForTests(): void {
  warmupRun = false;
  // Board hold ids are memoised per board key, so a suite that swaps what
  // `getBoardRenderData` returns for the SAME board would otherwise keep
  // matching against the previous fixture's holds.
  boardHoldIdsCache.clear();
  _resetOverlayIndexForTests();
  reportedOverlayLoadTelemetry.clear();
  _resetRenderFailureStateForTests();
}

/** Test-only handle to invoke the warm-up explicitly (it normally runs lazily on first render). */
export function _runWarmupForTests(): void {
  warmupRenderedOverlaysOnce();
}

/**
 * Look up an in-flight render by cache key, or start a new one. Exposed
 * (alongside _inflightRendersForTests) so the dedup + cap contract can be
 * unit tested without spinning up a React renderer.
 */
export function getOrStartInflightRender(
  cacheKey: string,
  startRender: () => Promise<string>,
): Promise<RenderedOverlayEntry> {
  const existing = inflightRenders.get(cacheKey);
  if (existing) return existing;

  // Evict the oldest entry before inserting so we never grow past the
  // cap, even briefly.
  if (inflightRenders.size >= INFLIGHT_RENDERS_MAX) {
    const oldestKey = inflightRenders.keys().next().value;
    if (oldestKey !== undefined) {
      inflightRenders.delete(oldestKey);
    }
  }

  const promise = startRender().then((uri) => cacheRenderedOverlay(cacheKey, uri));
  inflightRenders.set(cacheKey, promise);
  // Run cleanup as a detached handler so it doesn't change the promise
  // returned to callers, and so callers that only attach .then can still
  // observe rejections.
  void promise
    .finally(() => {
      if (inflightRenders.get(cacheKey) === promise) inflightRenders.delete(cacheKey);
    })
    .catch(() => {
      // Swallow — the original promise's rejection is observed by the
      // caller. This catch only exists to prevent the .finally chain
      // from generating an unhandled rejection.
    });
  return promise;
}

/** Test-only handles. Not part of the public API. */
export const _inflightRendersForTests = inflightRenders;
// Re-exported from ../lib/overlay-index so the existing suites keep their imports.
export { _renderedOverlaysForTests };
export const _cacheRenderedOverlayForTests = cacheRenderedOverlay;
export const _getRenderedOverlayForTests = getRenderedOverlay;
export const _invalidateRenderedOverlayForTests = invalidateRenderedOverlay;
export const _unsupportedRenderSignaturesForTests = unsupportedRenderSignatures;
export const _markRenderSignatureUnsupportedForTests = markRenderSignatureUnsupported;
export const _MARKER_RENDERER_UNAVAILABLE_MESSAGE_FOR_TESTS = MARKER_RENDERER_UNAVAILABLE_MESSAGE;

/**
 * Test-only: inject a fake native module. The real one loads via a literal
 * CJS require() that vitest's mock registry can't intercept — in tests the
 * try/catch silently exhausts the retry budget and the hook behaves as
 * "renderer unavailable", so async-render paths would be untestable.
 */
export function _setNativeModuleForTests(module: typeof renderModule): void {
  // No-op in release bundles — this seam mutates module state and must not be
  // reachable from production code paths. (Mobile vitest runs with __DEV__ set,
  // so tests pass through.)
  if (!__DEV__) return;
  renderModule = module;
  moduleLoadAttempted = true;
  moduleLoadFailureCount = 0;
}

/** One hold as the Rust renderer reads it. The four optional fields are Boardsesh-only. */
type RenderHold = {
  id: number;
  mirroredHoldId: number | null;
  cx: number;
  cy: number;
  r: number;
  /** `[dx, dy]` in radius units to the LED blob the board art already paints. */
  led?: [number, number];
  /** Traced silhouette, flat `[x0, y0, …]` in radius units from the centre. */
  outline?: number[];
  /**
   * Inner boundary of the hold's LED base plate, same form as `outline`. The
   * renderer lights the ring between the two. Absent on every hold whose plate
   * nobody has traced, which lights whole as it always did.
   */
  led_inner?: number[];
  /** OkLab lightness of the art inside that silhouette, for the fill's white lift. */
  silhouette_lightness?: number;
};

/**
 * Everything the Boardsesh drawing needs that the board config itself cannot
 * supply: the climber's tuning, the resolved falloff, and the play field the
 * veil washes toward with the strength measured for this board and theme.
 */
type BoardseshConfigInputs = {
  settings: BoardseshRenderSettings;
  glowFalloff: 'soft' | 'plateau';
  fieldColor: string;
  veilOpacity: number;
};

/** The four roles the accessibility glyphs have a vocabulary for. */
const BOARDSESH_GLYPH_ROLES = new Set(['STARTING', 'HAND', 'FINISH', 'FOOT']);

/**
 * Every placement id a board config can draw, memoised per BOARD.
 *
 * Deliberately not derived from `getBoardConfig`: the hold-id question depends
 * only on board + layout + size + sets, while a config key also carries
 * `filledStyle`, the render width and the whole render signature — so one board
 * browsed at two sizes would build the same Set twice. It also has to be
 * answerable BEFORE the overlay cache lookup (see the effect), which is upstream
 * of where a config is built at all.
 *
 * `null` is never cached: an absent board is a "not loaded yet" answer, and
 * poisoning the entry would make it permanent.
 */
const BOARD_HOLD_IDS_CACHE_MAX = 24;
const boardHoldIdsCache = new Map<string, Set<number>>();

function getBoardHoldIds(
  boardName: BoardName,
  layoutId: number,
  sizeId: number,
  setIds: string,
  setIdsArray: number[],
): Set<number> | null {
  const boardKey = `${boardName}-${layoutId}-${sizeId}-${setIds}`;
  const cached = boardHoldIdsCache.get(boardKey);
  if (cached) return cached;

  const renderData = getBoardRenderData({ boardName, layoutId, sizeId, setIds: setIdsArray });
  if (!renderData) return null;

  const holdIds = new Set<number>();
  for (const hold of renderData.holdsData) holdIds.add(hold.id);
  if (boardHoldIdsCache.size >= BOARD_HOLD_IDS_CACHE_MAX) {
    const oldestKey = boardHoldIdsCache.keys().next().value;
    if (oldestKey !== undefined) boardHoldIdsCache.delete(oldestKey);
  }
  boardHoldIdsCache.set(boardKey, holdIds);
  return holdIds;
}

/** Test-only handle so a suite can force a fresh board-hold lookup. */
export function _resetBoardHoldIdsCacheForTests(): void {
  boardHoldIdsCache.clear();
}

/**
 * Memoize board render configs to avoid re-computing hold positions.
 *
 * Deliberately frames-independent, Boardsesh mode included: the lit holds'
 * outlines are the only per-climb part, and keying the whole config on the
 * climb would evict a board's ~700-hold array on every row of a list. The
 * traced shard rides along in the entry instead, and `withLitHoldGeometry`
 * attaches the outlines per call — which only happens on a render miss, where a
 * native PNG encode dwarfs it.
 */
const boardConfigCache = new Map<
  string,
  {
    configBase: Record<string, unknown>;
    setIdsArray: number[];
    holds: RenderHold[];
    boardseshGeometry: BoardArtGeometry | null;
  }
>();

/**
 * Placement ids lit by frame 0 — the frame every static render draws.
 *
 * `parseFramesSegments` is the one grammar for the Aurora frames string (issue
 * #3948 came of a second parser that split on `p` and mistook `"x1192` for a
 * hold id); frame 0 is always absolute, so its own `p<id>r<code>` pairs are the
 * whole lit set without accumulating anything.
 */
function parseLitHoldIds(frames: string): Set<number> {
  const litHoldIds = new Set<number>();
  const firstFrame = parseFramesSegments(frames)[0];
  if (!firstFrame) return litHoldIds;
  for (const match of firstFrame.body.matchAll(/p(\d+)r(\d+)/g)) {
    litHoldIds.add(Number(match[1]));
  }
  return litHoldIds;
}

/**
 * Attach the traced silhouette, its art lightness and its LED base plate ring
 * to the holds this climb lights, and only those.
 *
 * Only the lit ones because the renderer draws nothing on the rest and the
 * outlines are the bulk of the payload: Tension Board 2 12x12 Wide would ship
 * ~190 KB of polygons across the bridge per render to draw sixteen holds.
 * A placement with no traced art keeps no outline — MoonBoard's grid is mostly
 * empty cells — and the renderer falls back to a ring at the placement radius.
 */
function withLitHoldGeometry(
  holds: RenderHold[],
  geometry: BoardArtGeometry,
  litHoldIds: Set<number>,
  spillNeighbours = false,
): RenderHold[] {
  if (litHoldIds.size === 0) return holds;
  // A spill-bearing style's light spill brightens glow landing on unlit TRACED
  // silhouettes, so those holds need their outline in the config too — but
  // only the ones a glow can actually reach, not all ~500 on the board.
  const litHoldCentres = spillNeighbours ? holds.filter((hold) => litHoldIds.has(hold.id)) : [];
  const isNearLitHold = (hold: RenderHold): boolean => litHoldCentres.some((lit) => isWithinSpillRange(lit, hold));
  return holds.map((hold) => {
    if (!litHoldIds.has(hold.id)) {
      const spillOutline = spillNeighbours ? geometry.outlines[hold.id] : undefined;
      return spillOutline && isNearLitHold(hold) ? { ...hold, outline: spillOutline } : hold;
    }
    const outline = geometry.outlines[hold.id];
    const silhouetteLightness = geometry.silhouetteLightness[hold.id];
    // A lightness is only meaningful alongside the silhouette it was measured
    // inside, and the table carries no sentinel — anything non-finite or
    // negative is a corrupt row, not "black art", and is dropped rather than
    // painted (the spike's `-1` shipped 94 MoonBoard holds as if they were).
    const hasLightness =
      typeof silhouetteLightness === 'number' && Number.isFinite(silhouetteLightness) && silhouetteLightness >= 0;
    // The plate ring is the part of the hold a real LED shines through, so the
    // renderer lights it instead of the whole silhouette. It only means
    // anything against that silhouette, and the table is absent on every shard
    // nobody has annotated, so it rides along with `outline` and never alone.
    const ledInner = outline ? geometry.ledInner?.[hold.id] : undefined;
    if (!outline && !hasLightness) return hold;
    return {
      ...hold,
      ...(outline ? { outline } : {}),
      ...(ledInner ? { led_inner: ledInner } : {}),
      ...(hasLightness ? { silhouette_lightness: silhouetteLightness } : {}),
    };
  });
}

export const _withLitHoldGeometryForTests = withLitHoldGeometry;

/**
 * FNV-1a 32-bit hash, returned as 8-char hex. Used to keep the cache
 * filename bounded — long climbs can produce frame strings hundreds of
 * chars long, and both iOS and Android cap filenames at 255 bytes.
 * Non-cryptographic; collision risk for our domain (bounded JSON-ish
 * input) is negligible.
 */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let charIndex = 0; charIndex < input.length; charIndex++) {
    hash ^= input.charCodeAt(charIndex);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Canonicalize the comma-separated setIds string so that equivalent
 * inputs hash to the same cache key regardless of order or duplicates.
 * Mirrors the filter in getBoardConfig (split/Number/filter(Boolean))
 * and additionally sorts ascending — '25,24' and '24,25' both become
 * '24,25'. Without this, two callers passing the same sets in different
 * order would each occupy a separate cache slot for the same render.
 */
function canonicalizeSetIds(setIds: string): string {
  return setIds
    .split(',')
    .map(Number)
    .filter(Boolean)
    .sort((a, b) => a - b)
    .join(',');
}

/**
 * The board-render half of a composed `[overrideHalf, boardHalf].join('.')`
 * signature (see the `effectiveRenderSignature` memo further down), or `''`
 * for a classic render. The override half is never empty — it is `'default'`
 * at minimum — so the board half, when present, always starts at the
 * `mode-boardsesh` token `buildBoardRenderSignature` always leads with, right
 * after that separating dot.
 */
function boardRenderSignatureHalf(renderSignature: string): string {
  const markerIndex = renderSignature.indexOf('.mode-boardsesh');
  return markerIndex === -1 ? '' : renderSignature.slice(markerIndex + 1);
}

export function buildCacheKey(
  boardName: string,
  layoutId: number,
  sizeId: number,
  setIds: string,
  frames: string,
  filledStyle = false,
  renderWidth?: number,
  renderSignature = DEFAULT_HOLD_COLOR_SIGNATURE,
): string {
  // With no frames there are no lit holds to colour- or shape-override, so
  // that half of the signature is meaningless and collapses to the default —
  // but a Boardsesh render with no frames still paints the veil and the field
  // wash, so THAT half must survive rather than being thrown away with it.
  const boardHalf = boardRenderSignatureHalf(renderSignature);
  const effectiveRenderSignature =
    frames.length === 0
      ? boardHalf
        ? `${DEFAULT_HOLD_COLOR_SIGNATURE}.${boardHalf}`
        : DEFAULT_HOLD_COLOR_SIGNATURE
      : renderSignature;
  const framesHash =
    effectiveRenderSignature === DEFAULT_HOLD_COLOR_SIGNATURE
      ? fnv1aHex(frames)
      : fnv1aHex(`${frames}|${effectiveRenderSignature}`);
  const canonicalSetIds = canonicalizeSetIds(setIds);
  // Style token sits right after the version prefix so the warm-up scan
  // (which matches on `v${RENDERER_VERSION}_`) still loads both styles and
  // still deletes genuinely-stale prior-version files. 'f' = filled (list
  // thumbnail), 's' = stroke-only (full play view). Without this token the
  // two styles would collide on one PNG and whichever rendered first wins.
  const style = filledStyle ? 'f' : 's';
  // Width token keeps the small (list, e.g. 400px) and full (play view,
  // native board width) overlays in separate PNGs — otherwise whichever
  // rendered first would be reused at the wrong resolution. 'full' = native
  // board width. The token tracks the requested width, not the clamped
  // output, so it stays stable for a given (board, renderWidth) pair.
  const width = renderWidth != null ? `${renderWidth}` : 'full';
  return `v${RENDERER_VERSION}_${style}_w${width}_${boardName}_${layoutId}_${sizeId}_${canonicalSetIds}_${framesHash}`;
}

/**
 * Identity tuple for the board configuration that determines which
 * background images apply. Unlike the per-climb cache key, this does NOT
 * include `frames` — the bundled background PNGs are the same for every
 * climb on a given board/layout/size/setIds combo. Used to guard the
 * backgroundPaths state so FlashList row recycling (which keeps the same
 * hook instance but swaps in new props) can't surface stale paths from
 * the previous climb's board.
 */
export function buildBoardKey(
  boardName: string,
  layoutId: number,
  sizeId: number,
  setIds: string,
  variant: BackgroundVariant = 'full',
  colorScheme: BackgroundColorScheme = 'light',
): string {
  // Variant is part of the identity so a FlashList row recycled between a
  // thumb context (list) and a full context can't surface the wrong-size
  // background paths from the previous climb.
  //
  // Colour scheme is part of it for the same reason across a theme flip: the
  // near-black MoonBoard layers resolve to `.dark.webp` siblings in dark mode
  // (see background-image-cache.ts), so without this term a flip would leave
  // the previous scheme's paths on screen until some other prop changed.
  return `${boardName}-${layoutId}-${sizeId}-${setIds}-${variant}-${colorScheme}`;
}

function getBoardConfig(
  boardName: BoardName,
  layoutId: number,
  sizeId: number,
  setIds: string,
  filledStyle: boolean,
  renderWidth?: number,
  colorOverrides: HoldColorOverrides = {},
  shapeOverrides: HoldShapeOverrides = {},
  brushThickness = DEFAULT_HOLD_BRUSH_THICKNESS,
  shapeSize = DEFAULT_HOLD_SHAPE_SIZE,
  renderSignature = DEFAULT_HOLD_COLOR_SIGNATURE,
  boardsesh: BoardseshConfigInputs | null = null,
  // Parsed by the caller and passed in rather than re-derived here: the overlay
  // effect already needs frame 0's lit ids for the hold-match check, and the
  // frames string is walked with a regex, so parsing it twice per Aura render
  // is pure waste on the render-miss path.
  litHoldIds: Set<number> = new Set(),
) {
  const widthKey = renderWidth != null ? `${renderWidth}` : 'full';
  const configKey = `${boardName}-${layoutId}-${sizeId}-${setIds}-${filledStyle ? 'f' : 's'}-w${widthKey}-${renderSignature}`;
  let cached = boardConfigCache.get(configKey);

  if (!cached) {
    const setIdsArray = setIds.split(',').map(Number).filter(Boolean);
    const renderData = getBoardRenderData({ boardName, layoutId, sizeId, setIds: setIdsArray });
    if (!renderData) return null;

    // The traced art for this board. Null where the catalogue has no shard for
    // this layout+size — the mode still renders, it just glows a ring at each
    // placement radius. Every config the shards cover has one today: Woods was
    // the last holdout, and its silhouettes are keyed off its photograph's white
    // ground rather than read out of an alpha channel. Individual placements
    // still fall back to a ring whenever `outlines[id]` is absent, which is the
    // common case on MoonBoard's synthetic grid and covers 16 and 26 Woods bolts
    // sitting on bare sweep. The loader memoises per board key, so a list of
    // climbs on one wall requires the shard once.
    const boardseshGeometry = boardsesh ? loadBoardArtGeometry({ boardName, layoutId, sizeId }) : null;
    const ledOffsets = boardseshGeometry?.ledBright ?? null;

    // Build hold_state_map in the format the Rust renderer expects:
    // Record<number, { color: string, render_style?: string }>
    //
    // Prefer each role's calibrated on-screen displayColor over its raw LED
    // color — the LED color is only correct for driving physical board
    // hardware over BLE, not for what a viewer sees on screen (issue #2202:
    // raw LED blue renders far too dark against a busy board photo). Boards
    // without a displayColor (e.g. Kilter) render unchanged.
    //
    // The Boardsesh drawing takes the swap one step further for the dark-blue
    // HAND, whose #4444FF sits too close to black to read once the veil darkens
    // the wall around it. `getHoldDisplayColor` picks between the two palettes,
    // and the climber's own override still wins over whichever it picked.
    const stateMap = HOLD_STATE_MAP[boardName];
    const holdStateMap: Record<number, { color: string; render_style?: string; shape?: string; role?: string }> = {};
    for (const [codeStr, stateInfo] of Object.entries(stateMap)) {
      const shape = getEffectiveHoldStateShape(stateInfo.name, shapeOverrides);
      // The glyph vocabulary covers four roles; MoonBoard's AUX and the Tycho
      // colour-mode codes have no glyph and are left without a role rather than
      // handed one the renderer would draw wrong.
      const role = boardsesh && BOARDSESH_GLYPH_ROLES.has(stateInfo.name) ? stateInfo.name.toLowerCase() : undefined;
      // `colorOverrides` is the climber's own map on every real surface, and a
      // palette card's map on the colour-vision rail — substituted upstream, in
      // the hook, so this point never has to know which it got.
      const resolvedColor = getEffectiveHoldStateColor(
        stateInfo.name,
        getHoldDisplayColor(stateInfo, boardsesh ? 'aura' : 'classic'),
        colorOverrides,
      );
      holdStateMap[Number(codeStr)] = {
        color: resolvedColor,
        ...(stateInfo.renderStyle ? { render_style: stateInfo.renderStyle } : {}),
        ...(shape !== DEFAULT_HOLD_MARKER_SHAPE ? { shape } : {}),
        ...(role ? { role } : {}),
      };
    }

    // Small surfaces (list/accessory) pass a renderWidth so the Rust
    // renderer rasterizes a small PNG (e.g. 400px) instead of the board's
    // native ~1080px — the consuming <Image> then has nothing large to
    // downscale on the main thread. Clamp to the board width so we never
    // upscale. The play view omits renderWidth and renders at native width.
    const outputWidth = renderWidth != null ? Math.min(renderWidth, renderData.boardWidth) : renderData.boardWidth;
    const holds: RenderHold[] = renderData.holdsData.map((hold) => {
      const base: RenderHold = {
        id: hold.id,
        mirroredHoldId: hold.mirroredHoldId,
        cx: hold.cx,
        cy: hold.cy,
        r: hold.r,
      };
      // Every placement the art paints a bright LED on, lit or not: an unlit
      // hold's white pip is exactly what a climber mistakes for a mark, so the
      // cover has to reach the holds this climb does NOT light.
      const led = ledOffsets?.[hold.id];
      return led ? { ...base, led } : base;
    });
    const configBase = {
      board_width: renderData.boardWidth,
      board_height: renderData.boardHeight,
      output_width: outputWidth,
      // The view layer mirrors the complete background + overlay stack, so the
      // renderer stays unmirrored and both orientations reuse one cached image.
      // Pinned explicitly (a no-op on native, whose serde default is already
      // false) for older committed WASM artifacts on web that predate the field's
      // serde default and would otherwise render mirrored.
      mirrored: false,
      thumbnail: filledStyle,
      // Board-specific default (issue #2202: Grasshopper's busier board photo
      // needs a heavier outline) layered under the user's accessibility
      // brush-thickness multiplier. Boards without a render-defaults entry
      // multiply by 1.0, i.e. unchanged. In the Boardsesh drawing the same two
      // multipliers still apply: shape size scales the glow's reach, stroke
      // width the fill's edges and the glyph line.
      stroke_width_multiplier: brushThickness * getBoardStrokeWidthMultiplier(boardName),
      shape_size_multiplier: shapeSize,
      holds,
      hold_state_map: holdStateMap,
      // Nothing below this line exists for a classic config, which must stay
      // byte-identical to what every cached PNG was drawn from.
      ...(boardsesh
        ? buildAuraRenderFields({
            settings: boardsesh.settings,
            glowFalloff: boardsesh.glowFalloff,
            fieldColor: boardsesh.fieldColor,
            veilOpacity: boardsesh.veilOpacity,
            thumbnail: filledStyle,
            hasLedOffsets: ledOffsets !== null && Object.keys(ledOffsets).length > 0,
          })
        : {}),
    };

    // Evict oldest entry when the cache exceeds the cap
    if (boardConfigCache.size >= BOARD_CONFIG_CACHE_MAX) {
      const oldestKey = boardConfigCache.keys().next().value;
      if (oldestKey !== undefined) {
        boardConfigCache.delete(oldestKey);
      }
    }

    cached = { configBase, setIdsArray, holds, boardseshGeometry };
    boardConfigCache.set(configKey, cached);
  }

  // A classic config, a Boardsesh one on a board the tracer skipped, and Modern
  // Classic — which asks for the circle on purpose — are exactly what the cache
  // holds. Otherwise the lit holds' outlines go on now, the one per-climb part
  // of an otherwise per-board config.
  //
  // Withholding the outlines IS the Modern Classic drawing: the renderer falls
  // back to the placement circle for any hold without one, so the veil punches
  // circles and the glow follows them. `led_cover` and the veil measurement do
  // not read outlines and are unaffected; `led_inner` and `silhouette_lightness`
  // drop out with the silhouette they were traced and measured against.
  if (!boardsesh || !cached.boardseshGeometry || boardsesh.settings.holdShape === 'circle') {
    return { configBase: cached.configBase, setIdsArray: cached.setIdsArray };
  }
  return {
    configBase: {
      ...cached.configBase,
      holds: withLitHoldGeometry(
        cached.holds,
        cached.boardseshGeometry,
        litHoldIds,
        // Aura carries no spill_boost, so no unlit outlines are shipped; a
        // future spill-bearing style flips this to its own gate.
        false,
      ),
    },
    setIdsArray: cached.setIdsArray,
  };
}

export function _getBoardConfigForTests(
  boardName: BoardName,
  layoutId: number,
  sizeId: number,
  setIds: string,
  filledStyle: boolean,
  renderWidth?: number,
  colorOverrides: HoldColorOverrides = {},
  shapeOverrides: HoldShapeOverrides = {},
  brushThickness = DEFAULT_HOLD_BRUSH_THICKNESS,
  shapeSize = DEFAULT_HOLD_SHAPE_SIZE,
  renderSignature = DEFAULT_HOLD_COLOR_SIGNATURE,
  boardsesh: BoardseshConfigInputs | null = null,
  // The test seam keeps taking a frames STRING and parses it here: a suite is
  // describing a climb, not the render path's already-parsed intermediate.
  frames = '',
): ReturnType<typeof getBoardConfig> {
  return getBoardConfig(
    boardName,
    layoutId,
    sizeId,
    setIds,
    filledStyle,
    renderWidth,
    colorOverrides,
    shapeOverrides,
    brushThickness,
    shapeSize,
    renderSignature,
    boardsesh,
    parseLitHoldIds(frames),
  );
}

export type { BoardseshConfigInputs };

/** Test-only handle: forget the memoised board configs between mocked boards. */
export function _resetBoardConfigCacheForTests(): void {
  boardConfigCache.clear();
}

/**
 * Lazy-load the native module wrapper. The wrapper uses
 * requireOptionalNativeModule under the hood so missing-binary
 * scenarios (Expo Go, dev client built before the module landed)
 * return null silently rather than logging a JS error.
 *
 * We still wrap require() in a try/catch as belt-and-braces in case
 * the module file itself fails to evaluate for some other reason
 * (e.g. transitive import error during a hot reload).
 */
let renderModule: typeof import('../../modules/board-renderer/src/index') | null = null;
let moduleLoadAttempted = false;
let moduleLoadFailureCount = 0;
// Cap retries so we don't call require() on every render forever in
// the genuinely-unavailable case (Expo Go, dev client without the
// native binary). The transient case — fast-refresh timing where the
// module registers slightly after JS evaluation — typically resolves
// within a render or two, well under this budget.
const MODULE_LOAD_MAX_ATTEMPTS = 5;

function getNativeModule() {
  if (moduleLoadAttempted) return renderModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    // oxlint-disable-next-line import/no-commonjs
    const loaded = require('../../modules/board-renderer/src/index') as typeof renderModule;
    // The wrapper exposes `boardRendererNative` which is null when the
    // native binary isn't loaded. Treat that as "no native renderer
    // available" — the hook returns a null overlayUri and the component
    // shows backgrounds only.
    if (loaded?.boardRendererNative) {
      renderModule = loaded;
      moduleLoadAttempted = true;
      return renderModule;
    }
  } catch {
    // fall through to the retry-budget logic below
  }
  // Either the require() threw or the native binary wasn't registered
  // yet. Leave moduleLoadAttempted = false so the next render retries,
  // until we exhaust the budget and give up for this JS context.
  moduleLoadFailureCount += 1;
  if (moduleLoadFailureCount >= MODULE_LOAD_MAX_ATTEMPTS) {
    moduleLoadAttempted = true;
    renderModule = null;
  }
  return null;
}

/**
 * Hook that drives the layered climb image: bundled backgrounds plus a
 * native-rendered holds-only PNG overlaid on top. Always renders at the
 * board's native dimensions; consumers fit/scale via expo-image. No
 * server URLs — if the native module is missing, `overlayUri` stays null
 * and the component shows backgrounds alone.
 */
export function useNativeClimbRender(params: NativeClimbRenderParams): NativeClimbRenderResult {
  const {
    frames,
    boardName,
    layoutId,
    sizeId,
    setIds,
    filledStyle = false,
    renderWidth,
    backgroundVariant,
    renderSettingsOverride,
    holdColorOverride,
    verifyOverlayFile = false,
    playSurface = false,
    maxVeilOpacity,
  } = params;
  const {
    overrides: storedHoldColorOverrides,
    shapes: holdShapeOverrides,
    brushThickness,
    shapeSize,
    renderSignature: storedHoldRenderSignature,
  } = useHoldColorOverrides();

  // ── Which hold colours this render uses ────────────────────────────────
  // A palette card supplies its own map; every real surface reads the store.
  // Substituted HERE, above the signature chain, so an override lands in the
  // cache key rather than painting palette pixels under the stored colours' key.
  // `{}` is a real value ("the board's own palette"), so the test is against
  // `undefined` rather than a truthiness check on an object that may be empty.
  const holdColorOverrides = holdColorOverride ?? storedHoldColorOverrides;
  const holdRenderSignature = useMemo(
    () =>
      holdColorOverride === undefined
        ? storedHoldRenderSignature
        : buildHoldRenderOverrideSignature({
            colors: holdColorOverride,
            shapes: holdShapeOverrides,
            brushThickness,
            shapeSize,
          }),
    [holdColorOverride, storedHoldRenderSignature, holdShapeOverrides, brushThickness, shapeSize],
  );

  // Small surfaces that pass a renderWidth want the bundled thumb-sized
  // background too, so neither the overlay nor the photo is a large source the
  // main thread has to downscale. The play-drawer carousel overrides this to
  // 'full' so it can shrink the per-climb overlay while keeping the shared photo
  // crisp on the full-screen board.
  const variant: BackgroundVariant = backgroundVariant ?? (renderWidth != null ? 'thumb' : 'full');

  // The app's resolved scheme, NOT react-native's useColorScheme(): that follows
  // the OS trait collection and on Android does not track
  // Appearance.setColorScheme, so someone running the app's own Dark theme on a
  // light-mode phone reads back 'light' and silently gets the light board art on
  // a dark screen. useAppColorScheme is its own tiny context precisely so this
  // hook — which runs in every virtualized list row — doesn't have to subscribe
  // to the whole theme object to ask one question.
  const colorScheme: BackgroundColorScheme = useAppColorScheme();

  // Run the disk-cache scan once per JS context. Safe to call on every
  // render — the function self-guards via `warmupRun`.
  warmupRenderedOverlaysOnce();

  // Subscribing to the refusal store is what makes the fallback take effect:
  // the renderer only reports "I can't draw these markers" from inside a
  // promise catch, long after this render committed.
  const unsupportedRevision = useSyncExternalStore(
    subscribeToUnsupportedSignatures,
    getUnsupportedSignatureRevision,
    getUnsupportedSignatureRevision,
  );

  // What we can actually ask the installed renderer for. Identical to the
  // user's settings unless it has refused this signature, in which case the
  // marker geometry is dropped and the colours are kept.
  const effectiveOverrides = useMemo(() => {
    // Re-resolve whenever the renderer refuses another signature.
    void unsupportedRevision;
    return resolveEffectiveRenderOverrides(
      holdColorOverrides,
      holdShapeOverrides,
      brushThickness,
      shapeSize,
      holdRenderSignature,
    );
  }, [holdColorOverrides, holdShapeOverrides, brushThickness, shapeSize, holdRenderSignature, unsupportedRevision]);
  // The marker half of the signature, resolved on its own. A marker refusal
  // degrades THIS string — not the composed one below — so a Boardsesh render
  // that hits an old-marker binary drops the shapes and keeps the drawing,
  // instead of the two halves degrading each other.
  const effectiveOverrideSignature = effectiveOverrides.signature;

  // ── Which drawing this render uses (issue #2202) ────────────────────────
  // A preview card supplies its own bundle; every real surface reads the store.
  // Substituted HERE, above the mode/veil/signature chain, so an override lands
  // in the cache key rather than painting preset pixels under the stored
  // settings' key.
  const { settings: storedRenderSettings } = useBoardRenderSettings();
  const boardRenderSettings = renderSettingsOverride ?? storedRenderSettings;
  // The probe answers from inside a promise, like the marker refusal does, so
  // subscribing is what lets a mounted surface pick the mode up at all.
  const boardseshSupportTick = useSyncExternalStore(
    subscribeToBoardseshSupport,
    getBoardseshSupportRevision,
    getBoardseshSupportRevision,
  );
  // Two native renders per launch, so only for someone whose settings or
  // rollout flag ask for the mode.
  if (requestedBoardRenderMode(boardRenderSettings) === 'aura') {
    ensureBoardseshSupportProbed();
  }

  const effectiveRenderSettings = useMemo(() => {
    void boardseshSupportTick;
    return resolveEffectiveRenderSettings(boardRenderSettings, getBoardseshRendererSupport() === true);
  }, [boardRenderSettings, boardseshSupportTick]);

  // The play field the veil washes toward. Baked into the PNG, so it is part of
  // the cache key: a light-mode overlay reused in dark mode would show a wall
  // the veil never quieted.
  const fieldColor = boardFieldColorForScheme(colorScheme);
  const veilOpacity = useMemo(() => {
    if (effectiveRenderSettings.mode !== 'aura') return 0;
    const resolved = resolveVeilOpacity(
      effectiveRenderSettings.boardsesh,
      getWallLightness({ boardName, layoutId, sizeId }),
      fieldColor,
    );
    // Only ever lowers. A surface cap is not a settings change: when the board
    // already resolves at or below it the render is untouched, so the cache key
    // (which encodes this exact number) stays shared with the uncapped surfaces.
    return maxVeilOpacity != null ? Math.min(resolved, maxVeilOpacity) : resolved;
  }, [effectiveRenderSettings, boardName, layoutId, sizeId, fieldColor, maxVeilOpacity]);
  const boardRenderSignature = useMemo(
    () => buildBoardRenderSignature(effectiveRenderSettings, fieldColor, veilOpacity),
    [effectiveRenderSettings, fieldColor, veilOpacity],
  );

  // Marker overrides (colours included — a palette card's substituted map is
  // already inside `effectiveOverrideSignature`) and render mode are independent
  // axes of the same PNG, so the cache key carries both. Empty halves drop out,
  // which keeps a classic render's key byte-identical to what it has always
  // been.
  const effectiveRenderSignature = useMemo(
    () => [effectiveOverrideSignature, boardRenderSignature].filter(Boolean).join('.'),
    [effectiveOverrideSignature, boardRenderSignature],
  );

  // Both keys feed cache lookups on every FlashList row recycle; buildCacheKey
  // runs an fnv1a char-loop over the frames string. Memoize on exactly the
  // builders' inputs — a stale key would collide two climbs' overlays.
  const currentCacheKey = useMemo(
    () =>
      buildCacheKey(boardName, layoutId, sizeId, setIds, frames, filledStyle, renderWidth, effectiveRenderSignature),
    [boardName, layoutId, sizeId, setIds, frames, filledStyle, renderWidth, effectiveRenderSignature],
  );
  const currentBoardKey = useMemo(
    () => buildBoardKey(boardName, layoutId, sizeId, setIds, variant, colorScheme),
    [boardName, layoutId, sizeId, setIds, variant, colorScheme],
  );

  // Parsed set ids, reused by the lazy background initializer and the
  // background-paths effect. Kept in sync with the strings that feed the keys.
  const setIdsArray = useMemo(() => setIds.split(',').map(Number).filter(Boolean), [setIds]);

  // Seed both pieces of state synchronously so the first paint already
  // shows whatever's available. Backgrounds in production are usually
  // available on the first frame (Asset.localUri pre-populated); the
  // overlay is available if a previous render in this session — or a
  // prior app launch — produced its file.
  const [nativeRender, setNativeRender] = useState<NativeRenderState | null>(() => {
    const existing = getRenderedOverlay(currentCacheKey);
    return existing ? { key: currentCacheKey, entry: existing, loadAttempt: 0 } : null;
  });
  const [verifiedOverlay, setVerifiedOverlay] = useState<{
    cacheKey: string;
    uri: string;
    loadKey: string;
  } | null>(null);
  const [recoveryRequest, setRecoveryRequest] = useState(0);
  // Background state combines two guards:
  //   - `key`: locks the value to a specific board config so a FlashList
  //     row recycled to a different climb can't surface the previous
  //     climb's paths (same hook instance, new props).
  //   - `missingCount`: how many expected layers the cache couldn't
  //     resolve. Surfaced to the consumer so it can render visible
  //     placeholder gaps — silently dropping a layer is the exact
  //     failure mode the no-network rule made dangerous.
  const [storedBackgrounds, setStoredBackgrounds] = useState<{
    key: string;
    paths: string[];
    missingCount: number;
  } | null>(() => {
    const sync = tryGetBackgroundPathsSync({
      boardName,
      layoutId,
      sizeId,
      setIds: setIdsArray,
      variant,
      colorScheme,
    });
    if (!sync) return null;
    return { key: currentBoardKey, paths: sync.paths, missingCount: sync.missingCount };
  });

  const mountedRef = useRef(true);
  // Tracks the cache key of the most recent overlay-effect run so a slow
  // render's resolution can be discarded once props have moved to a different
  // climb. Without this, a late .then sets nativeRender to the OLD key: the
  // key-match guard on overlayUri then returns null for the current climb and
  // nothing re-fires the effect — the board sits with unlit holds until the
  // next swipe. Hit in the play-drawer carousel when swiping onto a climb
  // whose overlay is already cached (sync branch, no new promise) while the
  // previous climb's render is still in flight.
  const latestCacheKeyRef = useRef(currentCacheKey);
  latestCacheKeyRef.current = currentCacheKey;
  const nativeRenderRef = useRef(nativeRender);
  nativeRenderRef.current = nativeRender;
  // Per-mount budget for coming back after a full-disk back-off lifts. Not keyed
  // on the cache key: a recycled row that lands on a new climb re-renders anyway.
  const diskPressureRetriesRef = useRef(0);
  const retryBudgetRef = useRef({ key: currentCacheKey, used: 0 });
  if (retryBudgetRef.current.key !== currentCacheKey) {
    retryBudgetRef.current = { key: currentCacheKey, used: 0 };
  }
  // Cache keys this hook instance has already spent its one self-retry on.
  // Per-instance and keyed, so a recycled FlashList row landing back on a climb
  // that already failed cannot start a second retry, and a key can never storm.
  const retriedCacheKeysRef = useRef(new Set<string>());
  // The pending paint watchdog, keyed by the load key it is watching, so the
  // load/error callbacks can cancel exactly the one they answer and rapid swipes
  // cannot stack timers. Armed from `onOverlayMounted`, below.
  const paintWatchdogRef = useRef<{ loadKey: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  // The pending self-retry, held in a ref because it is armed from inside an
  // async .catch — long after the effect body returned its cleanup.
  const renderRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Everything `Board Render Failed` needs about this surface. Memoized on
  // exactly its inputs so both failure paths report the same board, and so the
  // overlay-error callback's identity only moves when the board really changes.
  const failureTelemetryContext = useMemo<RenderFailureTelemetryContext>(
    () => ({
      boardName,
      layoutId,
      sizeId,
      effective: effectiveRenderSettings,
      surface: playSurface ? 'play' : filledStyle ? 'thumbnail' : 'full',
      renderWidth: renderWidth ?? null,
      framesLength: frames.length,
    }),
    // `frames`, not `frames.length`: the memo only captures the length, but the
    // effect below already depends on the whole string, so keying on the length
    // would save nothing and would put a `.length` dep in a hot hook — the one
    // shape docs/react-native-performance.md tells reviewers to reject.
    [boardName, layoutId, sizeId, effectiveRenderSettings, filledStyle, playSurface, renderWidth, frames],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Background-paths effect: always re-resolve on board config change.
  // We can't bail early on "non-empty paths" because that would treat a
  // partial result (some layers resolved, some missing) as complete and
  // never surface the true missingCount. The async resolver re-derives
  // the latest boardKey after await and discards stale results so a
  // slow resolve from a previous prop value can't clobber the current.
  useEffect(() => {
    // Try sync first when stored entry is missing or for a different
    // board: in production Asset.localUri is usually pre-populated, so
    // the sync result is the authoritative one.
    if (!storedBackgrounds || storedBackgrounds.key !== currentBoardKey) {
      const sync = tryGetBackgroundPathsSync({
        boardName,
        layoutId,
        sizeId,
        setIds: setIdsArray,
        variant,
        colorScheme,
      });
      if (sync) {
        setStoredBackgrounds({
          key: currentBoardKey,
          paths: sync.paths,
          missingCount: sync.missingCount,
        });
      }
    }

    let cancelled = false;
    void (async () => {
      const resolved = await ensureBackgroundsCached({
        boardName,
        layoutId,
        sizeId,
        setIds: setIdsArray,
        variant,
        colorScheme,
      });
      if (cancelled || !mountedRef.current) return;
      // Null = getBoardRenderData failed; leave existing state alone.
      if (!resolved) return;
      // Guard against a stale resolution from a previous boardKey
      // clobbering the current climb's state. mountedRef alone isn't
      // enough — the hook instance is still mounted, just on different
      // props now.
      const latestBoardKey = buildBoardKey(boardName, layoutId, sizeId, setIds, variant, colorScheme);
      if (latestBoardKey !== currentBoardKey) return;
      setStoredBackgrounds((prev) => {
        // Skip the state update when nothing actually changed, to avoid
        // a needless re-render. Paths are content-addressed so a length
        // + first-path comparison is sufficient.
        if (
          prev?.key === currentBoardKey &&
          prev.missingCount === resolved.missingCount &&
          prev.paths.length === resolved.paths.length &&
          prev.paths[0] === resolved.paths[0]
        ) {
          return prev;
        }
        return {
          key: currentBoardKey,
          paths: resolved.paths,
          missingCount: resolved.missingCount,
        };
      });
    })();
    return () => {
      cancelled = true;
    };
    // Re-resolve when the board config changes. storedBackgrounds is the
    // state this effect *sets*; including it would re-trigger on every
    // successful resolve. The boardKey check inside the async block
    // covers staleness across prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardName, layoutId, sizeId, setIdsArray, currentBoardKey]);

  // Overlay-render effect: kick off the native render if we don't already
  // have one for this cache key in the sync map.
  useEffect(() => {
    // A retry armed by an earlier run of this effect is stale the moment this
    // one starts. The cleanup below covers the runs that reach the render, but
    // EVERY early return in this effect registers no cleanup at all — empty
    // frames, a refused signature, no native module, no board config, a config
    // mismatch — so without this the old timer survives and bumps
    // `recoveryRequest` for a key that has moved on. First statement in the
    // body, ahead of the guards, so no bail-out path can skip it.
    if (renderRetryTimerRef.current !== null) {
      clearTimeout(renderRetryTimerRef.current);
      renderRetryTimerRef.current = null;
    }

    // effectiveOverrideSignature has already stepped away from anything the
    // renderer refused, so this only trips on the pathological case where the
    // fallback itself was somehow recorded.
    if (!frames || unsupportedRenderSignatures.has(effectiveOverrideSignature)) return;

    // Frame 0's lit placement ids, parsed ONCE: the hold-match check right below
    // needs them, and so does the Aura outline attachment inside getBoardConfig.
    const litHoldIds = parseLitHoldIds(frames);

    // Does this climb's frames even name holds this board can draw?
    //
    // The failure this catches is SILENT. A climb from another board — a Kilter
    // Homewall problem (placement ids 4000+) opened under Kilter Original 12x12
    // (ids 1080-1590) — asks the renderer to light holds the config has no
    // geometry for. The Rust renderer drops each unmatched hold and returns Ok,
    // so the promise resolves, the PNG is written and cached, and the climber
    // gets a veil with nothing drawn on it. Nothing rejects, nothing logs.
    // Verified on the Android emulator, and again by a reporter running the
    // pr-5098 preview.
    //
    // This runs ABOVE the overlay-cache lookup, which is the whole point.
    // Builds before this fix cached those veil-only PNGs under the SAME
    // RENDERER_VERSION, so the startup warm-up scan restores them from disk and
    // the cache branch below would hand one straight back — the bug would
    // survive the fix, permanently and silently, for exactly the people who
    // already hit it. Checking first also makes cache re-insertion moot: a
    // mismatched key is answered before anything consults the index.
    const boardHoldIds = litHoldIds.size > 0 ? getBoardHoldIds(boardName, layoutId, sizeId, setIds, setIdsArray) : null;
    if (boardHoldIds) {
      let matchedCount = 0;
      for (const holdId of litHoldIds) {
        if (boardHoldIds.has(holdId)) matchedCount += 1;
      }
      const unmatchedCount = litHoldIds.size - matchedCount;
      if (unmatchedCount > 0) {
        const noMatches = matchedCount === 0;
        if (claimConfigMismatchKey(currentCacheKey)) {
          noteRenderFailure({
            stage: 'config',
            failureKind: noMatches ? 'no_matching_holds' : 'partial_hold_match',
            errorCode: noMatches ? 'no_matching_holds' : 'partial_hold_match',
            context: failureTelemetryContext,
            holdMatch: { litCount: litHoldIds.size, unmatchedCount },
          });
          if (noMatches) {
            // eslint-disable-next-line no-console
            console.warn(
              `[useNativeClimbRender] no matching holds for ${currentCacheKey}: ${litHoldIds.size} lit, 0 on this board`,
            );
          }
        }
        // The SKIP is behaviour, not telemetry: it stands on every run, deduped
        // event or not.
        if (noMatches) {
          // Evict any veil-only PNG an earlier build already cached under this
          // key, so the index stops handing it out. Rendering is skipped too —
          // writing the blank result again would only make the failure quieter
          // on the next visit. Overlay stays null and the wall photo still
          // shows: the existing missing-layer contract.
          const staleEntry = getRenderedOverlay(currentCacheKey);
          if (staleEntry) invalidateRenderedOverlay(currentCacheKey, staleEntry);
          // The state seed reads the index during the FIRST render, before this
          // effect ever runs, so a stale entry is already on screen by now.
          // Dropping it from the index alone would leave it painted.
          setNativeRender((previous) => (previous?.key === currentCacheKey ? null : previous));
          return;
        }
        // A partial match still draws: a climb that legitimately reaches past a
        // smaller layout loses the holds off the edge and keeps the rest. That
        // is degraded, not blank, so it is reported and then rendered.
      }
    }

    const cachedEntry = getRenderedOverlay(currentCacheKey);
    if (cachedEntry) {
      // Sync map already has it — make sure local state reflects that
      // (covers prop changes mid-mount that pick up a previously rendered
      // overlay).
      setNativeRender((previous) => {
        if (
          previous?.key === currentCacheKey &&
          previous.entry?.uri === cachedEntry.uri &&
          previous.entry.generation === cachedEntry.generation
        ) {
          return previous;
        }
        return {
          key: currentCacheKey,
          entry: cachedEntry,
          loadAttempt: previous?.key === currentCacheKey ? previous.loadAttempt : 0,
        };
      });
      return;
    }

    const nativeModule = getNativeModule();
    if (!nativeModule) return;

    const boardConfig = getBoardConfig(
      boardName,
      layoutId,
      sizeId,
      setIds,
      filledStyle,
      renderWidth,
      effectiveOverrides.colors,
      effectiveOverrides.shapes,
      effectiveOverrides.brushThickness,
      effectiveOverrides.shapeSize,
      effectiveRenderSignature,
      effectiveRenderSettings.mode === 'aura'
        ? {
            settings: effectiveRenderSettings.boardsesh,
            glowFalloff: effectiveRenderSettings.glowFalloff,
            fieldColor,
            veilOpacity,
          }
        : null,
      litHoldIds,
    );
    if (!boardConfig) return;
    // Backed off after a full-disk failure: the write cannot succeed, and every
    // recycled row retrying it is what turned one out-of-space device into 50
    // Sentry events in 50 minutes. Overlay stays null; backgrounds still show.
    if (isDiskPressureLatched()) {
      // Come back once when the latch lifts. A list scrolls and remounts rows,
      // so it recovers on its own; a stationary play view never re-runs this
      // effect, and would sit with no overlay for the rest of the mount even
      // though the sweep this back-off kicked off may have freed the space.
      if (diskPressureRetriesRef.current >= DISK_PRESSURE_MAX_RETRIES) return;
      diskPressureRetriesRef.current += 1;
      // +1ms so the latch has certainly expired by the time the effect re-runs.
      const retryTimer = setTimeout(() => {
        if (mountedRef.current) setRecoveryRequest((request) => request + 1);
      }, diskPressureRemainingMs() + 1);
      return () => clearTimeout(retryTimer);
    }

    const renderPromise = getOrStartInflightRender(currentCacheKey, () => {
      const configJson = JSON.stringify({
        ...boardConfig.configBase,
        frames,
      });
      return nativeModule.renderHoldsOverlay(configJson, currentCacheKey);
    });

    renderPromise
      .then((renderedEntry) => {
        // Discard a stale resolution (props moved on while this render was in
        // flight) — see latestCacheKeyRef. The sync map above still keeps the
        // file, so swiping back to this climb is an instant cache hit.
        if (mountedRef.current && latestCacheKeyRef.current === currentCacheKey) {
          setNativeRender((previous) => ({
            key: currentCacheKey,
            entry: renderedEntry,
            loadAttempt: previous?.key === currentCacheKey ? previous.loadAttempt : 0,
          }));
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // A renderer that cannot honour this config's marker overrides is a
        // designed capability fallback (a native binary that predates marker
        // support), not a defect. Recording the signature makes
        // resolveEffectiveRenderOverrides drop the marker geometry and re-render
        // with colours only — the notification it fires is what re-runs this
        // effect under the degraded cache key. Never record
        // DEFAULT_HOLD_COLOR_SIGNATURE: it is the last fallback, so poisoning it
        // would blank the overlay on every board.
        const isMarkerFallback = message.includes(MARKER_RENDERER_UNAVAILABLE_MESSAGE);
        if (isMarkerFallback && effectiveOverrideSignature !== DEFAULT_HOLD_COLOR_SIGNATURE) {
          markRenderSignatureUnsupported(effectiveOverrideSignature);
        }
        // A library that cannot draw the Boardsesh mode is a property of the
        // BINARY, not of this config, so the latch is global: every mounted
        // surface re-resolves to classic on the next tick and nothing asks
        // again for the rest of this JS lifetime. Recording it as an
        // unsupported signature instead would degrade the climber's marker
        // overrides, which this binary draws perfectly well.
        const isBoardseshFallback = message.includes(BOARDSESH_RENDERER_UNAVAILABLE_MESSAGE);
        if (isBoardseshFallback) setBoardseshRendererSupport(false);
        const isCapabilityFallback = isMarkerFallback || isBoardseshFallback;
        // Native render failed -- overlay stays null, backgrounds still show.
        // Surface the cause in Metro logs so we can diagnose; without this
        // the silent catch masked every binary/ABI mismatch behind a blank
        // overlay layer.
        // eslint-disable-next-line no-console
        console.warn(`[useNativeClimbRender] render failed for ${currentCacheKey}:`, message);
        // Don't page on the capability fallback — it re-fires once per climb
        // whenever the signature stays default (issue #4240: 29 Sentry events
        // in 60s from one session). It is still a render that did not draw what
        // the climber asked for, so it is still counted and reported to PostHog,
        // where the cap rather than a once-guard keeps the volume sane.
        if (isCapabilityFallback) {
          noteRenderFailure({
            stage: 'native',
            failureKind: 'capability_fallback',
            errorCode: 'capability',
            context: failureTelemetryContext,
          });
          return;
        }
        const kind = classifyRenderFailure(message, measureFreeCacheSpaceBytes());
        if (kind === 'disk_full') latchDiskPressure();
        const failuresThisSession = noteRenderFailure({
          stage: 'native',
          failureKind: kind,
          errorCode: classifyBoardRenderErrorCode(message),
          context: failureTelemetryContext,
        });
        reportRenderFailureOnce({
          kind,
          error,
          message,
          boardName,
          extra: {
            layoutId,
            sizeId,
            setIds,
            filledStyle,
            renderWidth,
            framesLength: frames.length,
            cacheKey: currentCacheKey,
            failuresThisSession,
          },
        });
        // One self-retry, once per cache key, per hook instance.
        //
        // The failure this exists for is a play board that stops drawing holds
        // mid-session and never comes back: nothing about the climb changed, so
        // no prop moves, no effect re-runs, and the overlay stays missing until
        // the app restarts. `getOrStartInflightRender` already dropped the
        // settled promise in its `.finally`, so bumping the nonce re-enters the
        // render path cleanly. Deliberately NOT for `disk_full` (the back-off
        // above owns that, and retrying a write on a full volume is the storm)
        // and NOT for a capability fallback (the degraded re-render IS the
        // retry). The keyed guard is what makes a recycled row safe.
        if (kind === 'render_failed' && !retriedCacheKeysRef.current.has(currentCacheKey)) {
          retriedCacheKeysRef.current.add(currentCacheKey);
          if (renderRetryTimerRef.current !== null) clearTimeout(renderRetryTimerRef.current);
          renderRetryTimerRef.current = setTimeout(() => {
            renderRetryTimerRef.current = null;
            if (mountedRef.current) setRecoveryRequest((request) => request + 1);
          }, RENDER_RETRY_DELAY_MS);
        }
      });

    return () => {
      // A retry armed by the run being torn down is stale: the effect is about
      // to run again anyway (a dep changed) or the surface is unmounting. The
      // timer that just fired has already nulled this, so the common case is a
      // no-op.
      if (renderRetryTimerRef.current !== null) {
        clearTimeout(renderRetryTimerRef.current);
        renderRetryTimerRef.current = null;
      }
    };
    // nativeRender is intentionally excluded from deps: this effect *sets* it.
    // recoveryRequest is the explicit same-key re-trigger after an exact stale
    // entry is invalidated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentCacheKey,
    frames,
    boardName,
    layoutId,
    sizeId,
    setIds,
    filledStyle,
    renderWidth,
    effectiveOverrides,
    effectiveOverrideSignature,
    effectiveRenderSignature,
    effectiveRenderSettings,
    fieldColor,
    veilOpacity,
    recoveryRequest,
    failureTelemetryContext,
  ]);

  /**
   * Cancel the paint watchdog for one load key. A null key cancels whatever is
   * pending — used by the error path, where any answer at all means expo-image
   * is not silent, which is the only thing the watchdog is watching for.
   */
  const clearPaintWatchdog = useCallback((emittingLoadKey: string | null) => {
    const pending = paintWatchdogRef.current;
    if (!pending) return;
    if (emittingLoadKey !== null && pending.loadKey !== emittingLoadKey) return;
    clearTimeout(pending.timer);
    paintWatchdogRef.current = null;
  }, []);

  // Read through a ref so `onOverlayMounted` — which the view layer calls from an
  // effect — keeps a stable identity and cannot itself re-arm the watchdog.
  const failureTelemetryContextRef = useRef(failureTelemetryContext);
  failureTelemetryContextRef.current = failureTelemetryContext;

  /**
   * The view layer reports whether an overlay `<Image>` is actually MOUNTED:
   * its load key while one is, `null` the moment there is none.
   *
   * Arming on the mount rather than on `overlayUri` is the whole correctness
   * argument. `LayeredClimbImage` renders a bare `<View>` and no image at all
   * while the app is backgrounded or the tab's board art is released (opening
   * `/play` does exactly that to every other surface). Nothing then fires
   * `onLoad` — there is nothing there to fire it — so a watchdog armed on the
   * URI would report silence from a surface that was never asked to paint, and
   * a backgrounded app's timers would land on resume before the remount.
   *
   * `playSurface` gates it to the one board a climber is actually waiting on.
   */
  const onOverlayMounted = useCallback(
    (mountedLoadKey: string | null) => {
      const pending = paintWatchdogRef.current;
      if (pending) {
        clearTimeout(pending.timer);
        paintWatchdogRef.current = null;
      }
      if (!playSurface || mountedLoadKey === null) return;
      const timer = setTimeout(() => {
        paintWatchdogRef.current = null;
        if (!mountedRef.current) return;
        // eslint-disable-next-line no-console
        console.warn(`[useNativeClimbRender] overlay never painted within ${OVERLAY_PAINT_TIMEOUT_MS}ms`);
        noteRenderFailure({
          stage: 'image_load',
          failureKind: 'paint_timeout',
          errorCode: 'paint_timeout',
          context: failureTelemetryContextRef.current,
        });
      }, OVERLAY_PAINT_TIMEOUT_MS);
      paintWatchdogRef.current = { loadKey: mountedLoadKey, timer };
    },
    [playSurface],
  );

  // The view layer's mount effect disarms on its own teardown, but only while it
  // is mounted at all. This covers the hook outliving nothing — a surface that
  // unmounts with a watch still pending.
  useEffect(
    () => () => {
      const pending = paintWatchdogRef.current;
      if (pending) {
        clearTimeout(pending.timer);
        paintWatchdogRef.current = null;
      }
    },
    [],
  );

  const onOverlayLoad = useCallback(
    (emittingLoadKey: string | null) => {
      // Before the key-match guards below: a paint is a paint, and the watchdog
      // only ever asks whether expo-image answered.
      clearPaintWatchdog(emittingLoadKey);
      const expected = nativeRenderRef.current;
      if (
        !isLoadedNativeRender(expected) ||
        expected.key !== currentCacheKey ||
        `${expected.entry.generation}:${expected.loadAttempt}` !== emittingLoadKey
      )
        return;

      // A successful replacement is the only event that replenishes this
      // consumer's retry budget. Merely finishing the native render is not proof
      // that expo-image could load the regenerated file.
      if (expected.loadAttempt > 0 && retryBudgetRef.current.key === expected.key) {
        retryBudgetRef.current.used = 0;
      }
    },
    [currentCacheKey, clearPaintWatchdog],
  );

  const onOverlayError = useCallback(
    (event: { error: string }, emittingLoadKey: string | null) => {
      // Keyed, exactly like onOverlayLoad. A late `onError` from the PREVIOUS
      // image arrives after the new one is already mounted and watched, and an
      // unconditional clear let that stale answer cancel the new image's watch —
      // silencing the very case the watchdog exists to catch.
      clearPaintWatchdog(emittingLoadKey);
      // expo-image's message names the file it could not load, so it is bucketed
      // to a closed set of codes before it goes anywhere. `png` here means the
      // decoder said so, not that a filename happened to end in `.png`.
      const errorCode = classifyBoardRenderErrorCode(event.error);
      const expected = nativeRenderRef.current;
      if (
        !isLoadedNativeRender(expected) ||
        expected.key !== currentCacheKey ||
        `${expected.entry.generation}:${expected.loadAttempt}` !== emittingLoadKey
      )
        return;
      const expectedEntry = expected.entry;

      const peerReplacement = getRenderedOverlay(expected.key);
      if (
        peerReplacement &&
        (peerReplacement.uri !== expectedEntry.uri || peerReplacement.generation !== expectedEntry.generation)
      ) {
        // A peer may have rewritten the same URI before this consumer's
        // delayed onError arrives. The file then exists because it belongs to
        // the newer generation, so compare generations before classifying an
        // existing file as a terminal decode failure.
        if (retryBudgetRef.current.key !== expected.key || retryBudgetRef.current.used >= 1) {
          reportOverlayLoadFailure({ kind: 'retry_exhausted', errorCode, context: failureTelemetryContext });
          setNativeRender((previous) => (isExactNativeRender(previous, expected) ? null : previous));
          return;
        }
        retryBudgetRef.current.used += 1;
        setNativeRender((previous) =>
          isExactNativeRender(previous, expected)
            ? {
                key: expected.key,
                entry: peerReplacement,
                loadAttempt: expected.loadAttempt + 1,
              }
            : previous,
        );
        return;
      }

      let entryExists: boolean | null;
      try {
        entryExists = overlayCacheEntryExists(expectedEntry.uri);
      } catch {
        reportOverlayLoadFailure({ kind: 'validation_failed', errorCode, context: failureTelemetryContext });
        setNativeRender((previous) => (isExactNativeRender(previous, expected) ? null : previous));
        return;
      }

      // A present file can still be a transient native image decode failure.
      // Keep the exact generated entry, but remount expo-image once with a new
      // attempt key so it retries the same URI without triggering a render.
      if (entryExists === true) {
        if (retryBudgetRef.current.key !== expected.key || retryBudgetRef.current.used >= 1) {
          // One event, naming what became of the image; Sentry still hears both
          // classes.
          reportOverlayLoadFailure({
            kind: 'retry_exhausted',
            alsoDiagnose: 'cache_entry_present',
            errorCode,
            context: failureTelemetryContext,
          });
          setNativeRender((previous) => (isExactNativeRender(previous, expected) ? null : previous));
          return;
        }
        reportOverlayLoadFailure({ kind: 'cache_entry_present', errorCode, context: failureTelemetryContext });
        retryBudgetRef.current.used += 1;
        setNativeRender((previous) =>
          isExactNativeRender(previous, expected)
            ? {
                key: expected.key,
                entry: expectedEntry,
                loadAttempt: expected.loadAttempt + 1,
              }
            : previous,
        );
        return;
      }

      // Unknown validation (the web twin) is terminal: guessing would turn
      // every unsupported image into a render loop.
      if (entryExists === null) {
        reportOverlayLoadFailure({ kind: 'validation_unsupported', errorCode, context: failureTelemetryContext });
        setNativeRender((previous) => (isExactNativeRender(previous, expected) ? null : previous));
        return;
      }

      if (retryBudgetRef.current.key !== expected.key || retryBudgetRef.current.used >= 1) {
        reportOverlayLoadFailure({
          kind: 'retry_exhausted',
          alsoDiagnose: 'cache_entry_missing',
          errorCode,
          context: failureTelemetryContext,
        });
        setNativeRender((previous) => (isExactNativeRender(previous, expected) ? null : previous));
        return;
      }
      reportOverlayLoadFailure({ kind: 'cache_entry_missing', errorCode, context: failureTelemetryContext });
      retryBudgetRef.current.used += 1;

      invalidateRenderedOverlay(expected.key, expectedEntry);
      const latePeerReplacement = getRenderedOverlay(expected.key);
      if (
        latePeerReplacement &&
        (latePeerReplacement.uri !== expectedEntry.uri || latePeerReplacement.generation !== expectedEntry.generation)
      ) {
        // Another mounted surface already repaired this key. Never delete its
        // newer generation; remount only this failed consumer against it.
        setNativeRender((previous) =>
          isExactNativeRender(previous, expected)
            ? {
                key: expected.key,
                entry: latePeerReplacement,
                loadAttempt: expected.loadAttempt + 1,
              }
            : previous,
        );
        return;
      }

      // Unmount the failed Image while the shared in-flight render repairs the
      // cache. The nonce re-runs the effect without changing the climb key.
      setNativeRender((previous) =>
        isExactNativeRender(previous, expected)
          ? { key: expected.key, entry: null, loadAttempt: expected.loadAttempt + 1 }
          : previous,
      );
      setRecoveryRequest((request) => request + 1);
    },
    [currentCacheKey, failureTelemetryContext, clearPaintWatchdog],
  );

  const verifyOverlayForNativeUse = useCallback(
    (requestedUri: string | null, requestedLoadKey: string | null): string | null => {
      if (!verifyOverlayFile || !requestedUri) return requestedUri;
      const expected = nativeRenderRef.current;
      if (
        !isLoadedNativeRender(expected) ||
        expected.key !== currentCacheKey ||
        expected.entry.uri !== requestedUri ||
        `${expected.entry.generation}:${expected.loadAttempt}` !== requestedLoadKey
      ) {
        return null;
      }
      try {
        if (overlayCacheEntryExists(requestedUri) === true) {
          onOverlayLoad(requestedLoadKey);
          return requestedUri;
        }
      } catch {
        // The exact-attempt handler below classifies and reports validation
        // failures without including the private cache URI.
      }
      onOverlayError({ error: 'Generated overlay failed native-use validation' }, requestedLoadKey);
      return null;
    },
    [currentCacheKey, onOverlayError, onOverlayLoad, verifyOverlayFile],
  );

  // Only surface the native URI if it matches the *current* cache key —
  // a stale render (from before a prop change) would otherwise show.
  const candidateOverlayUri =
    frames && nativeRender?.key === currentCacheKey ? (nativeRender.entry?.uri ?? null) : null;
  const overlayLoadKey =
    frames && nativeRender?.key === currentCacheKey && nativeRender.entry
      ? `${nativeRender.entry.generation}:${nativeRender.loadAttempt}`
      : null;
  const verifiedOverlayFile =
    !verifyOverlayFile ||
    !candidateOverlayUri ||
    (overlayLoadKey != null &&
      verifiedOverlay?.cacheKey === currentCacheKey &&
      verifiedOverlay.uri === candidateOverlayUri &&
      verifiedOverlay.loadKey === overlayLoadKey);
  const overlayUri = verifiedOverlayFile ? candidateOverlayUri : null;

  useEffect(() => {
    if (!verifyOverlayFile || !candidateOverlayUri || !overlayLoadKey) {
      setVerifiedOverlay(null);
      return;
    }

    if (verifyOverlayForNativeUse(candidateOverlayUri, overlayLoadKey)) {
      setVerifiedOverlay((previous) => {
        if (
          previous?.cacheKey === currentCacheKey &&
          previous.uri === candidateOverlayUri &&
          previous.loadKey === overlayLoadKey
        ) {
          return previous;
        }
        return { cacheKey: currentCacheKey, uri: candidateOverlayUri, loadKey: overlayLoadKey };
      });
      return;
    }

    setVerifiedOverlay(null);
    // verifyOverlayForNativeUse owns exact-attempt recovery. This state change
    // withholds the stale path from subsequent notification renders.
  }, [candidateOverlayUri, currentCacheKey, overlayLoadKey, verifyOverlayFile, verifyOverlayForNativeUse]);
  // Same guard for backgrounds: a stored entry from a prior boardKey
  // (FlashList row recycle case) must not bleed through to the new climb.
  const backgroundPaths = storedBackgrounds?.key === currentBoardKey ? storedBackgrounds.paths : [];
  const missingBackgroundCount = storedBackgrounds?.key === currentBoardKey ? storedBackgrounds.missingCount : 0;
  return {
    overlayUri,
    overlayLoadKey,
    onOverlayLoad,
    onOverlayError,
    onOverlayMounted,
    verifyOverlayForNativeUse,
    backgroundPaths,
    missingBackgroundCount,
    effectiveRenderSettings,
    boardseshRendererAvailable: getBoardseshRendererSupport(),
  };
}

/**
 * The resolved render mode without rendering anything — for the settings
 * screen, which has to describe the drawing the app will use (and say when the
 * installed binary cannot draw it) without mounting a board.
 *
 * Kicks the capability probe on the same terms the render path does, so opening
 * the screen is enough to find out whether the mode is available at all.
 */
export function useEffectiveBoardRenderSettings(): {
  effectiveRenderSettings: EffectiveBoardRenderSettings;
  boardseshRendererAvailable: boolean | null;
} {
  const { settings } = useBoardRenderSettings();
  const boardseshSupportTick = useSyncExternalStore(
    subscribeToBoardseshSupport,
    getBoardseshSupportRevision,
    getBoardseshSupportRevision,
  );

  if (requestedBoardRenderMode(settings) === 'aura') ensureBoardseshSupportProbed();

  const effectiveRenderSettings = useMemo(() => {
    void boardseshSupportTick;
    return resolveEffectiveRenderSettings(settings, getBoardseshRendererSupport() === true);
  }, [settings, boardseshSupportTick]);

  return { effectiveRenderSettings, boardseshRendererAvailable: getBoardseshRendererSupport() };
}
