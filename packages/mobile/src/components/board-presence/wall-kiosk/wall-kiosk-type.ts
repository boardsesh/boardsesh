/**
 * Distance-driven type scale for the wall kiosk. A wall-mounted iPad is read from
 * across a gym (5–8 m), so the hero name + grade key off the PHYSICAL screen size
 * (and, as a proxy, the pane's short side) rather than the leftover gutter — the
 * fix for "biggest text exactly when the art is smallest." Pure + unit-testable.
 *
 * NOTE: `Dimensions.get('screen')` returns POINTS, not millimetres. Every
 * panel-capable iPad (11" Pro, 13") renders at ~132 points/inch (264 physical ppi
 * at @2x), so a single conversion is accurate enough for the panel-capable set;
 * denser small iPads are sheet-only anyway (the device-long-side gate). The pane
 * short-side fallback covers external displays / unknown models.
 */

export const IPAD_POINTS_PER_INCH = 132;
const MM_PER_INCH = 25.4;

/** Estimate the physical long side (mm) from the screen long side in points. */
export function estimatePhysicalLongSideMm(screenLongSidePoints: number): number {
  if (!(screenLongSidePoints > 0)) return 0;
  return (screenLongSidePoints / IPAD_POINTS_PER_INCH) * MM_PER_INCH;
}

/**
 * A multiplier ≥ 1 that grows the hero type on physically larger displays.
 * Prefers the physical long side; falls back to the pane's short side when the
 * physical size is unknown. iPads land near 1.0 (the pane short side does most of
 * the work below); big external kiosks scale up toward 1.8.
 */
export function resolveHeroScale({
  physicalLongSideMm,
  paneShortSide,
}: {
  physicalLongSideMm?: number | null;
  paneShortSide?: number | null;
}): number {
  if (physicalLongSideMm && physicalLongSideMm > 0) {
    return clamp(1, physicalLongSideMm / 280, 1.8);
  }
  if (paneShortSide && paneShortSide > 0) {
    return clamp(1, paneShortSide / 900, 1.8);
  }
  return 1;
}

export type WallKioskTypeScale = {
  /** The loudest glyph — always larger than the name, never keyed off zone width. */
  gradeFontSize: number;
  gradeLineHeight: number;
  /** The climb name; shrinks-to-fit at render but this is its target size. */
  nameFontSize: number;
  nameLineHeight: number;
  /** Supporting lines (setter, angle, driver) — a readable step below the name. */
  metaFontSize: number;
  metaLineHeight: number;
  /** The state strip + "on the wall now" line — near-hero so the preview tell is
   *  never footnote-sized. */
  stateFontSize: number;
  stateLineHeight: number;
};

/**
 * Resolve the hero type scale from the pane's short side and the hero scale. The
 * grade is guaranteed larger than the name.
 */
export function resolveWallKioskTypeScale(paneShortSide: number, heroScale: number): WallKioskTypeScale {
  const shortSide = paneShortSide > 0 ? paneShortSide : 700;
  const gradeFontSize = Math.round(clamp(48, shortSide * 0.11 * heroScale, 108));
  const nameFontSize = Math.round(clamp(32, shortSide * 0.07 * heroScale, 72));
  const metaFontSize = Math.round(clamp(16, shortSide * 0.028 * heroScale, 30));
  const stateFontSize = Math.max(metaFontSize, Math.round(nameFontSize * 0.5));
  return {
    gradeFontSize,
    gradeLineHeight: Math.round(gradeFontSize * 1.05),
    nameFontSize,
    nameLineHeight: Math.round(nameFontSize * 1.12),
    metaFontSize,
    metaLineHeight: Math.round(metaFontSize * 1.3),
    stateFontSize,
    stateLineHeight: Math.round(stateFontSize * 1.3),
  };
}

/**
 * Clamp the grade down so it fits the resolved chrome extent (rail width / band
 * height) and re-assert grade > name. Distance-driven sizing keys off the pane,
 * not the chrome, so a thin rail can't resurrect the biggest-text-when-art-
 * smallest bug — but a very thin chrome still can't seat a 108pt glyph, so this is
 * the ceiling that keeps the grade inside its region.
 */
export function fitGradeToChrome(
  scale: WallKioskTypeScale,
  region: 'rail' | 'band',
  chromeExtent: number,
): WallKioskTypeScale {
  const ceiling = region === 'rail' ? chromeExtent * 0.58 : chromeExtent * 0.5;
  if (scale.gradeFontSize <= ceiling) return scale;
  const gradeFontSize = Math.max(Math.round(Math.min(scale.gradeFontSize, ceiling)), scale.nameFontSize + 4);
  return { ...scale, gradeFontSize, gradeLineHeight: Math.round(gradeFontSize * 1.05) };
}

/**
 * The minimum band HEIGHT that funds its content, so a band is never sized below
 * what it must show (else `overflow: hidden` clips the scrubber below the fold).
 * The band spans the full content width and lays its identity + controls out in
 * two columns, so the height is the taller of the two columns (not their sum),
 * plus surface padding + inter-block gaps. The identity column measures at the
 * real `gradeLineHeight` (not the name-line proxy) and includes the driver row.
 */
export function bandContentFloor(scale: WallKioskTypeScale): number {
  const stripPadding = 16; // state strip paddingVertical 8×2
  const chipPadding = 4; // grade chip paddingVertical 2×2
  const driverRow = 36; // avatar + line
  const controlRow = 56; // nav row / Light-this min height
  const blockGaps = 12 * 4; // spacing[3] between stacked blocks
  const surfacePadding = 32; // spacing[4] top + bottom
  const identityColumn =
    scale.stateLineHeight +
    stripPadding +
    scale.gradeLineHeight +
    chipPadding +
    2 * scale.nameLineHeight +
    scale.metaLineHeight +
    driverRow;
  const controlsColumn = controlRow + controlRow + 30; // nav + Light-this + back-to-live
  return Math.round(Math.max(identityColumn, controlsColumn) + blockGaps + surfacePadding);
}

function clamp(min: number, value: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}
