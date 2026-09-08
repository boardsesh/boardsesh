/// <reference types="node" />

/**
 * The Android dev-client launch sequence: install the cached dev-client APK,
 * bring up Metro (+ readiness server) for it, wire `adb reverse` so the emulator
 * reaches both, and launch the app to home with retries.
 *
 * Extracted from scripts/mobile-android-shots.ts's `runFullPipeline` so CI's
 * screenshot capture can reuse the same launch sequence without importing a
 * sibling orchestrator script — the lib layer never imports a sibling
 * orchestrator script (see scripts/lib/exec.ts). Takes the adb binary path and
 * emulator serial as plain arguments; it does not resolve the Android SDK
 * itself (see scripts/lib/android-sdk.ts for that).
 */

import type { ChildProcess } from 'node:child_process';
import { runCapture, runInherit } from './exec';
import { ANDROID_DEV_PACKAGE } from './android-app';
import {
  METRO_PORT,
  SCREENSHOT_READY_PORT,
  dumpMetroLogTail,
  homeReadyMarkerCount,
  metroDevClientUrl,
  portInUse,
  prewarmMetroBundle,
  screenshotReadinessCount,
  startMetro,
  startReadinessServer,
  stopMetro,
  stopReadinessServer,
  waitForHomeReady,
  waitForMetro,
} from './metro-dev-server';

const DEFAULT_LOG_PREFIX = '[android-dev-client]';

export interface DevClientSession {
  metro: ChildProcess;
  readinessServer: ChildProcess;
}

/** Install the dev-client APK, starting from a clean container. */
export function installDevClient(adbBinary: string, serial: string, apkPath: string): void {
  runCapture(adbBinary, ['-s', serial, 'uninstall', ANDROID_DEV_PACKAGE]); // ignore failure (not installed yet)
  const install = runInherit(adbBinary, ['-s', serial, 'install', '-r', apkPath]);
  if (install !== 0) throw new Error(`adb install failed (exit ${install})`);
  runCapture(adbBinary, ['-s', serial, 'shell', 'pm', 'clear', ANDROID_DEV_PACKAGE]); // fresh: signed out, no stale board
}

/** Bring up Metro (+ readiness server) for the dev-client to load its JS from. */
export function startMetroForDevClient(metroEnv: NodeJS.ProcessEnv): DevClientSession {
  if (portInUse(METRO_PORT)) {
    throw new Error(`port ${METRO_PORT} is already in use; stop it or set BOARDSESH_METRO_PORT to a free port.`);
  }
  const readinessServer = startReadinessServer();
  const metro = startMetro(metroEnv);
  if (!waitForMetro()) {
    // Clean up what this call already started rather than leaking a detached
    // Metro/readiness process group back to the caller, which has no handle on
    // either until this function returns.
    stopMetro(metro);
    stopReadinessServer(readinessServer);
    throw new Error(`Metro did not become ready on port ${METRO_PORT}`);
  }
  prewarmMetroBundle('android');
  return { metro, readinessServer };
}

/**
 * Wire the emulator to reach Metro and the readiness server on the host.
 *
 * The readiness-port reverse is NEW: the app's readiness GET to
 * localhost:<SCREENSHOT_READY_PORT> never left the emulator before, so
 * Android's reach-home detection relied on the Metro `$screen /home` marker
 * alone (see waitForHomeReady in metro-dev-server.ts for why iOS gets both
 * signals and Android previously got only one).
 */
export function connectDevClient(adbBinary: string, serial: string, extraPorts: readonly number[] = []): void {
  runCapture(adbBinary, ['-s', serial, 'reverse', `tcp:${METRO_PORT}`, `tcp:${METRO_PORT}`]);
  runCapture(adbBinary, ['-s', serial, 'reverse', `tcp:${SCREENSHOT_READY_PORT}`, `tcp:${SCREENSHOT_READY_PORT}`]);
  for (const port of extraPorts) {
    runCapture(adbBinary, ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
  }
}

/** Fire the deep link that loads the dev-client's JS from Metro. Does not wait. */
export function launchDevClient(adbBinary: string, serial: string): void {
  runCapture(adbBinary, ['-s', serial, 'shell', `am start -a android.intent.action.VIEW -d '${metroDevClientUrl()}'`]);
}

/**
 * Launch the dev-client and wait for it to reach home, retrying with a
 * force-stop + relaunch on a miss (the dev-client's auto-connect to Metro is
 * intermittently flaky, same as the iOS launcher — see captureIosDevice in
 * mobile-screenshots.ts for the iOS twin of this retry loop).
 */
export function launchDevClientToHome(
  adbBinary: string,
  serial: string,
  options: { timeoutSeconds?: number; attempts?: number; logPrefix?: string } = {},
): boolean {
  const logPrefix = options.logPrefix ?? DEFAULT_LOG_PREFIX;
  const timeoutSeconds = options.timeoutSeconds ?? 240;
  const attempts = options.attempts ?? 3;

  const markerBaseline = homeReadyMarkerCount();
  const readyBaseline = screenshotReadinessCount();

  let reachedHome = false;
  for (let attempt = 1; attempt <= attempts && !reachedHome; attempt += 1) {
    if (attempt > 1) {
      console.log(`${logPrefix} Not home yet; terminating and re-launching (attempt ${attempt}/${attempts})...`);
      runCapture(adbBinary, ['-s', serial, 'shell', 'am', 'force-stop', ANDROID_DEV_PACKAGE]);
    }
    console.log(`${logPrefix} Launching dev-client against Metro...`);
    launchDevClient(adbBinary, serial);
    reachedHome = waitForHomeReady(markerBaseline, readyBaseline, timeoutSeconds);
  }

  if (!reachedHome) {
    dumpMetroLogTail();
  }
  return reachedHome;
}

/** Stop the Metro + readiness server pair started by startMetroForDevClient. */
export function stopDevClientSession(session: DevClientSession): void {
  stopMetro(session.metro);
  stopReadinessServer(session.readinessServer);
}
