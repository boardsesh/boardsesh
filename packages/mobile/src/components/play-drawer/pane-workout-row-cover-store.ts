import { useSyncExternalStore } from 'react';

// Whether the MiniPlayer carries the open Duo pane's Fell / Sent row (#6940).
// In a timed block the bar sits on top of the pane player's small row and draws
// its own Fell and Sent there, so the pane's row is covered but still in the
// accessibility tree: VoiceOver would find two pairs. The pane hides its row
// from accessibility while the bar reports it carries it.
//
// Keyed by owner, so a bar remounting (or UIKit mounting two) can't clear
// another's report.

const ownersCarrying = new Set<symbol>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Report whether this bar carries the pane's Fell / Sent. `false` withdraws the report. */
export function reportBarCarriesPaneWorkoutRow(owner: symbol, carries: boolean): void {
  const had = ownersCarrying.has(owner);
  if (carries === had) return;
  if (carries) ownersCarrying.add(owner);
  else ownersCarrying.delete(owner);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return ownersCarrying.size > 0;
}

/** True while the MiniPlayer draws Fell / Sent over the pane's own row. */
export function useBarCarriesPaneWorkoutRow(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
