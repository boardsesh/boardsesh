// When a panned or zoomed map's centre is a place to search gyms around. The
// search radius is 50 km, so a camera zoomed out past a region (or the whole
// world) is not: its centre is usually mid-ocean, and the list would show
// gyms around a point the climber never chose.

/** The furthest-out zoom whose centre is searched: about a region. */
export const SEARCH_ZOOM_THRESHOLD = 8;

/**
 * Whether a camera move to `zoom` may move the search. With no zoom reported,
 * a pan from a centre the search already has is trusted (the platform didn't
 * say), but the world view's never is.
 */
export function zoomedInToSearch(zoom: number | undefined, hasSearchCenter: boolean): boolean {
  if (zoom === undefined) return hasSearchCenter;
  return zoom >= SEARCH_ZOOM_THRESHOLD;
}
