/**
 * Default per-frame pace when a climb does not specify `framesPace`. The
 * Aurora encoding leaves this at 0 for static climbs and the unit is not
 * documented anywhere in this repo; QA can tune the constant once we have
 * a known multi-frame climb to calibrate against.
 */
export const DEFAULT_PACE_MS = 750;

/**
 * Lower bound on per-frame pace. The BLE transport chunks payloads at 20
 * bytes with a 5 ms inter-chunk delay, so the worst-case packet (13
 * chunks, ~260-byte climb) spends ~65 ms in inter-chunk gaps alone before
 * the GATT round-trip on top. A 50 ms floor was below physical throughput
 * and produced "GATT operation already in progress" errors on Android.
 * 200 ms gives every realistic packet headroom to flush while still
 * looking fast on a route.
 */
export const MIN_PACE_MS = 200;

/**
 * Slowest pace a setter can author, in milliseconds. Matches the upper end of
 * the "seconds per frame" control (#4633 asked for a linear range up to 10s).
 */
export const MAX_PACE_MS = 10_000;

/**
 * Fastest pace a setter can author, in milliseconds.
 *
 * Deliberately above `MIN_PACE_MS`, not equal to it. `MIN_PACE_MS` is the
 * transport's own floor — the point below which the BLE writer physically
 * cannot keep up — and sitting an authored value exactly on a hardware limit
 * leaves the wall no headroom on a slow GATT link. 300ms keeps a 100ms margin
 * while still reading as fast on a route.
 */
export const MIN_AUTHORED_PACE_MS = 300;

/** Clamps an authored pace into the range the "seconds per frame" control offers. */
export function clampAuthoredPaceMs(paceMs: number): number {
  if (!Number.isFinite(paceMs)) return DEFAULT_PACE_MS;
  return Math.round(Math.min(Math.max(paceMs, MIN_AUTHORED_PACE_MS), MAX_PACE_MS));
}
