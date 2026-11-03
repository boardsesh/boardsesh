import { useSyncExternalStore } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';

/**
 * Relay mode (#7220): this phone's path to the holder of an original
 * MoonBoard, in memory like `drive-mode-store.ts`.
 *
 * - Engaged: a relay of this phone's lit through that holder, and the holder
 *   hasn't changed since. It is to a relaying phone what its own link is to a
 *   holder: Always drive the wall starts on it, and a stop holds until it goes.
 * - Suppressed: the server said no other phone can light the climb (no
 *   holder, this connection's own stale hold, or a holder with no live relay
 *   subscription) while presence still names that holder. Relaying stays off
 *   until presence's holder changes, so the next Put on board connects.
 *
 * The relay runner is registered by `use-relayed-drive.ts`, mounted once at
 * the app root, so a bulb or the player can send a climb with
 * {@link relayClimbThroughHolder} without owning the sender.
 */

type RelayPath = { boardId: number; holderKey: string };
type Suppression = { boardId: number; holderChangeSeq: number };
/** Relay `item`, or with null the queue's current climb. Returns whether a relay went. */
export type RelayRunner = (item: ClimbQueueItem | null) => boolean;

let engaged: RelayPath | null = null;
let suppressed: Suppression | null = null;
let runner: RelayRunner | null = null;
// Two listener sets: every bulb reads the suppression (`useRelayHolder`), and
// must not re-render when the path engages or drops.
const engagedListeners = new Set<() => void>();
const suppressionListeners = new Set<() => void>();

function emitEngaged(): void {
  for (const listener of engagedListeners) listener();
}

function emitSuppression(): void {
  for (const listener of suppressionListeners) listener();
}

function subscribeEngaged(listener: () => void): () => void {
  engagedListeners.add(listener);
  return () => {
    engagedListeners.delete(listener);
  };
}

function subscribeSuppression(listener: () => void): () => void {
  suppressionListeners.add(listener);
  return () => {
    suppressionListeners.delete(listener);
  };
}

export function engageRelayPath(path: RelayPath): void {
  if (engaged?.boardId === path.boardId && engaged.holderKey === path.holderKey) return;
  engaged = path;
  emitEngaged();
}

/** The path went: the holder changed or left, or a relay didn't land. Returns whether it was engaged. */
export function disengageRelayPath(): boolean {
  if (!engaged) return false;
  engaged = null;
  emitEngaged();
  return true;
}

export function getEngagedRelayPath(): RelayPath | null {
  return engaged;
}

/** No phone can light it through presence's current holder: relay stays off until the holder changes. */
export function suppressRelayPath(suppression: Suppression): void {
  suppressed = suppression;
  emitSuppression();
}

/** Whether the relay to the holder presence names now (at `holderChangeSeq`) is suppressed. */
export function isRelayPathSuppressed(boardId: number | null, holderChangeSeq: number): boolean {
  return suppressed !== null && suppressed.boardId === boardId && suppressed.holderChangeSeq === holderChangeSeq;
}

export function registerRelayRunner(next: RelayRunner): () => void {
  runner = next;
  return () => {
    if (runner === next) runner = null;
  };
}

/**
 * Send `item` (or with null the queue's current climb, for a bulb with no
 * climb of its own) to the holder's phone. False when no relay engine is
 * mounted or nothing could be sent.
 */
export function relayClimbThroughHolder(item: ClimbQueueItem | null): boolean {
  return runner?.(item) ?? false;
}

const readEngaged = (): RelayPath | null => engaged;
const readSuppressed = (): Suppression | null => suppressed;

/** The engaged path, or null. */
export function useEngagedRelayPath(): RelayPath | null {
  return useSyncExternalStore(subscribeEngaged, readEngaged, readEngaged);
}

/** Re-renders when a suppression is set; read it with {@link isRelayPathSuppressed}. */
export function useRelaySuppression(): Suppression | null {
  return useSyncExternalStore(subscribeSuppression, readSuppressed, readSuppressed);
}

/** Tests only. */
export function resetRelayPathForTests(): void {
  engaged = null;
  suppressed = null;
  runner = null;
  emitEngaged();
  emitSuppression();
}
