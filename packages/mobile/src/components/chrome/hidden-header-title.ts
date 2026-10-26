/**
 * Hides a native stack header's title text for a screen whose tab already names
 * it (Climbs). UIKit still lays the title out, in a clear colour, so the
 * navigation item keeps its `title` for the back button's long-press menu, and a
 * custom title view (the Climbs header's status capsules) still mounts as a
 * fresh view when it appears.
 *
 * Not an empty `headerTitle` view: the native stack keeps one centre view for
 * the screen's life, so a capsule swapped into an empty one kept its zero size
 * and never showed until the screen was left and re-entered. Module-level, so
 * the option keeps one identity across renders.
 */
export const HIDDEN_HEADER_TITLE_STYLE = { color: 'transparent' } as const;
