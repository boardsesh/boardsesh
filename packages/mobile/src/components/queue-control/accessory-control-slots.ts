/**
 * The least room the climb name keeps in the open platter before the row drops to
 * one control. About 20 characters of a subheadline name: enough that most names
 * read without scrolling.
 */
export const ACCESSORY_MIN_NAME_WIDTH = 160;

/**
 * Whether the open platter row shows both the lightbulb and the tick, or one slot
 * as the collapsed platter does.
 *
 * The platter is as wide as UIKit makes it, and that varies: about 370pt on an
 * iPhone 17 Pro, 290pt on iPhone Duo's outer display, where it sits beside the
 * side tab rail. There both controls left the name 134pt, so a typical name never
 * stopped scrolling. Below the floor the row keeps one control and gives the name
 * the other's 44pt.
 *
 * `rowWidth` is the row's measured width, `null` before its first layout: the row
 * starts with both controls, which every iPhone platter fits. `widthBesideName` is
 * everything else the row holds with both controls showing: its insets, the
 * thumbnail and its gap, and the two control slots.
 */
export function accessoryFitsBothControls(rowWidth: number | null, widthBesideName: number): boolean {
  if (rowWidth === null) return true;
  return rowWidth - widthBesideName >= ACCESSORY_MIN_NAME_WIDTH;
}
