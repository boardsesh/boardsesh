import { NO_HORIZONTAL_SAFE_AREA, type HorizontalSafeArea } from '../../hooks/horizontal-safe-area';
import type { PlayDrawerProps } from './play-drawer-types';

/**
 * The side padding of the player's scroll content. The route (the full-screen
 * player) pads by the side safe area: on iPhone Duo the status bar sits on the
 * trailing edge, over ⋯ and the grade. The pane takes none: its host lays out
 * the pane and owns its edges, so padding here too would double the inset.
 */
export function playContentSideInsets(
  presentation: NonNullable<PlayDrawerProps['presentation']>,
  routeSideInsets: HorizontalSafeArea,
): HorizontalSafeArea {
  return presentation === 'pane' ? NO_HORIZONTAL_SAFE_AREA : routeSideInsets;
}
