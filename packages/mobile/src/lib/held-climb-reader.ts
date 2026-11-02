/**
 * Which queue entry the #4979 hold keeps dark, for the picks that read it at
 * the tap: a preview-first pick of the climb already up must not release the
 * hold, or the auto-sender lights a wall the climber never asked to light
 * (`resolveQueuePickLanding`).
 *
 * The Bluetooth provider registers a reader of its own hold ref instead of
 * this module keeping a copy, so there is one hold and nothing to keep in
 * sync. A reader, not a store: nothing re-renders for it, and a tap reads it
 * as it is at that moment.
 */

type HeldQueueItemReader = () => string | null;

let reader: HeldQueueItemReader | null = null;

/** The provider's reader. Returns the unregister, which only clears its own reader. */
export function registerHeldQueueItemReader(next: HeldQueueItemReader): () => void {
  reader = next;
  return () => {
    if (reader === next) reader = null;
  };
}

/** The held queue entry's uuid, or null: nothing held, the flag off, or no provider. */
export function readHeldQueueItemUuid(): string | null {
  return reader?.() ?? null;
}
