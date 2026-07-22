/**
 * Pure layout math for the full-screen play drawer. Kept out of the components
 * so the contain-fit and first-screen sizing can be unit-tested across board
 * aspect ratios and screen sizes (the board catalog has many variants).
 */

export type BoardBox = { width: number; height: number };

/**
 * Contain a board of the given aspect ratio within a box, preserving aspect
 * ratio and centering. Letterboxes horizontally on tall (portrait) boards and
 * vertically on wide ones. Returns null when the box or aspect ratio isn't
 * measurable yet (pre-layout), so callers fall back to a full-bleed default.
 *
 * `aspectRatio` is width / height.
 */
export function computeContainedBoardSize(boxWidth: number, boxHeight: number, aspectRatio: number): BoardBox | null {
  if (boxWidth <= 0 || boxHeight <= 0 || aspectRatio <= 0) return null;
  const widthAtFullHeight = boxHeight * aspectRatio;
  return widthAtFullHeight <= boxWidth
    ? { width: widthAtFullHeight, height: boxHeight }
    : { width: boxWidth, height: boxWidth / aspectRatio };
}

/**
 * Height of the play drawer's first screen: the window minus the reserve that
 * keeps the action bar visible and the Beta Videos header teasing at the fold.
 * Floored at a fraction of the window so an over-large reserve (e.g. a wildly
 * mismeasured header) can never collapse the board to nothing.
 */
export function computeFirstScreenHeight(windowHeight: number, reserve: number, minFraction = 0.5): number {
  return Math.max(windowHeight - reserve, windowHeight * minFraction);
}

/**
 * Scroll offset that brings a just-expanded Logbook section into view. The
 * Logbook is the first below-fold section, so it starts at
 * `firstScreenHeight + topPadding` in the scroll content. Prefer the minimal
 * scroll that lands the section's bottom just above the home indicator (a short
 * log keeps the board partly visible); for a section taller than the viewport,
 * cap it so the header stops just under the top inset rather than scrolling its
 * own top away. Never returns a negative offset.
 */
export function computeLogbookScrollTarget(params: {
  firstScreenHeight: number;
  topPadding: number;
  sectionHeight: number;
  viewport: number;
  topInset: number;
  bottomInset: number;
  margin: number;
}): number {
  const { firstScreenHeight, topPadding, sectionHeight, viewport, topInset, bottomInset, margin } = params;
  const sectionTopY = firstScreenHeight + topPadding;
  const bottomIntoView = sectionTopY + sectionHeight - viewport + bottomInset + margin;
  const headerToTop = sectionTopY - topInset - margin;
  return Math.max(0, Math.min(bottomIntoView, headerToTop));
}
