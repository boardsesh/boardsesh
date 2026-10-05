/// <reference types="node" />

/**
 * The judging half of the mobile E2E gate's navigation smoke (`--flow smoke` in
 * scripts/mobile-screenshots.ts, run by .github/workflows/mobile-e2e-gate.yml).
 *
 * Pure functions only: what the app's pings say, what the device log says about
 * a native crash, and which single class a failed run belongs to. The
 * orchestrator does the I/O and hands the text in, so every decision here is
 * unit-tested without a simulator. See docs/mobile-e2e-gate.md.
 */

import { NO_GRAPHQL_HIT_PROBLEM } from './screenshot-fixtures';

/**
 * The screens the smoke visits, by the name each one pings with. Shared by both
 * platforms: the flows differ (testIDs on Android, deep links on iOS), the
 * evidence does not.
 *
 * Every entry is a screen the pinned fixture set already holds requests for,
 * because the smoke replays that set and cannot be re-recorded on demand. The
 * queue sheet is not here for that reason: the only recorded flow that opens it
 * does so inside a joined party session, reached by text-matched taps on Android.
 */
export const SMOKE_ROUTES = ['/home', '/profile', '/climbs', 'play-drawer'] as const;
export type SmokeRoute = (typeof SMOKE_ROUTES)[number];

export type SmokePing =
  | { kind: 'content'; route: string; count: number }
  | { kind: 'error'; route: string; message: string };

/**
 * The pings the readiness server wrote down, one request URL per line
 * (`/smoke?kind=content&route=%2Fhome&count=12`). A line that is not a
 * well-formed ping is dropped rather than failing the run: the server is on a
 * local port and anything can knock on it.
 */
export function parseSmokePingLog(logText: string): SmokePing[] {
  const pings: SmokePing[] = [];
  for (const line of logText.split('\n')) {
    if (!line.startsWith('/smoke')) continue;
    const query = new URL(line, 'http://localhost').searchParams;
    const route = query.get('route') ?? '';
    if (query.get('kind') === 'error') {
      pings.push({ kind: 'error', route, message: query.get('message') ?? '' });
      continue;
    }
    const count = Number.parseInt(query.get('count') ?? '', 10);
    if (query.get('kind') !== 'content' || route.length === 0 || !Number.isFinite(count)) continue;
    pings.push({ kind: 'content', route, count });
  }
  return pings;
}

/** The largest count each route has reported so far. A screen pings again whenever its count changes. */
export function bestSmokeCounts(pings: readonly SmokePing[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ping of pings) {
    if (ping.kind !== 'content') continue;
    counts.set(ping.route, Math.max(counts.get(ping.route) ?? 0, ping.count));
  }
  return counts;
}

/**
 * Whether the orchestrator can stop waiting: every expected route has reported
 * content, or the app has already said it crashed (nothing more is coming).
 */
export function smokePingsSettled(pings: readonly SmokePing[], expectedRoutes: readonly string[]): boolean {
  if (pings.some((ping) => ping.kind === 'error')) return true;
  const counts = bestSmokeCounts(pings);
  return expectedRoutes.every((route) => (counts.get(route) ?? 0) > 0);
}

export interface SmokePingProblems {
  /** The crash screen mounted. */
  errors: string[];
  /** A screen never pinged, or pinged with nothing on it. */
  content: string[];
}

/** Everything the pings say went wrong. Both lists empty means every screen rendered content. */
export function findSmokePingProblems(
  pings: readonly SmokePing[],
  expectedRoutes: readonly string[],
): SmokePingProblems {
  const errors = [
    ...new Set(
      pings
        .filter((ping) => ping.kind === 'error')
        .map(
          (ping) =>
            `the app's crash screen mounted${ping.route ? ` on ${ping.route}` : ''}: ${ping.message || '(no message)'}`,
        ),
    ),
  ];
  const counts = bestSmokeCounts(pings);
  const content: string[] = [];
  for (const route of expectedRoutes) {
    const count = counts.get(route);
    if (count === undefined) {
      content.push(`no content-ready ping from ${route} within the wait: the screen never rendered.`);
    } else if (count === 0) {
      content.push(`${route} rendered with a count of 0: the screen is empty where content is required.`);
    }
  }
  return { errors, content };
}

export interface NativeCrash {
  /** The line that says the process died, trimmed. */
  headline: string;
  /** Up to eight backtrace frames, when the device log carried a tombstone. */
  frames: string[];
  /** Seconds between the process starting and dying; null when the log holds no start line for it. */
  secondsAfterStart: number | null;
}

// `adb logcat` prints `threadtime` by default:
//   10-05 09:12:33.123  1234  1260 F libc    : Fatal signal 11 (SIGSEGV), ...
const LOGCAT_LINE = /^(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+([^:]*?)\s*: (.*)$/;
const FATAL_SIGNAL = /Fatal signal \d+ \(SIG[A-Z]+\)/;
const BACKTRACE_FRAME = /#\d\d pc /;
const MAX_FRAMES = 8;

/** Milliseconds into the year. Logcat prints no year, and a smoke run does not span one. */
function logcatTimeMs(match: RegExpMatchArray): number {
  const [month, day, hour, minute, second, millis] = match.slice(1, 7).map((part) => Number.parseInt(part, 10));
  return ((((month * 31 + day) * 24 + hour) * 60 + minute) * 60 + second) * 1000 + millis;
}

/**
 * Every time the app's process died natively, from a streamed `adb logcat`.
 *
 * Scoped to the app's own pids, read off ActivityManager's `Start proc` lines:
 * an emulator logs fatal signals for system processes too, and a crash in one
 * of those is not this gate's to report. Two shapes count:
 *   - `Fatal signal N (SIG…)` logged by one of the app's pids (a native crash);
 *   - `FATAL EXCEPTION` logged by one of the app's pids (an uncaught JVM throw,
 *     which is how a JNI abort in a native module first shows up).
 * The crash dumper's `>>> <package> <<<` header covers a run whose log starts
 * after the process did.
 */
export function findAndroidNativeCrashes(logcat: string, packageId: string): NativeCrash[] {
  const startedAtMs = new Map<string, number>();
  const crashes: NativeCrash[] = [];
  const crashedPids = new Set<string>();
  let collectingFrames: NativeCrash | null = null;
  const startProc = new RegExp(`Start proc (\\d+):${packageId.replaceAll('.', '\\.')}/`);
  const dumperHeader = `>>> ${packageId} <<<`;

  for (const line of logcat.split('\n')) {
    const match = line.match(LOGCAT_LINE);
    if (!match) continue;
    const pid = match[7];
    const tag = match[10];
    const message = match[11];

    const started = message.match(startProc);
    if (started) {
      startedAtMs.set(started[1], logcatTimeMs(match));
      continue;
    }

    if (tag === 'DEBUG' && collectingFrames && BACKTRACE_FRAME.test(message)) {
      if (collectingFrames.frames.length < MAX_FRAMES) collectingFrames.frames.push(message.trim());
      continue;
    }

    const ownPid = startedAtMs.has(pid);
    const died =
      (ownPid && (FATAL_SIGNAL.test(message) || message.includes('FATAL EXCEPTION'))) ||
      (tag === 'DEBUG' && message.includes(dumperHeader));
    if (!died) continue;

    // The dumper header names the pid in its own text; a fatal-signal line is
    // logged by the dying process itself.
    const crashedPid = ownPid ? pid : (message.match(/pid: (\d+)/)?.[1] ?? pid);
    if (crashedPids.has(crashedPid)) {
      // Same death, reported a second time by the dumper: keep the first
      // headline and collect the frames that follow this one.
      collectingFrames = crashes.find((crash) => crash.headline.endsWith(`[pid ${crashedPid}]`)) ?? collectingFrames;
      continue;
    }
    crashedPids.add(crashedPid);
    const startMs = startedAtMs.get(crashedPid);
    const crash: NativeCrash = {
      headline: `${message.trim()} [pid ${crashedPid}]`,
      frames: [],
      secondsAfterStart: startMs === undefined ? null : Math.round((logcatTimeMs(match) - startMs) / 100) / 10,
    };
    crashes.push(crash);
    collectingFrames = crash;
  }
  return crashes;
}

/**
 * Every time the app's process died natively, from an iOS simulator log stream.
 *
 * The same idea as scripts/mobile-simulator-check.sh, held open for the whole
 * flow instead of thirty seconds, and matched on two things:
 *   - SpringBoard's own exit line for the app, which names the signal:
 *     `[app<com.boardsesh.app>:85886] Process exited: <… domain:signal(2) code:SIGSEGV(11)>>.`
 *     (measured on the iOS 26.5 simulator by sending the app a SIGSEGV). SIGKILL
 *     and SIGTERM are how `simctl terminate` ends it, so they do not count;
 *   - a fatal line the app itself logged before dying.
 * Narrower than that script's pattern on purpose: a bare `crash` or `FATAL`
 * matches SDK startup chatter, and a gate that reds on that gets ignored.
 */
const IOS_PROCESS_EXIT_SIGNAL = /Process exited: .*code:(SIG[A-Z]+)\(\d+\)/;
const IOS_DELIBERATE_EXIT_SIGNALS = new Set(['SIGKILL', 'SIGTERM']);
const IOS_FATAL_LINE =
  /EXC_BAD_ACCESS|EXC_CRASH|EXC_BREAKPOINT|EXC_BAD_INSTRUCTION|Terminating app due to uncaught exception|Fatal error:/;

/**
 * The `log stream` predicate that feeds `findIosNativeCrashes`: SpringBoard's
 * exit line for the app, plus whatever the app's own native modules log.
 */
export const IOS_CRASH_LOG_PREDICATE =
  '(process == "SpringBoard" AND eventMessage CONTAINS "app<com.boardsesh.app>" AND eventMessage CONTAINS "Process exited") OR subsystem == "com.boardsesh.app"';

export function findIosNativeCrashes(logText: string): NativeCrash[] {
  const crashes: NativeCrash[] = [];
  for (const line of logText.split('\n')) {
    // `log stream` echoes the predicate on its first line.
    if (line.startsWith('Filtering the log data')) continue;
    const exitSignal = line.match(IOS_PROCESS_EXIT_SIGNAL)?.[1];
    const died = exitSignal ? !IOS_DELIBERATE_EXIT_SIGNALS.has(exitSignal) : IOS_FATAL_LINE.test(line);
    if (died) crashes.push({ headline: line.trim(), frames: [], secondsAfterStart: null });
  }
  return crashes;
}

/**
 * Which one class a failed smoke belongs to. Ordered by how much each cause
 * explains: a dead process also fails Maestro and loses every later ping, so
 * the crash is named and the consequences are not.
 *
 * `native-crash-at-launch` is its own class because it is a known flake of the
 * dev-client on the CI emulator (docs/mobile-e2e-gate.md): the process dies on
 * the app surface's first Fabric commit, before any screen is up, with nothing
 * wrong on the backend side. "At launch" therefore means "before the app
 * signalled home", not a number of seconds: across nine recorded crashes it
 * fired 16 to 33 s after the process started, tracking how slow the runner was,
 * and always before home. It is the only class a run may retry, once, and the
 * verdict counts it so the pattern stays visible.
 *
 * `setup` is a run that never launched the app (no device, a failed install).
 */
export type SmokeFailureClass =
  | 'setup'
  | 'native-crash-at-launch'
  | 'native-crash'
  | 'js-error'
  | 'replay-miss'
  | 'no-home'
  | 'flow'
  | 'no-content'
  | 'capture-log';

export interface SmokeEvidence {
  nativeCrashes: readonly NativeCrash[];
  /** Whether the app signalled home at any point in this attempt. */
  reachedHome: boolean;
  /** The screenshot backend's problems (replay misses, uncovered batches). */
  backendProblems: readonly string[];
  pingProblems: SmokePingProblems;
  /** Maestro's exit code; null when it never ran. */
  maestroStatus: number | null;
  /** Render-mode and frozen-clock problems read from the capture log. */
  captureLogProblems: readonly string[];
}

/**
 * The backend's problems that count against a smoke attempt.
 *
 * An app that never got home made no requests, so the backend reports "no HIT
 * graphql lines". That silence follows from whatever stopped the app. Left in,
 * it reads as a replay miss, turns every launch crash into a plain "native
 * crash" and denies it its retry (it did, in gate run 37327200472).
 */
export function replayProblemsForSmoke(backendProblems: readonly string[], reachedHome: boolean): string[] {
  return backendProblems.filter((problem) => reachedHome || problem !== NO_GRAPHQL_HIT_PROBLEM);
}

export function classifySmokeFailure(evidence: SmokeEvidence): SmokeFailureClass | null {
  if (evidence.nativeCrashes.length > 0) {
    return !evidence.reachedHome && evidence.backendProblems.length === 0 ? 'native-crash-at-launch' : 'native-crash';
  }
  if (evidence.pingProblems.errors.length > 0) return 'js-error';
  if (evidence.backendProblems.length > 0) return 'replay-miss';
  if (!evidence.reachedHome) return 'no-home';
  if (evidence.maestroStatus !== null && evidence.maestroStatus !== 0) return 'flow';
  if (evidence.pingProblems.content.length > 0) return 'no-content';
  if (evidence.captureLogProblems.length > 0) return 'capture-log';
  return null;
}

/** The words the run log, the result file and the verdict table use for each class. */
export const SMOKE_FAILURE_LABELS: Record<SmokeFailureClass, string> = {
  setup: 'setup failed',
  'native-crash-at-launch': 'native crash at launch',
  'native-crash': 'native crash',
  'js-error': 'JS error (crash screen)',
  'replay-miss': 'replay miss',
  'no-home': 'never reached home',
  flow: 'flow assertion failed',
  'no-content': 'screen rendered no content',
  'capture-log': 'capture log check failed',
};

/** One attempt, as written to the result file. */
export interface SmokeAttempt {
  failureClass: SmokeFailureClass | null;
  problems: string[];
  pings: Array<{ route: string; count: number }>;
}

/** The file the workflow reads the outcome from. */
export interface SmokeResult {
  platform: 'ios' | 'android';
  passed: boolean;
  /** The class of the LAST attempt; null on a pass. */
  failureClass: SmokeFailureClass | null;
  /** `failureClass` in words, for the verdict table; null on a pass. */
  failureLabel: string | null;
  /** How many attempts died at launch natively, including one a retry recovered from. */
  nativeCrashAtLaunchCount: number;
  attempts: SmokeAttempt[];
}

/**
 * Whether a failed attempt earns the one fresh-boot retry. Only the launch
 * crash does, and only once: a second one is evidence, not noise.
 */
export function shouldRetrySmoke(attempts: readonly SmokeAttempt[]): boolean {
  if (attempts.length !== 1) return false;
  return attempts[0].failureClass === 'native-crash-at-launch';
}

export function buildSmokeResult(platform: 'ios' | 'android', attempts: readonly SmokeAttempt[]): SmokeResult {
  const last = attempts.at(-1);
  const failureClass = last?.failureClass ?? null;
  return {
    platform,
    passed: last !== undefined && failureClass === null,
    failureClass,
    failureLabel: failureClass === null ? null : SMOKE_FAILURE_LABELS[failureClass],
    nativeCrashAtLaunchCount: attempts.filter((attempt) => attempt.failureClass === 'native-crash-at-launch').length,
    attempts: [...attempts],
  };
}
