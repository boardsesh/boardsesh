import { useSyncExternalStore } from 'react';
import { decideTabBarVisibility, type TabBarScrollSource } from './tab-bar-visibility';

/**
 * Hide-on-scroll for the Android nav bar (M3 "hide on scroll"): whether the bar
 * is hidden, and each list's memory of where it was. Plain JS, no Reanimated:
 * the one shared value that moves the bar and everything floating on it lives
 * in `tab-bar-hide-progress.ts`, which follows this store.
 *
 * The decision runs on the JS thread, once per scroll event, in O(1): compare the
 * offset with that list's last one, add up travel in one direction, flip at 24dp.
 * Listeners hear only the flips.
 *
 * Who may hide it is decided by `TabBarVisibilityController`: Android phones with
 * the flag on, on a top-level tab, with no screen reader and no keyboard.
 * Anywhere else the gate is closed and the bar is shown.
 */

let gateOpen = false;
let reduceMotion = true;
let hidden = false;
/** Bumped by every reset; a list whose memory predates it starts over. */
let epoch = 0;
/** The last flip came from a route change or a closed gate, not a scroll. */
let lastFlipInstant = false;
const listeners = new Set<() => void>();

function publishHidden(next: boolean, instant = false): void {
  if (next === hidden) return;
  hidden = next;
  lastFlipInstant = instant;
  for (const listener of listeners) listener();
}

/** The controller publishes the gate and the Reduce Motion setting here. */
export function configureTabBarVisibility(next: { enabled: boolean; reduceMotion: boolean }): void {
  gateOpen = next.enabled;
  reduceMotion = next.reduceMotion;
  // Instant: the gate closes on a push, where the bar snaps back in flow, and
  // the chrome must not trail it.
  if (!gateOpen) publishHidden(false, true);
}

/** Tab focus or route change: show the bar and forget every list's offset. */
export function resetTabBarVisibility(): void {
  epoch += 1;
  publishHidden(false, true);
}

/** A list's memory, tagged with the reset it belongs to. */
export type TabBarScrollSourceSlot = { current: { epoch: number; source: TabBarScrollSource } | null };

/** One scroll event from one list. Notifies listeners only on a flip. */
export function reportTabBarScroll(slot: TabBarScrollSourceSlot, offset: number, focused: boolean): void {
  const remembered = slot.current !== null && slot.current.epoch === epoch ? slot.current.source : null;
  const decision = decideTabBarVisibility({ hidden, source: remembered, offset, focused, enabled: gateOpen });
  slot.current = { epoch, source: decision.source };
  publishHidden(decision.hidden);
}

export function subscribeTabBarHidden(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTabBarHidden(): boolean {
  return hidden;
}

/**
 * Whether the last flip should skip the slide: Reduce Motion (or not read yet),
 * or a show forced by a route change or a closed gate. On a push the bar snaps
 * back in flow at once, so the floating chrome has to snap with it.
 */
export function getTabBarFlipInstant(): boolean {
  return reduceMotion || lastFlipInstant;
}

/**
 * Whether the bar is hidden, for the props a shared value cannot carry
 * (`pointerEvents`, `importantForAccessibility`). Changes only on a flip.
 */
export function useTabBarHidden(): boolean {
  return useSyncExternalStore(subscribeTabBarHidden, getTabBarHidden, getTabBarHidden);
}

/** Test-only: back to a fresh launch. Keeps subscribers (the progress driver). */
export function resetTabBarVisibilityForTests(): void {
  gateOpen = false;
  reduceMotion = true;
  hidden = false;
  lastFlipInstant = false;
  epoch = 0;
}
