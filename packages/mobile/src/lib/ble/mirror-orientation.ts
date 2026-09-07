/**
 * Which way round a climb goes on the wall.
 *
 * Three sources, in order, and the order is the whole point:
 *
 *  1. `explicitFlip` — a tap on THIS climb, held locally by the surface that
 *     owns the toggle. Beats everything: the climber is looking at the wall.
 *  2. `statedIntent` — a tap on this climb recorded in the provider, which
 *     outlives the screen that made it (the play drawer is a route on iPhone,
 *     so reopening it must show the flip that is actually lit).
 *  3. `climbMirrored` — the climb's own recorded orientation. Activating a
 *     mirrored ascent from the logbook or the session feed carries
 *     `mirrored: true` through `tickToClimb`, and a party peer's item carries
 *     it over the wire, so an ascent relights the way it was climbed.
 *
 * Both `explicitFlip` and `statedIntent` are tri-state on purpose: `undefined`
 * means "nobody has said", which is NOT the same as "said un-mirrored".
 * Collapsing them would make an explicit un-flip of a mirrored ascent
 * impossible — the climb's own flag would put it straight back — and would let
 * a derived default outrank a fresher `climbMirrored` from a peer.
 *
 * Lives on its own so the drawer and the BLE auto-sender resolve orientation
 * through one expression instead of two that can drift apart.
 */
export function resolveMirroredOrientation({
  explicitFlip,
  statedIntent,
  climbMirrored,
}: {
  explicitFlip?: boolean;
  statedIntent?: boolean;
  climbMirrored?: boolean | null;
}): boolean {
  return explicitFlip ?? statedIntent ?? !!climbMirrored;
}
