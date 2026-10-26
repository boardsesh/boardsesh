/** The left and right safe-area insets a container pads its content by. */
export type HorizontalSafeArea = { left: number; right: number };

export const NO_HORIZONTAL_SAFE_AREA: HorizontalSafeArea = Object.freeze({ left: 0, right: 0 });

export type HorizontalSafeAreaInputs = {
  /** `useSafeAreaInsets()` at the surface being laid out. Inside a native tab it includes a side tab bar. */
  insets: HorizontalSafeArea;
  /** An ancestor container already pads by these insets (`HorizontalSafeAreaApplied`). */
  appliedByAncestor: boolean;
};

/**
 * The side insets a container still has to pad by. Pure, so the rule is unit-tested
 * without a device.
 *
 * On iPhone Duo the system moves the tab bar and the status bar to the trailing edge
 * (HIG, "Designing for iPhone Duo": "Use safe areas to make sure controls don't cover
 * your content"), and a tab's safe area reports them: right 84 on the inner display
 * in landscape. A portrait-locked iPhone reports 0 on both sides, and so does an
 * iPad tab, which UIKit lays out beside its sidebar, so this is a no-op on
 * both.
 *
 * Once one container pads, everything inside it is already clear, so a nested
 * container must not pad a second time.
 */
export function resolveHorizontalSafeArea({ insets, appliedByAncestor }: HorizontalSafeAreaInputs): HorizontalSafeArea {
  if (appliedByAncestor) return NO_HORIZONTAL_SAFE_AREA;
  const left = insets.left > 0 ? insets.left : 0;
  const right = insets.right > 0 ? insets.right : 0;
  if (left === 0 && right === 0) return NO_HORIZONTAL_SAFE_AREA;
  return { left, right };
}
