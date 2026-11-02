import { useSyncExternalStore } from 'react';
import type { WallControlModel } from './wall-control';

// The player's board control, handed to the MiniPlayer beside it (#7000, the
// tablet rule: the open Duo's pane, a tablet's player route). With the bulb
// chosen the bar's bulb draws this model and runs this tap and hold, through
// the player's own handler (`useWallControl`), so its face and taps match the
// player's and the events fire once with `control: 'mini_bar'`.
//
// Keyed by owner, so a player remounting can't clear another's report.

/** What the pane hands the bar: the model to draw, and the pane's own tap and hold. */
export type PaneWallControl = {
  model: WallControlModel;
  press: () => void;
  longPress: () => void;
};

const controls = new Map<symbol, PaneWallControl>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The pane player's board control; `null` withdraws it. */
export function registerPaneWallControl(owner: symbol, control: PaneWallControl | null): void {
  if (control === null) {
    if (!controls.delete(owner)) return;
  } else {
    if (controls.get(owner) === control) return;
    controls.set(owner, control);
  }
  emit();
}

function getControl(): PaneWallControl | null {
  let latest: PaneWallControl | null = null;
  for (const control of controls.values()) latest = control;
  return latest;
}

/** The board control of the player beside the bar, while one is mounted. */
export function usePaneWallControl(): PaneWallControl | null {
  return useSyncExternalStore(subscribe, getControl, getControl);
}
