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
 * A rule about any narrow platter, not about one device. The platter is as wide
 * as UIKit makes it: about 370pt on an iPhone 17 Pro and 343pt on a 375pt-wide
 * iPhone, both of which keep both controls. Two platters fall below the floor:
 * iPhone Duo's outer display (290pt, beside the side tab rail) and a 320pt-wide
 * iPhone under Display Zoom (SE, 13 mini; about 288pt). With both controls the
 * name had about 134pt there, so a typical name never stopped scrolling; the row
 * keeps one control instead and gives the name the other's 44pt. The one slot
 * follows the collapsed platter: the bulb while the board is free, else the tick.
 *
 * `rowWidth` is the row's measured width, `null` before its first layout: the row
 * starts with both controls, as most platters fit them. `widthBesideName` is
 * everything else the row holds with both controls showing: its insets, the
 * thumbnail and its gap, and the two control slots.
 */
export function accessoryFitsBothControls(rowWidth: number | null, widthBesideName: number): boolean {
  if (rowWidth === null) return true;
  return rowWidth - widthBesideName >= ACCESSORY_MIN_NAME_WIDTH;
}
