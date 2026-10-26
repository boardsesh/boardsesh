import { useSyncExternalStore } from 'react';

/**
 * Whether the full-screen Wall display (`app/wall-display`) is anywhere in the
 * root stack, not just on top of it. Its layout marks itself mounted for as long
 * as the route is in the stack, so a page pushed over the kiosk (the player, a
 * root modal, a notification's destination) still reads as "the display is up".
 *
 * The focused segments cannot answer this: with `/play` over the kiosk they
 * read `['play']`, and the shell behind would mount its player pane and wall
 * column again under an opaque display. A module store also keeps the tab shell
 * from re-rendering on every navigation just to ask.
 */
let mountedDisplays = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Called by the Wall display layout on mount; returns the unmount release. */
export function markWallDisplayMounted(): () => void {
  mountedDisplays += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mountedDisplays -= 1;
    notify();
  };
}

export function isWallDisplayOpen(): boolean {
  return mountedDisplays > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reactive `isWallDisplayOpen`. */
export function useWallDisplayOpen(): boolean {
  return useSyncExternalStore(subscribe, isWallDisplayOpen, isWallDisplayOpen);
}
