/**
 * Whether the player route on screen was presented with UIKit's zoom from the
 * tab accessory (#7733).
 *
 * The zoom shrinks the tabs screen behind the transparent player to about 92%,
 * and only UIKit's own animated dismiss grows it back. A close that slides the
 * player away first and then dismisses without animation leaves the shrunken
 * list on show for the slide and snaps it back afterwards. So a zoom-presented
 * player hands every close to UIKit, and needs to know it was zoom-presented.
 *
 * The accessory's Link press notes the zoom just before navigating; the player
 * reads it once on mount. The window bounds a press whose navigation never
 * happened: it can't mark a later open from a climb row as a zoom.
 */
const ZOOM_OPEN_WINDOW_MS = 2000;

let zoomOpenRequestedAt: number | null = null;

/** The accessory's zoom Link is about to present the player. */
export function notePlayerZoomOpen(now: number = Date.now()): void {
  zoomOpenRequestedAt = now;
}

/** Whether the player being mounted now was presented by the accessory's zoom. */
export function wasPlayerZoomOpened(now: number = Date.now()): boolean {
  return zoomOpenRequestedAt !== null && now - zoomOpenRequestedAt <= ZOOM_OPEN_WINDOW_MS;
}

/** The player is gone; the next open says for itself how it was presented. */
export function clearPlayerZoomOpen(): void {
  zoomOpenRequestedAt = null;
}
