import { useEffect, useState, useRef } from 'react';
import { Directory, Paths } from 'expo-file-system';
import type { BoardName } from '@boardsesh/shared-schema';
import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import { getBoardRenderData } from '../lib/board-details';
import {
  ensureBackgroundsCached,
  tryGetBackgroundPathsSync,
  type BackgroundVariant,
} from '../lib/background-image-cache';
import { reportError } from '../lib/error-reporting';
import {
  DEFAULT_HOLD_COLOR_SIGNATURE,
  DEFAULT_HOLD_BRUSH_THICKNESS,
  DEFAULT_HOLD_MARKER_SHAPE,
  DEFAULT_HOLD_SHAPE_SIZE,
  getEffectiveHoldStateColor,
  getEffectiveHoldStateShape,
  useHoldColorOverrides,
  type HoldColorOverrides,
  type HoldShapeOverrides,
} from '../lib/hold-color-overrides';

/**
 * Bump when the native overlay output/cache contract changes. v2 marks
 * the switch from composited PNGs (backgrounds baked in) to overlay-only
 * PNGs (transparent background, holds only). v3 marks marker shape,
 * brush, and size override support, and drops any wrong custom-marker
 * PNGs written by overlay-only dev binaries during rollout.
 */
const RENDERER_VERSION = 3;
const MARKER_RENDERER_UNAVAILABLE_MESSAGE =
  'Marker shape, size, and brush overrides require a rebuilt BoardRenderer native binary';

/** Subset of expo-file-system's `File`: its synchronous `delete()`. */
type DeletableFsEntry = { delete?: () => void };

/**
 * Inputs to the native climb renderer. Just the climb identity — no
 * render-size or quality knobs. The hook always renders at the board's
 * native pixel dimensions (from getBoardRenderData) and the consuming
 * <Image> scales it down via contentFit="contain" for small surfaces
 * like the list thumbnail.
 *
 * Note: no `mirrored` here. Callers (ClimbListThumbnail, BoardImageNative)
 * flip with a CSS scaleX(-1) so a single cached PNG serves both
 * orientations. If we ever need true Rust-side mirroring (e.g. for an
 * export pipeline that doesn't go through <Image>), thread it back in
 * AND propagate to configBase.mirrored — don't just re-add the cache
 * key suffix, that desyncs the cache from what gets rendered.
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
   * upscales). Also selects the bundled `thumb` background variant.
   */
  renderWidth?: number;
  /**
   * Freeze-debug bisection toggle (Android-16 climb-list freeze). When false,
   * skip the native hold-overlay render entirely so list cells stay placeholders,
   * confirming or ruling out the board-activation native-render burst on a real
   * affected device. Defaults to true (render normally).
   */
  enabled?: boolean;
};

type NativeClimbRenderResult = {
  /**
   * file:// URI of the holds-only PNG, or null until the Rust render
   * completes (or forever if the native module is unavailable, e.g.
   * Expo Go). Consumers stack this on top of `backgroundPaths`.
   */
  overlayUri: string | null;
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
};

/**
 * Deduplicate concurrent renders for the same cache key. Entries
 * self-delete via `.finally` when the underlying render settles, so under
 * normal usage the map only holds a handful of in-flight promises at any
 * moment. The hard cap is defence against a pathological burst (e.g. a
 * huge list scrolled before any render completes) leaving stale entries
 * if components unmount mid-render.
 */
const inflightRenders = new Map<string, Promise<string>>();
const INFLIGHT_RENDERS_MAX = 50;
const unsupportedRenderSignatures = new Set<string>();

const BOARD_CONFIG_CACHE_MAX = 20;

/**
 * Synchronous lookup of already-rendered overlay PNGs keyed by cache key.
 * Populated when (a) any successful render completes, and (b) on first
 * module import we scan the on-disk cache directory to surface PNGs from
 * prior app sessions.
 *
 * This is the mechanism that makes drawer-open instant after the list
 * has scrolled past a climb: the hook's useState initial value reads
 * from this map, so a cache hit displays the overlay on the very first
 * render with no useEffect-driven update.
 */
const renderedOverlays = new Map<string, string>();

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
    const cacheDir = new Directory(Paths.cache, CACHE_DIR_NAME);
    if (!cacheDir.exists) return;
    // Only PNGs from the current RENDERER_VERSION can be reused. Older
    // version prefixes (e.g. v1_*) describe a different render format and
    // would never be matched by cacheKey lookups, so loading them into
    // the map just wastes memory. Opportunistically delete those stale
    // files to reclaim disk while we're already walking the directory.
    const currentVersionPrefix = `v${RENDERER_VERSION}_`;
    for (const entry of cacheDir.list()) {
      if (!('uri' in entry) || typeof entry.uri !== 'string') continue;
      // Files only — skip subdirectories. expo-file-system returns
      // File and Directory instances; File has a .name like "<key>.png".
      const name = (entry as { name?: string }).name;
      if (!name || !name.endsWith('.png')) continue;
      if (!name.startsWith(currentVersionPrefix)) {
        // Stale leftover from a prior RENDERER_VERSION. Best-effort delete;
        // any failure (permissions, race with another writer) is non-fatal
        // — the file simply lingers until the OS reclaims cache space.
        try {
          (entry as DeletableFsEntry).delete?.();
        } catch {
          // Swallow — never let a delete failure crash the warmup.
        }
        continue;
      }
      const cacheKey = name.slice(0, -'.png'.length);
      renderedOverlays.set(cacheKey, entry.uri);
    }
  } catch {
    // Filesystem errors at startup shouldn't break the app — the hook's
    // render path will repopulate the map as climbs are viewed.
  }
}

/** Test-only handle for re-running the warm-up against a fresh mock list. */
export function _resetWarmupForTests(): void {
  warmupRun = false;
  renderedOverlays.clear();
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
export function getOrStartInflightRender(cacheKey: string, startRender: () => Promise<string>): Promise<string> {
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

  const promise = startRender();
  inflightRenders.set(cacheKey, promise);
  // Run cleanup as a detached handler so it doesn't change the promise
  // returned to callers, and so callers that only attach .then can still
  // observe rejections.
  void promise
    .finally(() => {
      inflightRenders.delete(cacheKey);
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
export const _renderedOverlaysForTests = renderedOverlays;

/** Memoize board render configs to avoid re-computing hold positions */
const boardConfigCache = new Map<
  string,
  {
    configBase: Record<string, unknown>;
    setIdsArray: number[];
  }
>();

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
  const effectiveRenderSignature = frames.length === 0 ? DEFAULT_HOLD_COLOR_SIGNATURE : renderSignature;
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
): string {
  // Variant is part of the identity so a FlashList row recycled between a
  // thumb context (list) and a full context can't surface the wrong-size
  // background paths from the previous climb.
  return `${boardName}-${layoutId}-${sizeId}-${setIds}-${variant}`;
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
) {
  const widthKey = renderWidth != null ? `${renderWidth}` : 'full';
  const configKey = `${boardName}-${layoutId}-${sizeId}-${setIds}-${filledStyle ? 'f' : 's'}-w${widthKey}-${renderSignature}`;
  const cached = boardConfigCache.get(configKey);
  if (cached) return cached;

  const setIdsArray = setIds.split(',').map(Number).filter(Boolean);
  const renderData = getBoardRenderData({ boardName, layoutId, sizeId, setIds: setIdsArray });
  if (!renderData) return null;

  // Build hold_state_map in the format the Rust renderer expects:
  // Record<number, { color: string, render_style?: string }>
  const stateMap = HOLD_STATE_MAP[boardName];
  const holdStateMap: Record<number, { color: string; render_style?: string; shape?: string }> = {};
  for (const [codeStr, stateInfo] of Object.entries(stateMap)) {
    const shape = getEffectiveHoldStateShape(stateInfo.name, shapeOverrides);
    holdStateMap[Number(codeStr)] = {
      color: getEffectiveHoldStateColor(stateInfo.name, stateInfo.color, colorOverrides),
      ...(stateInfo.renderStyle ? { render_style: stateInfo.renderStyle } : {}),
      ...(shape !== DEFAULT_HOLD_MARKER_SHAPE ? { shape } : {}),
    };
  }

  // Small surfaces (list/accessory) pass a renderWidth so the Rust
  // renderer rasterizes a small PNG (e.g. 400px) instead of the board's
  // native ~1080px — the consuming <Image> then has nothing large to
  // downscale on the main thread. Clamp to the board width so we never
  // upscale. The play view omits renderWidth and renders at native width.
  const outputWidth = renderWidth != null ? Math.min(renderWidth, renderData.boardWidth) : renderData.boardWidth;
  const configBase = {
    board_width: renderData.boardWidth,
    board_height: renderData.boardHeight,
    output_width: outputWidth,
    thumbnail: filledStyle,
    stroke_width_multiplier: brushThickness,
    shape_size_multiplier: shapeSize,
    holds: renderData.holdsData.map((hold) => ({
      id: hold.id,
      mirroredHoldId: hold.mirroredHoldId,
      cx: hold.cx,
      cy: hold.cy,
      r: hold.r,
    })),
    hold_state_map: holdStateMap,
  };

  // Evict oldest entry when the cache exceeds the cap
  if (boardConfigCache.size >= BOARD_CONFIG_CACHE_MAX) {
    const oldestKey = boardConfigCache.keys().next().value;
    if (oldestKey !== undefined) {
      boardConfigCache.delete(oldestKey);
    }
  }

  const boardConfig = { configBase, setIdsArray };
  boardConfigCache.set(configKey, boardConfig);
  return boardConfig;
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
  );
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
  const { frames, boardName, layoutId, sizeId, setIds, filledStyle = false, renderWidth, enabled = true } = params;
  const {
    overrides: holdColorOverrides,
    shapes: holdShapeOverrides,
    brushThickness,
    shapeSize,
    renderSignature: holdRenderSignature,
  } = useHoldColorOverrides();

  // Small surfaces that pass a renderWidth want the bundled thumb-sized
  // background too, so neither the overlay nor the photo is a large source
  // the main thread has to downscale.
  const variant: BackgroundVariant = renderWidth != null ? 'thumb' : 'full';

  // Run the disk-cache scan once per JS context. Safe to call on every
  // render — the function self-guards via `warmupRun`.
  warmupRenderedOverlaysOnce();

  const currentCacheKey = buildCacheKey(
    boardName,
    layoutId,
    sizeId,
    setIds,
    frames,
    filledStyle,
    renderWidth,
    holdRenderSignature,
  );
  const currentBoardKey = buildBoardKey(boardName, layoutId, sizeId, setIds, variant);

  // Seed both pieces of state synchronously so the first paint already
  // shows whatever's available. Backgrounds in production are usually
  // available on the first frame (Asset.localUri pre-populated); the
  // overlay is available if a previous render in this session — or a
  // prior app launch — produced its file.
  const [nativeRender, setNativeRender] = useState<{ key: string; uri: string } | null>(() => {
    const existing = renderedOverlays.get(currentCacheKey);
    return existing ? { key: currentCacheKey, uri: existing } : null;
  });
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
      setIds: setIds.split(',').map(Number).filter(Boolean),
      variant,
    });
    if (!sync) return null;
    return { key: currentBoardKey, paths: sync.paths, missingCount: sync.missingCount };
  });

  const mountedRef = useRef(true);

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
    const setIdsArray = setIds.split(',').map(Number).filter(Boolean);

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
      });
      if (cancelled || !mountedRef.current) return;
      // Null = getBoardRenderData failed; leave existing state alone.
      if (!resolved) return;
      // Guard against a stale resolution from a previous boardKey
      // clobbering the current climb's state. mountedRef alone isn't
      // enough — the hook instance is still mounted, just on different
      // props now.
      const latestBoardKey = buildBoardKey(boardName, layoutId, sizeId, setIds, variant);
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
  }, [boardName, layoutId, sizeId, setIds, currentBoardKey]);

  // Overlay-render effect: kick off the native render if we don't already
  // have one for this cache key in the sync map.
  useEffect(() => {
    if (!enabled || !frames || unsupportedRenderSignatures.has(holdRenderSignature)) return;

    if (renderedOverlays.has(currentCacheKey)) {
      // Sync map already has it — make sure local state reflects that
      // (covers prop changes mid-mount that pick up a previously rendered
      // overlay).
      const uri = renderedOverlays.get(currentCacheKey);
      if (uri && nativeRender?.key !== currentCacheKey) {
        setNativeRender({ key: currentCacheKey, uri });
      }
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
      holdColorOverrides,
      holdShapeOverrides,
      brushThickness,
      shapeSize,
      holdRenderSignature,
    );
    if (!boardConfig) return;

    const renderPromise = getOrStartInflightRender(currentCacheKey, () => {
      const configJson = JSON.stringify({
        ...boardConfig.configBase,
        frames,
      });
      return nativeModule.renderHoldsOverlay(configJson, currentCacheKey);
    });

    renderPromise
      .then((fileUri) => {
        renderedOverlays.set(currentCacheKey, fileUri);
        if (mountedRef.current) setNativeRender({ key: currentCacheKey, uri: fileUri });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (
          holdRenderSignature !== DEFAULT_HOLD_COLOR_SIGNATURE &&
          message.includes(MARKER_RENDERER_UNAVAILABLE_MESSAGE)
        ) {
          unsupportedRenderSignatures.add(holdRenderSignature);
        }
        // Native render failed -- overlay stays null, backgrounds still show.
        // Surface the cause in Metro logs so we can diagnose; without this
        // the silent catch masked every binary/ABI mismatch behind a blank
        // overlay layer.
        // eslint-disable-next-line no-console
        console.warn(`[useNativeClimbRender] render failed for ${currentCacheKey}:`, message);
        reportError(error, {
          tags: {
            feature: 'mobile_board_renderer',
            boardName,
          },
          extra: {
            layoutId,
            sizeId,
            setIds,
            filledStyle,
            renderWidth,
            framesLength: frames.length,
            cacheKey: currentCacheKey,
          },
        });
      });
    // nativeRender is intentionally excluded from deps: this effect *sets* it,
    // and the only meaningful re-trigger is a cacheKey change.
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
    holdColorOverrides,
    holdShapeOverrides,
    brushThickness,
    shapeSize,
    holdRenderSignature,
    enabled,
  ]);

  // Only surface the native URI if it matches the *current* cache key —
  // a stale render (from before a prop change) would otherwise show.
  const overlayUri = frames && nativeRender?.key === currentCacheKey ? nativeRender.uri : null;
  // Same guard for backgrounds: a stored entry from a prior boardKey
  // (FlashList row recycle case) must not bleed through to the new climb.
  const backgroundPaths = storedBackgrounds?.key === currentBoardKey ? storedBackgrounds.paths : [];
  const missingBackgroundCount = storedBackgrounds?.key === currentBoardKey ? storedBackgrounds.missingCount : 0;
  return { overlayUri, backgroundPaths, missingBackgroundCount };
}
