// What the launch update gate knows about this JS runtime, for code that must not
// import expo-updates or the gate itself (#6689).
//
// WHY. On Android, a JS reload does not close the old runtime's SQLite
// connections. A write transaction that is open at the moment of the reload keeps
// SQLite's single write lock until the process dies, so every later write fails
// for the rest of the session. Nothing in JS can release it afterwards: the new
// runtime holds no handle to that connection. The cure is to have no write
// transaction open when the gate reloads. The React side waits on
// `useLaunchReady()`. Writers outside React read `isLaunchReloadPossible()`.
//
// The gate is the only writer of this module. It opens the window when an
// eligible run starts and closes it when the gate resolves, after which it never
// reloads this runtime.

let reloadPossible = false;
let restartCount: number | null = null;

/** Called by the launch update gate only. */
export function setLaunchReloadPossible(possible: boolean): void {
  reloadPossible = possible;
}

/**
 * True while the launch update gate may still reload this runtime. A SQLite write
 * that can wait must not start while this is true.
 */
export function isLaunchReloadPossible(): boolean {
  return reloadPossible;
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
  reloadPossible = false;
  restartCount = null;
}
