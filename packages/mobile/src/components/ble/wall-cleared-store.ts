import { useSyncExternalStore } from 'react';

/**
 * The climb "Turn off all lights" darkened (#6939). The link stays up and the
 * queue doesn't move, so nothing else tells the player the wall is dark: the
 * board-presence feed still names the climb, and the status line would say Lit
 * on the wall (and the pill On the wall) over a blank board.
 *
 * Keyed by the climb that was current, so a new current climb (which the link
 * lights on its own) no longer matches. A deliberate re-light (Re-light, Put on
 * the wall) resets it.
 */
let clearedClimbUuid: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function markWallCleared(climbUuid: string | null): void {
  if (clearedClimbUuid === climbUuid) return;
  clearedClimbUuid = climbUuid;
  emit();
}

export function resetWallCleared(): void {
  markWallCleared(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const read = (): string | null => clearedClimbUuid;

/** The climb whose lights were turned off while still current, if any. */
export function useWallClearedClimbUuid(): string | null {
  return useSyncExternalStore(subscribe, read, read);
}
