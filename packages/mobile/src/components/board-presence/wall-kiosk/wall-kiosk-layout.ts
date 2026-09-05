/**
 * Pure layout math for the wall-mounted "On the Wall" kiosk. No react-native
 * imports, so the whole engine unit-tests as plain functions across the board
 * catalog × device × orientation grid (mirrors `size-class.ts` and
 * `play-drawer-layout.ts`).
 *
 * THE INVIOLABLE RULE. The board must ALWAYS be shown in full, and NOTHING may
 * ever render over it except the climb's own holds. So this engine splits the
 * content pane into a BOARD REGION + a single always-reserved off-board CHROME
 * REGION that never overlap: `chromeRect` is carved out first, the board
 * contain-fits into what remains. The board and chrome are siblings — there is no
 * "overlay" route and chrome is never null.
 *
 * WHICH AXIS. Board aspect ratios span ~0.43 (tall) to ~1.81 (wide). To keep the
 * board as large as possible we pick the reserve axis by argmax(board area): a
 * tall board leaves a side gutter a RAIL eats for free; a wide board leaves a
 * vertical gutter a BAND eats for free; a near-pane-AR board makes both steal, and
 * argmax picks the axis that shrinks the board least at the stable design-preferred
 * extents. Content floors size the chosen region afterward, so copy or an added
 * byline cannot teleport a board between rail and band. The board is then docked
 * flush to the chrome (dead letterbox pools on the far edge — handled by the
 * component's flexbox), and drawn square-cornered so it is literally shown in full.
 */

import { computeContainedBoardSize, type BoardBox } from '../../play-drawer/play-drawer-layout';
import type { WallStateMode } from './WallStateStrip';

// ── Named constants (device-relative via heroScale so a smaller iPad is never
//    starved; the actual mins can be raised further by the caller's content
//    floor, so the chrome always fits the climb name + controls) ───────────────

export const RAIL_MIN = 320;
export const RAIL_PREF = 360;
export const RAIL_MAX = 440;
export const BAND_MIN = 236;
export const BAND_PREF = 272;
export const BAND_MAX = 320;

/** The board must stay at least this fraction of its chrome-free maximum area
 *  before the chrome is allowed to steal more (a growth ceiling on chrome). */
export const BOARD_AREA_FLOOR = 0.55;

/** The chrome extent may never exceed this fraction of the board's extent on the
 *  same axis, so the board is ALWAYS the largest single region. */
export const ZONE_DOMINANCE_RATIO = 0.85;

/** A challenger axis must beat the incumbent's board area by more than this to
 *  flip the region — kills rail↔band strobing on a Split-View drag / rotation. */
export const LEDGER_AXIS_HYSTERESIS = 0.04;

/** When the dominance cap wants a rail narrower than the legible min, the min
 *  wins AS LONG AS the board is still wider than it (area-dominance holds). Only
 *  when the board itself is narrower than the rail min would a full rail out-mass
 *  the board — then fall back to this controls-only compact rail width + a "rotate
 *  for a bigger board" hint. */
export const COMPACT_RAIL_MIN = 200;
export const COMPACT_BAND_MIN = 168;

/** Gap between the board and the chrome. Mirrors `spacing[4]`. */
export const WALL_KIOSK_GAP = 16;

/** Quantize measured pane dimensions before resolving, to kill sub-pixel jitter. */
export const WALL_KIOSK_QUANTUM = 8;

export type WallKioskRegion = 'rail' | 'band';

export type WallKioskInsets = { top: number; bottom: number; left: number; right: number };

export type WallKioskLayout = {
  /** Which edge the chrome docks: a trailing RAIL (landscape) or a bottom BAND (portrait). */
  region: WallKioskRegion;
  /** The contain-fit board render size AFTER the chrome is reserved. Always > chromeRect by area. */
  boardRect: BoardBox;
  /** The off-board chrome region size (extent = width for rail / height for band). */
  chromeRect: BoardBox;
  /** Gap reserved between board and chrome. */
  gap: number;
  /** area(boardRect) / area(chrome-free max) — 1.0 when the board didn't shrink. */
  boardAreaFraction: number;
  /** True when the chrome fit the natural gutter and the board kept its full size. */
  isFreeAxis: boolean;
  /** Extreme-tall board on a very wide pane: the dominance cap starved the rail,
   *  so render a controls-only compact rail + surface a "rotate" hint. */
  compact: boolean;
};

export type WallKioskLayoutInput = {
  paneW: number;
  paneH: number;
  insets: WallKioskInsets;
  boardAspectRatio: number;
  /** Grows the rail/band min/pref/max on physically larger displays (default 1). */
  heroScale?: number;
  /** Minimum rail WIDTH / band HEIGHT the chrome content needs to stay legible,
   *  derived by the caller from the type scale (name line-height + controls). */
  contentFloorRail?: number;
  contentFloorBand?: number;
  /** The last resolved layout, for axis hysteresis. Omit for a fresh resolve. */
  previous?: Pick<WallKioskLayout, 'region'> | null;
};

/** Snap a measured dimension DOWN to the nearest {@link WALL_KIOSK_QUANTUM} so the
 *  engine never claims more space than the pane has. */
export function quantizeDimension(value: number, quantum: number = WALL_KIOSK_QUANTUM): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value / quantum) * quantum;
}

function areaOf(box: BoardBox | null): number {
  return box ? box.width * box.height : -1;
}

/**
 * Largest chrome extent in [lo, hi] that keeps the board's area ≥ floorArea.
 * Board area is monotonically non-increasing in the chrome extent, so a bisection
 * converges. Returns `hi` if even `hi` clears the floor, or `lo` if even `lo`
 * can't (min chrome wins — legible chrome is non-negotiable, board dips below).
 */
function largestExtentAboveFloor(
  containWith: (extent: number) => BoardBox | null,
  lo: number,
  hi: number,
  floorArea: number,
): number {
  if (hi <= lo) return lo;
  if (areaOf(containWith(hi)) >= floorArea) return hi;
  if (areaOf(containWith(lo)) < floorArea) return lo;
  let low = lo;
  let high = hi;
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2;
    if (areaOf(containWith(mid)) >= floorArea) low = mid;
    else high = mid;
  }
  return low;
}

function clamp(min: number, value: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/**
 * The core engine. Returns null only pre-measure (zero pane / zero AR); otherwise
 * ALWAYS returns a region with a reserved chrome rect and a full-fit board.
 */
export function resolveWallKioskLayout({
  paneW,
  paneH,
  insets,
  boardAspectRatio,
  heroScale = 1,
  contentFloorRail = 0,
  contentFloorBand = 0,
  previous,
}: WallKioskLayoutInput): WallKioskLayout | null {
  const W = quantizeDimension(paneW - insets.left - insets.right);
  const H = quantizeDimension(paneH - insets.top - insets.bottom);
  if (W <= 0 || H <= 0 || !(boardAspectRatio > 0)) return null;

  const full = computeContainedBoardSize(W, H, boardAspectRatio);
  if (!full) return null;
  const fullArea = full.width * full.height;

  const railMin = Math.max(RAIL_MIN * heroScale, contentFloorRail);
  const railPref = Math.max(RAIL_PREF * heroScale, railMin);
  const railMax = Math.max(RAIL_MAX * heroScale, railPref);
  const bandMin = Math.max(BAND_MIN * heroScale, contentFloorBand);
  const bandPref = Math.max(BAND_PREF * heroScale, bandMin);
  const bandMax = Math.max(BAND_MAX * heroScale, bandPref);

  const containRail = (extent: number) => computeContainedBoardSize(W - extent - WALL_KIOSK_GAP, H, boardAspectRatio);
  const containBand = (extent: number) => computeContainedBoardSize(W, H - extent - WALL_KIOSK_GAP, boardAspectRatio);

  // ── Argmax axis on board area at the DESIGN-preferred thickness ──
  // Content floors deliberately do not participate here. They describe how the
  // selected region arranges its children, not board geometry; letting a copy or
  // byline-height change feed axis selection causes large rail↔band teleports.
  const railAxisPref = Math.max(RAIL_MIN * heroScale, RAIL_PREF * heroScale);
  const bandAxisPref = Math.max(BAND_MIN * heroScale, BAND_PREF * heroScale);
  const railArea = areaOf(containRail(railAxisPref));
  const bandArea = areaOf(containBand(bandAxisPref));
  let region: WallKioskRegion = railArea >= bandArea ? 'rail' : 'band';
  if (previous?.region && previous.region !== region) {
    const incumbentArea = previous.region === 'rail' ? railArea : bandArea;
    const challengerArea = region === 'rail' ? railArea : bandArea;
    if (challengerArea <= incumbentArea * (1 + LEDGER_AXIS_HYSTERESIS)) region = previous.region;
  }

  const isRail = region === 'rail';
  const min = isRail ? railMin : bandMin;
  const pref = isRail ? railPref : bandPref;
  const max = isRail ? railMax : bandMax;
  const paneExtent = isRail ? W : H;
  const fullExtentOnAxis = isRail ? full.width : full.height;
  const containWith = isRail ? containRail : containBand;

  // Never reserve so much that the remaining box is non-positive (sub-Slide-Over):
  // the engine must never claim more space than the pane has.
  const extentCeil = Math.max(min, paneExtent - WALL_KIOSK_GAP - WALL_KIOSK_QUANTUM);
  const containSafe = (e: number): BoardBox => containWith(Math.min(e, paneExtent - WALL_KIOSK_GAP - 1)) ?? full;

  // ── Thickness: FREE if the natural gutter absorbs the chrome (fill it up to max);
  //    else STEAL just enough, bounded by the board-area floor. ──
  const naturalGutter = paneExtent - fullExtentOnAxis;
  let extent: number;
  let isFreeAxis: boolean;
  if (naturalGutter - WALL_KIOSK_GAP >= min) {
    extent = clamp(min, Math.min(naturalGutter - WALL_KIOSK_GAP, extentCeil), max);
    isFreeAxis = true;
  } else {
    extent = largestExtentAboveFloor(containWith, min, Math.min(pref, extentCeil), BOARD_AREA_FLOOR * fullArea);
    isFreeAxis = false;
  }

  // ── Dominance: the board is ALWAYS the largest region by AREA. A RAIL sits
  //    beside the board (chrome width vs board width) so an extent-ratio cap
  //    suffices; a BAND spans the FULL content width, so it must be capped by
  //    AREA (W × height ≤ ratio × boardArea) or a full-width band would out-mass a
  //    letterboxed board. Capping only shrinks chrome → grows the board → stable. ──
  let board = containSafe(extent);
  let cappedExtent: number;
  let compact = false;
  if (isRail) {
    const idealCapped = Math.min(extent, ZONE_DOMINANCE_RATIO * board.width);
    if (idealCapped >= min) {
      cappedExtent = idealCapped;
    } else if (board.width < min) {
      // A full rail would out-mass a sliver board → controls-only compact rail.
      compact = true;
      cappedExtent = Math.max(COMPACT_RAIL_MIN, idealCapped);
    } else {
      cappedExtent = min; // board still larger by area; the 0.85 ratio relaxes.
    }
  } else {
    const boardArea = board.width * board.height;
    const maxHeightByArea = (ZONE_DOMINANCE_RATIO * boardArea) / W;
    const idealCapped = Math.min(extent, maxHeightByArea);
    if (idealCapped >= min) {
      cappedExtent = idealCapped;
    } else if (boardArea > W * min) {
      cappedExtent = min; // board still larger by area with the legible min band.
    } else {
      // Even a min-height full-width band out-masses this (very tall) board →
      // controls-only compact band. Extreme case; a rotate hint is warranted.
      compact = true;
      cappedExtent = Math.max(COMPACT_BAND_MIN, idealCapped);
    }
  }
  board = containSafe(cappedExtent);

  const chromeRect: BoardBox = isRail
    ? { width: cappedExtent, height: board.height }
    : { width: W, height: cappedExtent };

  return {
    region,
    boardRect: board,
    chromeRect,
    gap: WALL_KIOSK_GAP,
    boardAreaFraction: fullArea > 0 ? (board.width * board.height) / fullArea : 0,
    isFreeAxis,
    compact,
  };
}

/**
 * Whether the recent-sender byline has earned its query. Compact chrome sheds
 * the byline and an idle wall has no climb to attribute, so neither should spend
 * a request against the board's rate-limit budget. Lives here rather than in the
 * screen so it unit-tests as a plain function, like the rest of this module.
 */
export function shouldFetchRecentSenders(layout: WallKioskLayout | null, mode: WallStateMode): boolean {
  return layout !== null && !layout.compact && mode !== 'idle';
}
