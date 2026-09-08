/// <reference types="node" />

/**
 * Metro dev-server lifecycle + "reached home" readiness helpers for the mobile
 * screenshot tooling.
 *
 * Moved out of scripts/mobile-screenshots.ts so the Android dev-client launch
 * sequence (scripts/lib/android-dev-client.ts) can reuse it from CI without
 * violating the lib-layer rule: the lib layer never imports a sibling
 * orchestrator script (see scripts/lib/exec.ts). mobile-screenshots.ts,
 * mobile-android-shots.ts, and mobile-ios-shots.ts all import from here now.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOBILE_DIR = resolve(ROOT_DIR, 'packages', 'mobile');
const LOG = '[mobile:screenshots]';

// Metro's stdout is tee'd here so waitForHomeReady can poll it for the app's
// "$screen /home" readiness marker — the JS console logs land in Metro's output,
// not the device's unified log.
export const METRO_LOG_PATH = join(tmpdir(), 'boardsesh-screenshot-metro.log');
// Metro dev server port the dev-client loads its JS bundle from. Defaults to
// 8081; override with BOARDSESH_METRO_PORT when it's taken (this repo runs a
// Metro per worktree). The orchestrator passes the matching dev-client URL to
// Maestro via `-e MAESTRO_DEV_CLIENT_URL`, so the flows never hard-code a port.
export const METRO_PORT = Number.parseInt(process.env.BOARDSESH_METRO_PORT ?? '', 10) || 8081;
// The app pings this local port (from the sim, which shares the host loopback)
// once it reaches home, so reach-home detection doesn't depend on Metro forwarding
// the `$screen /home` marker to its stdout — that forwarding intermittently dies
// with ERR_STREAM_UNABLE_TO_PIPE after a slow bundle build (esp. on the iPhone
// shards), dropping the marker even though the app DID reach home.
export const SCREENSHOT_READY_PORT = Number.parseInt(process.env.BOARDSESH_SCREENSHOT_READY_PORT ?? '', 10) || 19870;

const DEV_CLIENT_URL_SCHEME = 'exp+boardsesh';

function runCapture(command: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
}

/** expo-development-client deep link that loads the JS bundle from our Metro. */
export function metroDevClientUrl(metroPort = METRO_PORT): string {
  return `${DEV_CLIENT_URL_SCHEME}://expo-development-client/?url=${encodeURIComponent(`http://localhost:${metroPort}`)}`;
}

/** True if anything is already listening on the port (a foreign Metro). */
export function portInUse(port: number): boolean {
  return spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).status === 0;
}

/**
 * Start Metro in the background. `detached` so cleanup can kill the whole process
 * group; `CI=1` keeps expo non-interactive (no keypress menu / TTY expectations).
 */
// The app appends one line here (via the readiness server) each time it reaches
// home. The reach-home wait counts new lines alongside the Metro `$screen /home`
// marker — a signal that survives Metro's log forwarding dying.
export const READINESS_LOG_PATH = join(tmpdir(), 'boardsesh-screenshot-ready.log');
// `logPath` is parameterized for tests only, so they never touch the real log a
// concurrent capture run might be counting.
export function screenshotReadinessCount(logPath: string = READINESS_LOG_PATH): number {
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  return log.split('\n').filter((line) => line.length > 0).length;
}

// Diagnostic only: can the host itself hit the readiness server? If not, the child
// process never bound (so the app's ping can't land either) and reach-home is relying
// on the Metro marker alone.
export function readinessServerReachable(): boolean {
  const probe = spawnSync('curl', [
    '-s',
    '-o',
    '/dev/null',
    '--max-time',
    '3',
    // /probe (not /ready) so this reachability check doesn't itself bump the counter.
    `http://127.0.0.1:${SCREENSHOT_READY_PORT}/probe`,
  ]);
  return probe.status === 0;
}

/**
 * Start the readiness server as a SEPARATE detached process. The orchestrator
 * itself is fully synchronous (spawnSync for sleep/simctl/maestro), so an
 * in-process HTTP server's event loop would be starved and never bind or accept.
 * A child process has its own event loop; it appends a line to READINESS_LOG_PATH
 * on every `/ready` GET, and the sync orchestrator just reads that file. Bound to
 * 0.0.0.0 so the simulator reaches it over IPv4 the same way it reaches Metro.
 * Truncates the log first; kill the returned process in a finally.
 */
export function startReadinessServer(): ChildProcess {
  writeFileSync(READINESS_LOG_PATH, '');
  const serverCode = [
    `const http = require('http');`,
    `const fs = require('fs');`,
    `http.createServer((request, response) => {`,
    `  if (request.url && request.url.indexOf('/ready') === 0) {`,
    `    fs.appendFileSync(${JSON.stringify(READINESS_LOG_PATH)}, 'x\\n');`,
    `  }`,
    `  response.statusCode = 204;`,
    `  response.end();`,
    `}).listen(${SCREENSHOT_READY_PORT}, '0.0.0.0');`,
  ].join('\n');
  const server = spawn(process.execPath, ['-e', serverCode], { stdio: 'ignore', detached: true });
  // Don't let the child keep the orchestrator's event loop alive at exit.
  server.unref();
  // Verify the child actually bound. Its stdio is 'ignore', so a bind failure
  // (port already taken, child crash) would otherwise be silent and reach-home
  // would quietly degrade to the Metro marker alone — the exact single-signal
  // fragility this server exists to remove. The up-to-5s wait blocks
  // synchronously ON PURPOSE: this orchestrator is fully synchronous
  // (spawnSync everywhere), and nothing useful can happen before the second
  // reach-home signal is known to be live.
  let bound = false;
  for (let attempt = 0; attempt < 10 && !bound; attempt += 1) {
    sleepSeconds(0.5);
    bound = readinessServerReachable();
  }
  if (bound) {
    console.log(`${LOG} Readiness server started (pid ${server.pid ?? '?'}) on port ${SCREENSHOT_READY_PORT}.`);
  } else {
    console.warn(
      `${LOG} WARNING: readiness server never responded on port ${SCREENSHOT_READY_PORT} — is the port in use? ` +
        `Reach-home will rely on the Metro '$screen /home' marker alone.`,
    );
  }
  return server;
}

export function stopReadinessServer(server: ChildProcess): void {
  if (server.pid === undefined) return;
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    try {
      server.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

export function startMetro(env: NodeJS.ProcessEnv): ChildProcess {
  // Pipe Metro's output through `tee` to METRO_LOG_PATH so waitForHomeReady can poll
  // it for the app's "$screen /home" marker — the JS console logs land in Metro's
  // stdout, NOT the device's unified log.
  //
  // Two footguns this line threads:
  //   - `stdio:'inherit'` (the old value) made this DETACHED child share the runner's
  //     stdout, which throws ERR_STREAM_UNABLE_TO_PIPE when that stream hits
  //     backpressure/close and stalls the log mid-run — so the marker never lands and
  //     the slower-booting iPad shards time out. So use `stdio:'ignore'`.
  //   - A plain `> FILE` redirect (which avoids the pipe) block-buffers the
  //     forwarded child output when the target is a regular file, so the file stays
  //     EMPTY until a flush that may never come during the wait → EVERY shard times
  //     out with an empty log. `| tee` keeps stdout a pipe, which stays line-buffered,
  //     so the marker appears promptly. `tee` (no `-a`) truncates for a clean run.
  // Trade-off: Metro no longer streams into the live CI run log — dumpMetroLogTail
  // surfaces it on a reach-home failure instead.
  return spawn('sh', ['-c', `vp exec expo start --port ${METRO_PORT} 2>&1 | tee ${METRO_LOG_PATH}`], {
    cwd: MOBILE_DIR,
    env: { ...env, CI: '1' },
    stdio: 'ignore',
    detached: true,
  });
}

/**
 * Dump the tail of the Metro log to the run output. Metro no longer streams into
 * the live CI log (see startMetro), so on a reach-home failure this is how the
 * app-side console output (auth errors, a redbox, a missing `$screen /home`) is
 * surfaced for debugging.
 */
export function dumpMetroLogTail(lines = 80): void {
  if (!existsSync(METRO_LOG_PATH)) {
    console.error(`${LOG} (no Metro log at ${METRO_LOG_PATH} to dump)`);
    return;
  }
  const tail = readFileSync(METRO_LOG_PATH, 'utf8').split('\n').slice(-lines).join('\n');
  console.error(
    `${LOG} --- last ${lines} lines of Metro log (${METRO_LOG_PATH}) ---\n${tail}\n${LOG} --- end Metro log ---`,
  );
}

/**
 * Compile the JS bundle the dev-client will request, so its load in Maestro is a
 * Metro transform-cache hit instead of a cold bundle (3900+ modules, ~100s+ on a
 * fresh CI runner with no on-disk Metro cache) on the auth-screen wait's critical
 * path — which has timed out there. We fetch the manifest the dev-client would
 * and request its exact launchAsset URL (same hermes/bytecode transform params),
 * so Metro caches the right variant. Best-effort: a miss just falls back to
 * Maestro cold-loading the bundle (its wait is generous).
 */
export function prewarmMetroBundle(platform: 'ios' | 'android' = 'ios'): boolean {
  // This is load-bearing for reach-home: the dev-client requests this exact bundle
  // on launch, and if it isn't already cached the cold build (30s+, 4600+ modules)
  // overruns the dev-client's load timeout — the app then shows the "Searching for
  // development servers" launcher / "Failed to load app" error and never reaches
  // home. So retry until the bundle actually caches (the manifest can 404 for a beat
  // right after Metro starts, and a build can transiently 500). Idempotent: once
  // Metro has built + cached the bundle, later requests are instant hits.
  console.log(`${LOG} Pre-warming the Metro bundle...`);
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const manifest = runCapture('curl', [
      '-fsS',
      '--max-time',
      '30',
      `http://localhost:${METRO_PORT}/`,
      '-H',
      `expo-platform: ${platform}`,
      '-H',
      'Accept: application/expo+json,application/json',
    ]);
    let bundleUrl: string | undefined;
    if (manifest.status === 0) {
      try {
        bundleUrl = (JSON.parse(manifest.stdout) as { launchAsset?: { url?: string } }).launchAsset?.url;
      } catch {
        // Non-JSON manifest — retry.
      }
    }
    if (bundleUrl) {
      const warmed = runCapture('curl', ['-fsS', '-o', '/dev/null', '--max-time', '300', bundleUrl]);
      if (warmed.status === 0) {
        console.log(`${LOG} Metro bundle pre-warmed (attempt ${attempt}).`);
        return true;
      }
    }
    console.log(`${LOG} Metro not ready to serve the bundle yet (attempt ${attempt}/6); retrying...`);
    sleepSeconds(5);
  }
  console.warn(
    `${LOG} Metro pre-warm did not succeed after retries; the app will cold-load the bundle and reach-home may fail.`,
  );
  return false;
}

/** Poll Metro's /status until it answers (or ~120s elapse). */
export function waitForMetro(): boolean {
  const statusUrl = `http://localhost:${METRO_PORT}/status`;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (runCapture('curl', ['-fsS', '-o', '/dev/null', statusUrl]).status === 0) {
      console.log(`${LOG} Metro is ready on port ${METRO_PORT}.`);
      return true;
    }
    sleepSeconds(2);
  }
  return false;
}

/**
 * Wait for a just-stopped Metro process group to release its listening port.
 * Capped at 60s: on a loaded CI runner the TCP stack can take a while to free the
 * port between locale runs, and failing the next locale here would throw away the
 * 60+ minutes already spent on earlier locales.
 */
export function waitForPortToClose(port: number): boolean {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!portInUse(port)) return true;
    sleepSeconds(1);
  }
  return false;
}

export function stopMetro(metro: ChildProcess | null): void {
  if (!metro || metro.pid === undefined) return;
  console.log(`${LOG} Stopping Metro...`);
  try {
    // Negative PID targets the detached process group, so Metro's node children
    // die with it.
    process.kill(-metro.pid, 'SIGTERM');
  } catch {
    try {
      metro.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

function sleepSeconds(seconds: number): void {
  spawnSync('sleep', [String(seconds)]);
}

/**
 * How many times the app has logged it reached home so far. The `$screen /home`
 * analytics line lands in Metro's stdout (NOT the device's unified log), which
 * startMetro tee's to METRO_LOG_PATH — so count occurrences in that file.
 */
export function homeReadyMarkerCount(): number {
  const metroLog = existsSync(METRO_LOG_PATH) ? readFileSync(METRO_LOG_PATH, 'utf8') : '';
  return metroLog.split('$screen /home').length - 1;
}

/**
 * After launch, wait until the app reaches the home screen, so the first
 * screenshot isn't a blank/loading frame. The screenshot build auto-signs-in and
 * boots straight to home (no login screen). Two independent signals, either one
 * counts (both a shared Metro log and a shared readiness counter carry the
 * previous device's hit, so wait for a NEW hit past each baseline):
 *   - the Metro `$screen /home` marker (fast, but lost when Metro's log forwarding
 *     dies mid-run with ERR_STREAM_UNABLE_TO_PIPE), and
 *   - a direct GET from the app to the readiness server (survives that).
 */
export function waitForHomeReady(markerBaseline = 0, readyBaseline = 0, timeoutSeconds = 180): boolean {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (homeReadyMarkerCount() > markerBaseline) return true;
    if (screenshotReadinessCount() > readyBaseline) return true;
    sleepSeconds(2);
  }
  return false;
}
