/**
 * When auto-disconnect lets go of the board, for the views that end before it
 * does: Put on board's keep-lighting window shows its end as the sooner of its
 * own and this one (spec B2), so a 45 s window under a 30 s auto-disconnect
 * counts down to the disconnect, not past it.
 *
 * The Bluetooth provider registers a reader of its own deadline controller
 * (`AutoDisconnectController.getDeadlineMs`) instead of this module keeping a
 * copy, so there is one deadline and nothing to keep in sync. A reader, not a
 * store: the deadline moves on every write and nothing needs to re-render for
 * that alone; the window's clock reads it on its own tick.
 */

type DeadlineReader = () => number | null;

let reader: DeadlineReader | null = null;

/** The provider's reader. Returns the unregister, which only clears its own reader. */
export function registerAutoDisconnectDeadlineReader(next: DeadlineReader): () => void {
  reader = next;
  return () => {
    if (reader === next) reader = null;
  };
}

/** `Date.now()` ms when auto-disconnect fires, or null: off, no link, or no provider. */
export function readAutoDisconnectDeadlineMs(): number | null {
  return reader?.() ?? null;
}

/**
 * The climber's own activity for the same deadline: the player changed the
 * climb on screen, or a wall-button press. A successful write already counts
 * (the provider wraps its sender). The provider registers what pushes its
 * deadline out; with no provider (no board) this does nothing.
 */
type ActivityHandler = () => void;

let activityHandler: ActivityHandler | null = null;

/** The provider's handler. Returns the unregister, which only clears its own handler. */
export function registerAutoDisconnectActivity(next: ActivityHandler): () => void {
  activityHandler = next;
  return () => {
    if (activityHandler === next) activityHandler = null;
  };
}

/** Push auto-disconnect's deadline out: the climber is at the wall. */
export function noteAutoDisconnectActivity(): void {
  activityHandler?.();
}
