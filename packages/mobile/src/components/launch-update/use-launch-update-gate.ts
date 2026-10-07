import { useState, useSyncExternalStore } from 'react';
import {
  getLaunchUpdateGateFlags,
  getLaunchUpdateProgress,
  startLaunchUpdateGate,
  subscribeLaunchUpdateGate,
  type LaunchUpdateGateEnvironment,
  type LaunchUpdateGateFlags,
} from '../../lib/launch-update-gate-store';

/**
 * The launch update gate, as the root layout needs it: whether it has resolved
 * and whether the placeholder should be up. See `lib/launch-update-gate.ts` for
 * the rules and `lib/launch-update-gate-store.ts` for the run itself.
 *
 * The first caller in a JS runtime starts the gate; every later one, a
 * remounted root layout included, reads the same run. `resolved` is already
 * true on the first render for a launch the gate does not cover, so dev builds,
 * background launches and reloaded runtimes pay nothing.
 *
 * Deliberately excludes download progress: the root layout would otherwise
 * re-render on every progress event. Only the placeholder reads that.
 */
export function useLaunchUpdateGate(environment?: LaunchUpdateGateEnvironment): LaunchUpdateGateFlags {
  // A lazy initializer runs before the first snapshot read, so that read
  // already sees a started gate.
  useState(() => startLaunchUpdateGate(environment));
  return useSyncExternalStore(subscribeLaunchUpdateGate, getLaunchUpdateGateFlags, getLaunchUpdateGateFlags);
}

/** Download progress from 0 to 1, or undefined before there is any to show. */
export function useLaunchUpdateProgress(): number | undefined {
  return useSyncExternalStore(subscribeLaunchUpdateGate, getLaunchUpdateProgress, getLaunchUpdateProgress);
}
