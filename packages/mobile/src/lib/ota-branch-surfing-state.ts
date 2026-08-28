import { useSyncExternalStore } from 'react';

/**
 * What the root layout's `OtaBranchControlCenter` already knows about this
 * binary's ability to surf OTA branches, published so surfaces outside that
 * subtree (the QA launch gate, the user drawer) can read it without redoing the
 * work or, worse, racing it.
 *
 * `ready` is the load-bearing half. A surfing-capable binary runs a one-time
 * migration on first launch that clears a retired channel override and ends in
 * `Updates.reloadAsync()`. Anything that navigates before that settles is
 * pushing a route the reload throws away — so consumers wait for `ready` rather
 * than assuming the first render is the real one.
 */
export type OtaBranchSurfingState = {
  /** This binary's build-time headers allow a runtime branch override. */
  surfingBuild: boolean;
  /** The one-time migration has settled; no reload is pending. */
  ready: boolean;
};

const INITIAL_STATE: OtaBranchSurfingState = { surfingBuild: false, ready: false };

// Reference-stable between writes: useSyncExternalStore compares snapshots by
// identity, so handing back a fresh object per call reads as "changed on every
// commit" and loops render → forceStoreRerender until React's update-depth
// guard fires.
let currentState: OtaBranchSurfingState = INITIAL_STATE;
const listeners = new Set<() => void>();

/** Watch for changes outside React. Returns the unsubscribe. */
export function subscribeOtaBranchSurfingState(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): OtaBranchSurfingState {
  return currentState;
}

/** Read the current state outside React (effects, one-shot checks). */
export function getOtaBranchSurfingState(): OtaBranchSurfingState {
  return currentState;
}

/**
 * Publish what the root layout resolved. A no-op when nothing actually changed,
 * so a re-render of the writer can't wake every subscriber for nothing.
 */
export function setOtaBranchSurfingState(next: OtaBranchSurfingState): void {
  if (currentState.surfingBuild === next.surfingBuild && currentState.ready === next.ready) return;
  currentState = next;
  for (const listener of listeners) {
    listener();
  }
}

/** Test seam: put the module back to its pre-launch state. */
export function resetOtaBranchSurfingStateForTests(): void {
  currentState = INITIAL_STATE;
  listeners.clear();
}

export function useOtaBranchSurfingState(): OtaBranchSurfingState {
  return useSyncExternalStore(subscribeOtaBranchSurfingState, getSnapshot, getSnapshot);
}
