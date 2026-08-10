// Rail geometry for the horizontal chip rails (grade + tries). Pure — no
// react-native import — so the arithmetic that decides where a rail comes to
// rest is unit-testable without a native tree.
//
// Why this exists: the old inline centring did `Math.max(0, chipCentre -
// railWidth / 2)` with no upper bound and no snap. Two failures fell out of
// that: a focus chip near the end of the content scrolled past the scrollable
// range and the rail settled with the selected chip amputated at the left edge,
// and every rest position was an arbitrary pixel offset, so the rail routinely
// came to rest mid-chip and painted half-pills at both edges. Clamping to the
// scrollable range fixes the first; snapping DOWN to a chip start makes the
// second structurally impossible rather than tuned away.

/** A measured chip's position within the rail's content, in points. */
export type RailChipLayout = { x: number; width: number };

/**
 * Sub-point slack when matching a computed offset against a chip start. Layout
 * values arrive as floats off the native measurement pass, so an exact `<=`
 * would occasionally skip the chip the offset was derived from.
 */
const SNAP_TOLERANCE_PT = 0.5;

/**
 * Every legal rest position for the rail: each chip's start, pulled back by the
 * content's lead-in padding so the chip lands flush against the rail's left
 * edge rather than behind the inset.
 *
 * 0 (the content start) always heads the list — it is a legal rest for any
 * scroll view, and it is what the first chip resolves to whenever the lead-in
 * matches the content padding. Offsets are unique and ascending, and never
 * negative.
 */
export function railSnapOffsets(layouts: Record<number, RailChipLayout>, leadIn: number): number[] {
  const chipLayouts = Object.values(layouts);
  if (chipLayouts.length === 0) return [];

  const offsets = new Set<number>([0]);
  for (const layout of chipLayouts) {
    offsets.add(Math.max(0, layout.x - leadIn));
  }
  return [...offsets].sort((first, second) => first - second);
}

type RailRestOffsetArgs = {
  layouts: Record<number, RailChipLayout>;
  focusId: number | undefined;
  railWidth: number;
  contentWidth: number;
  leadIn: number;
};

/**
 * Where the rail should sit so the focus chip is readable: centre it, clamp to
 * the range the content can actually scroll, then snap DOWN to a chip start.
 *
 * Returns `null` when there is nothing to compute from — no focus chip, an
 * unmeasured focus chip, or a rail that has not been laid out yet — so the
 * caller can leave the scroll position alone instead of jumping it to 0.
 */
export function railRestOffset({
  layouts,
  focusId,
  railWidth,
  contentWidth,
  leadIn,
}: RailRestOffsetArgs): number | null {
  if (focusId == null || railWidth <= 0) return null;
  const focusLayout = layouts[focusId];
  if (!focusLayout) return null;

  // Nothing overflows: the rail can only rest at the content start.
  const maxOffset = Math.max(0, contentWidth - railWidth);
  if (maxOffset === 0) return 0;

  const centred = focusLayout.x + focusLayout.width / 2 - railWidth / 2;
  const clamped = Math.min(Math.max(centred, 0), maxOffset);

  let rest = 0;
  for (const offset of railSnapOffsets(layouts, leadIn)) {
    if (offset > maxOffset) break;
    if (offset <= clamped + SNAP_TOLERANCE_PT) rest = offset;
  }
  return rest;
}
