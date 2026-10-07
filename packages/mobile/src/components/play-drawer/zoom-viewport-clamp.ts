/**
 * How far a zoomed board may be panned, one axis at a time, as pure functions.
 *
 * Every board draws its photo `transform: [translate, scale]` about the centre
 * of its unzoomed render box. Most boards also clip to that box, so the rule
 * used to be simple: the zoomed photo always covers the box, which caps the
 * translation at `±(scale − 1) · extent / 2`.
 *
 * The spray hold editor lets the zoomed photo spill past its box over the whole
 * editor (`ZoomViewport`). There the rule is stated in terms of what the
 * climber can see, the "visible band" of the viewport that no chrome covers:
 * every edge of the photo can be pulled into that band, and no further. A board
 * with no viewport is its own viewport, with a band that is the box itself, and
 * the arithmetic below then gives exactly the old cap (see the tests).
 *
 * The functions carry the `'worklet'` directive so the pan and pinch can call
 * them on the UI thread (the directive is an inert string in plain JS and in
 * the test runner) — the same pattern as `outline-editor/spray-gesture-math.ts`.
 * `zoomTargetForHold` in `outline-editor/hold-navigation.ts` calls the same
 * function on the JS thread, so a programmatic zoom lands where a manual pan
 * would. `clampTranslation` in `@boardsesh/play-view` is the original spec for
 * the no-viewport case.
 */

/**
 * The area a zoomed board is drawn and panned in, in the board clip's own
 * points. Optional everywhere: without one the viewport is the render box.
 */
export type ZoomViewport = {
  /** The clip's size. The photo is visible anywhere inside it once zoomed. */
  width: number;
  height: number;
  /** Where the unzoomed photo's top-left corner sits inside the viewport. */
  offsetX: number;
  offsetY: number;
  /**
   * The part of the viewport that no floating chrome covers, per axis. A photo
   * edge can be pulled anywhere inside it, never further. For a viewport with
   * nothing over it, `0` to `width` and `0` to `height`.
   */
  bandStartX: number;
  bandEndX: number;
  bandStartY: number;
  bandEndY: number;
};

/**
 * One axis of a pan, clamped.
 *
 * With `r` the render extent, `s` the scale, `S = s·r`, `o` the photo's offset
 * in the viewport and `[a, b]` the visible band, the zoomed photo's leading
 * edge sits at `L = o + r/2 + t − S/2`. That edge is kept inside
 * `[min(a, b − S), max(a, b − S)]`: a photo bigger than the band may move until
 * either edge reaches the band's edge. The result is also capped at the box
 * clamp `±(S − r)/2`, so one smaller than the band stays over its own spot and
 * the range shrinks smoothly to 0 as `s → 1`. For a photo that sits inside its
 * band at 1×, the band range of a photo bigger than the band already lies inside
 * that cap. Not zoomed in (`s ≤ 1`), there is no pan at all.
 *
 * Written around `overflow = r·(s − 1)` (which is `S − r`) so that with no
 * viewport (`o = 0`, `a = 0`, `b = r`) the bounds come out bit for bit as the
 * old `±r·(s − 1)/2`.
 *
 * The "not zoomed" sentinel is the literal 1, which is `MIN_SCALE`: a worklet
 * keeps its constants local. If `MIN_SCALE` ever moves off 1, move this too.
 */
export function clampAxisTranslation(
  translation: number,
  scale: number,
  renderExtent: number,
  offset: number,
  bandStart: number,
  bandEnd: number,
): number {
  'worklet';
  if (scale <= 1) return 0;
  const overflow = renderExtent * (scale - 1);
  // Where the leading edge sits when the trailing edge is on the band's end.
  const lastEdge = bandEnd - renderExtent - overflow;
  const bandLowest = Math.min(bandStart, lastEdge) - offset + overflow / 2;
  const bandHighest = Math.max(bandStart, lastEdge) - offset + overflow / 2;
  // Never more freedom than the photo's own box allows (`±overflow/2`). Just
  // past 1× a photo smaller than the band would otherwise slide across the
  // whole band, then snap back to centre the frame the pinch reaches 1×.
  const lowest = Math.max(bandLowest, -overflow / 2);
  const highest = Math.min(bandHighest, overflow / 2);
  // A photo that starts outside its band can leave the two ranges disjoint;
  // the band wins, so every edge stays reachable.
  if (lowest > highest) return Math.max(bandLowest, Math.min(bandHighest, translation));
  return Math.max(lowest, Math.min(highest, translation));
}

/**
 * The transform's origin along one axis, in viewport points: the centre of the
 * unzoomed photo. A pinch's focal point is measured from here, because the
 * photo scales about it. Without a viewport it is `extent / 2`, as before.
 */
export function transformOriginInViewport(offset: number, renderExtent: number): number {
  'worklet';
  return offset + renderExtent / 2;
}
