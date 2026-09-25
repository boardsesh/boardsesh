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
 * Slowest pace the seconds-per-frame control offers, in milliseconds — the same
 * ceiling for the setter authoring a route and the climber reading one (#4633).
 *
 * 60s is where the data sits, not a round number. Of 744 synced multi-frame
 * routes 359 are paced slower than 10s a frame and the slowest are paced at
 * exactly 60s; Kilter routes average 18.8 frames at 7.5s, which is endurance
 * training rather than animation. A lower ceiling would leave a climber unable
 * to play half the catalogue at the pace its setter chose.
 *
 * The server accepts the same 60s (`framesPace` in the backend's climb
 * schemas). Raising this without raising that would reject a save the control
 * had just offered.
 */
export const MAX_PACE_MS = 60_000;

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

/**
 * Read a pace that came from storage — a synced climb, a server row, a restored
 * draft — preserving whatever it holds.
 *
 * Deliberately NOT `clampAuthoredPaceMs`. That one bounds what the authoring
 * CONTROL may produce, and its 10s ceiling is a property of the slider, not of
 * the data: Aurora climbs are synced with whatever pace their setter chose, and
 * the server accepts up to 30s precisely so those survive a round trip. Clamping
 * on the way in would silently rewrite a 20s route to 10s the next time its
 * owner opened and re-saved it, with nothing on screen to show a change — the
 * pace would simply be halved.
 *
 * 0 and null both mean "never authored" in the Aurora encoding, so they resolve
 * to the default rather than to a real value.
 */
export function resolveStoredPaceMs(paceMs: number | null | undefined): number {
  if (paceMs == null || !Number.isFinite(paceMs) || paceMs <= 0) return DEFAULT_PACE_MS;
  return Math.round(paceMs);
}

/**
 * Seconds-per-frame behind a playback multiplier — the reader's unit.
 *
 * `speed` is the wire format (party sync carries it alongside `paceMs`), but it
 * is meaningless on its own: 0.5× is 1.5s a frame on a route paced at 750ms and
 * 24s a frame on one paced at 12s. Every surface displays what this returns.
 */
export function paceSecondsForSpeed(paceMs: number, speed: number): number {
  if (!Number.isFinite(paceMs) || !Number.isFinite(speed) || speed <= 0) return DEFAULT_PACE_MS / 1000;
  return paceMs / speed / 1000;
}

/**
 * The multiplier that makes a climb paced at `paceMs` run at `seconds` a frame
 * — the inverse of {@link paceSecondsForSpeed}, and how a seconds-per-frame
 * control writes through to the engine.
 *
 * Going through the multiplier rather than overriding the pace directly is what
 * keeps party mode in step: both phones hold the same authored `paceMs`, so a
 * multiplier round-trips to the same number of seconds on the other side. A
 * peer adopts `speed` from an inbound event but keeps its own `paceMs` for its
 * timer, so broadcasting an overridden pace would desync the two.
 */
export function speedForPaceSeconds(paceMs: number, seconds: number): number {
  if (!Number.isFinite(paceMs) || paceMs <= 0 || !Number.isFinite(seconds) || seconds <= 0) return 1;
  return paceMs / (seconds * 1000);
}
