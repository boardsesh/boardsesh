import { useSyncExternalStore } from 'react';

// Whether a player in a pane beside the list (the open iPhone Duo's split, the
// tablet shell) is showing a view-only preview rather than the queue's current
// climb (#6940). The MiniPlayer reads it: it only stands in for the pane's
// buttons while both name the same climb.
//
// Keyed by owner, so two panes (or a pane remounting) can't clear each other.

const ownersShowingPreview = new Set<symbol>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Report whether this pane's player shows a preview. `false` withdraws the report. */
export function reportPanePreview(owner: symbol, showsPreview: boolean): void {
  const had = ownersShowingPreview.has(owner);
  if (showsPreview === had) return;
  if (showsPreview) ownersShowingPreview.add(owner);
  else ownersShowingPreview.delete(owner);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return ownersShowingPreview.size > 0;
}

/** True while a pane's player shows a climb other than the queue's current one. */
export function usePanePlayerShowsPreview(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
