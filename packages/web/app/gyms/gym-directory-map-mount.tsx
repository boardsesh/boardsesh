/**
 * Mount point for the directory's "near me" map (#4380).
 *
 * Renders nothing today, on purpose. The map is a separate issue and a heavy
 * dependency, and this PR ships **no leaflet import anywhere** — pulling one in
 * "just to reserve the slot" would put a map bundle on a page that has no map.
 * What this file reserves is the POSITION: #4380 replaces the body of this
 * component and touches nothing else in the directory shell.
 *
 * It sits between the facet chips and the results list, which is where a map
 * belongs once `?lat`/`?lng` are set — above the list it filters, below the
 * controls that set it.
 */
export default function GymDirectoryMapMount(): null {
  return null;
}
