import type { BoardHoldTarget } from '../../lib/create-board-holds';

/** Minimum touch target per the iOS HIG / a11y guidance. */
export const MIN_TAP_DIAMETER = 44;

/**
 * Append an alpha channel to a `#RGB`/`#RRGGBB` hex color. Returns the input
 * unchanged for anything else (e.g. the `#FFF` fallback the frame parser emits
 * for unknown codes) so we never produce an invalid color string.
 */
export function hexWithAlpha(hex: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  const aa = Math.round(clamped * 255)
    .toString(16)
    .padStart(2, '0');
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return `${hex}${aa}`;
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    const [, r, g, b] = hex;
    return `#${r}${r}${g}${g}${b}${b}${aa}`;
  }
  return hex;
}

export type HoldGeometry = {
  /** Percentage anchor of the hold centre across the board (resolution-independent). */
  leftPct: number;
  topPct: number;
  /** Painted-ring diameter in device px (centred on the anchor via negative margins). */
  ringDiameter: number;
  /** Transparent tap-target diameter in device px (>= MIN_TAP_DIAMETER). */
  tapDiameter: number;
};

/**
 * Compute a hold's on-screen geometry. Positions stay percentage-based — the
 * viewport box already has the board's aspect ratio, so a mid-session relayout
 * (rotation, keyboard) self-corrects. Only the diameter needs the measured
 * device-px scale. `mirrored` flips horizontally for left-handed preview without
 * touching which hold id is written.
 */
export function holdGeometry(
  hold: BoardHoldTarget,
  boardWidth: number,
  boardHeight: number,
  measuredWidth: number,
  mirrored: boolean,
  radiusMultiplier = 1,
): HoldGeometry {
  const scale = measuredWidth / boardWidth;
  const cxPct = (hold.cx / boardWidth) * 100;
  const leftPct = mirrored ? 100 - cxPct : cxPct;
  const topPct = (hold.cy / boardHeight) * 100;
  const ringDiameter = hold.r * 2 * scale * radiusMultiplier;
  const tapDiameter = Math.max(ringDiameter * 1.6, MIN_TAP_DIAMETER);
  return { leftPct, topPct, ringDiameter, tapDiameter };
}

/**
 * Invert the board's zoom transform to map a screen-space point (relative to the
 * container's top-left) back into board-local, untransformed render px.
 *
 * The board is drawn with `transform: [translateX, translateY, scale]` and the
 * default center transform-origin, so the forward map of a board-local point is
 *   screen = center + scale * (local - center) + translate,  center = size / 2
 * and this is its exact inverse:
 *   local = center + (screen - translate - center) / scale
 *
 * Tap targets are laid out in the same untransformed space (percentages of the
 * container), so a point returned here can be compared directly against
 * `buildHoldHitTargets`. This is the pure, tested twin of the ~2-line worklet
 * copy in use-zoomed-hold-tap-gesture (reanimated can't reliably call
 * cross-module worklets — same split as clampTranslation). Keep in sync.
 */
export function inverseTransformPoint(
  screenX: number,
  screenY: number,
  scale: number,
  translateX: number,
  translateY: number,
  containerWidth: number,
  containerHeight: number,
): { x: number; y: number } {
  const cx = containerWidth / 2;
  const cy = containerHeight / 2;
  return {
    x: (screenX - translateX - cx) / scale + cx,
    y: (screenY - translateY - cy) / scale + cy,
  };
}

/** One hold's circular hit area in board-local, untransformed render px. */
export type HoldHitTarget = {
  holdId: number;
  x: number;
  y: number;
  radius: number;
};

/**
 * Precompute the circular hit area of every hold in board-local render px, so a
 * tap mapped back through {@link inverseTransformPoint} can be resolved to a
 * hold without per-tap geometry work. Reuses {@link holdGeometry}, so `mirrored`
 * is already baked into the x position.
 */
export function buildHoldHitTargets(
  holdTargets: BoardHoldTarget[],
  boardWidth: number,
  boardHeight: number,
  renderWidth: number,
  renderHeight: number,
  mirrored: boolean,
): HoldHitTarget[] {
  return holdTargets.map((hold) => {
    const geometry = holdGeometry(hold, boardWidth, boardHeight, renderWidth, mirrored);
    return {
      holdId: hold.id,
      x: (geometry.leftPct / 100) * renderWidth,
      y: (geometry.topPct / 100) * renderHeight,
      radius: geometry.tapDiameter / 2,
    };
  });
}

/**
 * Resolve a board-local point to the id of the nearest hold whose hit circle
 * contains it, or `null` if none do. Nearest-center disambiguates the
 * overlapping tap targets of a dense cluster — the case zooming exists to serve.
 */
export function resolveHoldAtPoint(x: number, y: number, hitTargets: HoldHitTarget[]): number | null {
  let bestId: number | null = null;
  let bestDistanceSquared = Infinity;
  for (const target of hitTargets) {
    const dx = x - target.x;
    const dy = y - target.y;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared <= target.radius * target.radius && distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      bestId = target.holdId;
    }
  }
  return bestId;
}
