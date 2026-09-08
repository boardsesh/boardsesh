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

/** What the surface owning the mirror toggle should tell the provider. */
export type MirrorIntentAction =
  | { kind: 'state'; climbUuid: string; mirrored: boolean }
  | { kind: 'retain'; climbUuid: string }
  | { kind: 'none' };

/**
 * The rule that keeps the wall's orientation in step with the toggle.
 *
 * Only an explicit TAP is worth recording. Stating a value derived from
 * `climb.mirrored` would make it sticky, and it would then outrank a fresher
 * `climb.mirrored` for the same climb — a crew member activating their mirrored
 * tick of the climb you are on would have their orientation dropped.
 *
 * With no tap for the climb on screen, a flip parked on some OTHER climb is one
 * we have navigated away from, so it is dropped; one parked on THIS climb is our
 * own, from before the surface remounted, and is what a reopen reads back.
 *
 * A preview states nothing at all: mirroring what you are merely looking at must
 * not re-light the live climb.
 *
 * Pure and separate from the component because the surface that owns the toggle
 * is the play drawer, whose module graph is impractical to render in a unit test
 * — this is the part worth pinning, and it does not need a renderer.
 */
export function nextMirrorIntentAction({
  isPreview,
  displayedClimbUuid,
  mirrorFlip,
}: {
  isPreview: boolean;
  displayedClimbUuid?: string;
  mirrorFlip: { climbUuid: string; mirrored: boolean } | null;
}): MirrorIntentAction {
  if (isPreview || !displayedClimbUuid) return { kind: 'none' };
  if (mirrorFlip != null && mirrorFlip.climbUuid === displayedClimbUuid) {
    return { kind: 'state', climbUuid: displayedClimbUuid, mirrored: mirrorFlip.mirrored };
  }
  return { kind: 'retain', climbUuid: displayedClimbUuid };
}
