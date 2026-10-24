/**
 * Where the top bar's list label ("Projects · 4 of 23") sits: clear of ⌄ on
 * the left and of the rest timer + ⋯ cluster on the right.
 *
 * While both sides match, the label is centred on the screen. Once the timer
 * widens the right, it centres in the room left over instead, so the name
 * still fits beside the pill. ⋯ carries its own gap from the timer
 * (`menuSlot`), which is not room the label can use beside ⋯ alone, so it is
 * taken back off.
 */
export type TopListContextFrame = {
  left: number;
  right: number;
  /** False until the cluster has laid out: the label stays hidden rather than
   *  paint one frame under a timer that was already running. */
  measured: boolean;
};

export function resolveTopListContextFrame({
  isPane,
  chromeButtonSize,
  trailingContentWidth,
  hasMenu,
  gap,
}: {
  /** The iPad pane has no ⌄, so nothing to clear on the left. */
  isPane: boolean;
  chromeButtonSize: number;
  /** The timer + ⋯ cluster's laid-out width, or null before its first layout. */
  trailingContentWidth: number | null;
  /** ⋯ is there (a signed-in climber), and brings its gap from the timer. */
  hasMenu: boolean;
  /** The row's edge inset, which is also the label's gap to its neighbours. */
  gap: number;
}): TopListContextFrame {
  const leadingReserve = isPane ? 0 : gap + chromeButtonSize;
  const trailingReserve = gap + (trailingContentWidth ?? 0) - (hasMenu ? gap : 0);
  return {
    left: leadingReserve + gap,
    right: Math.max(leadingReserve, trailingReserve) + gap,
    measured: trailingContentWidth !== null,
  };
}
