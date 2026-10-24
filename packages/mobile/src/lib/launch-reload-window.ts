// What the launch update gate knows about this JS runtime, for code that must not
// import expo-updates or the gate itself (#6689).
//
// WHY. On Android, a JS reload does not close the old runtime's SQLite
// connections. A write transaction that is open at the moment of the reload keeps
// SQLite's single write lock until the process dies, so every later write fails
// for the rest of the session. Nothing in JS can release it afterwards: the new
// runtime holds no handle to that connection. The cure is to have no write
// transaction open when the gate reloads.
//
// Two states, both written by the gate only:
// - the gate is OPEN while an eligible run has not resolved: it may still decide
//   to reload;
// - a reload is REQUESTED from the moment the gate decides on one until the reload
//   is known not to be happening: it was rejected, or the gate's grace expired
//   and a further margin passed with this runtime still alive. On Android a
//   relaunch can be queued behind expo-updates' own work, so the grace alone is
//   no proof it will not land.
//
// React writers wait on `useLaunchWritesReady()`; writers outside React read
// `isLaunchReloadPossible()`; the database init chain waits out a requested
// reload before it starts another setup attempt.

let gateOpen = false;
let reloadRequested = false;
let restartCount: number | null = null;
const listeners = new Set<() => void>();
const requestClearedWaiters = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Called by the launch update gate only. */
export function setLaunchReloadPossible(possible: boolean): void {
  if (gateOpen === possible) return;
  gateOpen = possible;
  notify();
}

/** Called by the launch update gate only. */
export function setLaunchReloadRequested(requested: boolean): void {
  if (reloadRequested === requested) return;
  reloadRequested = requested;
  if (!requested) {
    const waiters = [...requestClearedWaiters];
    requestClearedWaiters.clear();
    for (const resolve of waiters) resolve();
  }
  notify();
}

/**
 * True while the launch update gate may still reload this runtime, or has asked
 * for a reload that may still land. A SQLite write that can wait must not start
 * while this is true.
 */
export function isLaunchReloadPossible(): boolean {
  return gateOpen || reloadRequested;
}

/** True from the gate's reload decision until that reload is known not to be happening. */
export function isLaunchReloadRequested(): boolean {
  return reloadRequested;
}

/** Resolves once no reload is requested. Never resolves if the reload happens. */
export function waitForLaunchReloadRequestToClear(): Promise<void> {
  if (!reloadRequested) return Promise.resolve();
  return new Promise((resolve) => {
    requestClearedWaiters.add(resolve);
  });
}

/** For `useSyncExternalStore`. Returns the unsubscribe. */
export function subscribeLaunchReloadWindow(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called by the launch update gate only, from expo-updates' `restartCount`. */
export function setJsRestartCount(count: number): void {
  restartCount = count;
}

/**
 * How many times expo-updates has restarted the JS runtime in this process, or
 * null where the gate never read it (Expo web, tests). Above zero, this runtime
 * came from a reload, and on Android a lock nobody in this runtime holds can be a
 * transaction left behind by the runtime before it.
 */
export function getJsRestartCount(): number | null {
  return restartCount;
}

export function resetLaunchReloadWindowForTests(): void {
  gateOpen = false;
  reloadRequested = false;
  restartCount = null;
  listeners.clear();
  requestClearedWaiters.clear();
}
