import { useSyncExternalStore } from 'react';

/**
 * Whether the iPhone Duo is half open (its hinge reports `partiallyOpen`), the
 * pose where the fold divides the inner display and the phone split keeps a
 * gutter clear of it. Published by `HingeObserver` (SwiftUI `onHingeChange`
 * through `@expo/ui`), read by the split host in `NativeTabletContent`.
 *
 * A module store with a boolean snapshot on purpose: the hinge reports its angle
 * continuously while the device moves, and only the open/half-open/closed status
 * matters for layout. `publishHingeStatus` drops every report that leaves the
 * boolean as it was, so a fold gesture re-renders the split once, not per frame.
 *
 * `false` until a hinge reports, and always on devices without one, so every
 * other phone lays out exactly as before.
 */

/** Mirrors `@expo/ui`'s `HingeStatus`, kept local so this module stays free of native imports. */
export type DeviceHingeStatus = 'closed' | 'partiallyOpen' | 'fullyOpen' | 'unknown';

let partiallyOpen = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  return partiallyOpen;
}

/** Record the hinge's status. `null` is a device (or a view tree) with no hinge. */
export function publishHingeStatus(status: DeviceHingeStatus | null): void {
  const next = status === 'partiallyOpen';
  if (next === partiallyOpen) return;
  partiallyOpen = next;
  for (const listener of listeners) listener();
}

/** True while the device is half open. */
export function useHingePartiallyOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only: back to the launch state. */
export function resetHingeStatusForTests(): void {
  partiallyOpen = false;
  listeners.clear();
}
