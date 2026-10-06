/**
 * Where the Apple Pencil squeeze palette's buttons go: a ring round the Pencil
 * tip, pulled in from the edges so every button stays on screen. Pure, so the
 * clamping is tested without a renderer.
 */

/** One palette button, edge to edge. */
export const PENCIL_PALETTE_BUTTON_SIZE = 44;
/** From the ring's centre to each button's centre: the buttons clear the tip and each other. */
export const PENCIL_PALETTE_RADIUS = 60;
/** The least room left between a button and the edge of the editor. */
export const PENCIL_PALETTE_EDGE_MARGIN = 8;

/** The ring's centre: under the tip when there is room, otherwise as near as the edges allow. */
export function pencilPaletteCentre({
  x,
  y,
  areaWidth,
  areaHeight,
}: {
  /** The Pencil tip, or null when it was not hovering (the palette opens mid-screen). */
  x: number | null;
  y: number | null;
  areaWidth: number;
  areaHeight: number;
}): { x: number; y: number } {
  const reach = PENCIL_PALETTE_RADIUS + PENCIL_PALETTE_BUTTON_SIZE / 2 + PENCIL_PALETTE_EDGE_MARGIN;
  return {
    x: clampToSpan(x ?? areaWidth / 2, reach, areaWidth),
    y: clampToSpan(y ?? areaHeight / 2, reach, areaHeight),
  };
}

/** A value kept `reach` in from both ends of a span; the middle when the span is too short. */
function clampToSpan(value: number, reach: number, span: number): number {
  if (span <= reach * 2) return span / 2;
  return Math.min(span - reach, Math.max(reach, value));
}

/**
 * Each button's centre relative to the ring's centre, the first straight
 * above it and the rest going clockwise, evenly spaced.
 */
export function pencilPaletteOffsets(count: number): { dx: number; dy: number }[] {
  return Array.from({ length: count }, (_unused, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
    return {
      dx: Math.round(Math.cos(angle) * PENCIL_PALETTE_RADIUS * 100) / 100,
      dy: Math.round(Math.sin(angle) * PENCIL_PALETTE_RADIUS * 100) / 100,
    };
  });
}
