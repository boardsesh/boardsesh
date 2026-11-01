/**
 * The full-screen Wall display (`app/wall-display`), a root `transparentModal`
 * for an iPad mounted at the board. It replaced the iPad-only "On the Wall" tab.
 */
export const WALL_DISPLAY_HREF = '/wall-display';

// `com.boardsesh.app://wall`, the same with a third slash, or the bare path the
// router hands over, each with an optional trailing slash, query or fragment.
const LEGACY_WALL_TAB_LINK = /^(?:com\.boardsesh\.app:\/\/\/?|\/)(?:\(tabs\)\/)?wall\/?(?:[?#].*)?$/i;

/** True for a link to the retired "On the Wall" tab, which now opens the Wall display. */
export function isLegacyWallTabLink(path: string): boolean {
  return LEGACY_WALL_TAB_LINK.test(path);
}
