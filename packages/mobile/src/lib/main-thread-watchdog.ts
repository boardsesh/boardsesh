import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { track } from './analytics';
import { useFreezeDebugFlag } from './freeze-debug-store';
import { mainThreadWatchdogNative, type MainThreadStallReport } from '../../modules/main-thread-watchdog/src';

// JS + native instrumentation for the Android-16 climb-list freeze. Two probes
// that together answer the question every prior fix guessed at — is the freeze a
// blocked thread, and which one?
//
//   - Native watchdog (Android only, see modules/main-thread-watchdog): captures
//     the MAIN/UI thread's stack when it stops responding, persisted across the
//     force-kill that ends the freeze, drained here on the next launch.
//   - JS heartbeat (here): a self-checking timer that detects when the JS thread
//     itself was blocked.
//
// JS alive + UI dead  => native main-thread block (layout / sync native call).
// JS dead             => the JS thread is blocked.
// Both alive          => not a thread hang (touch interception — already ruled out).

const HEARTBEAT_INTERVAL_MS = 1000;
// Match the native watchdog's 5s ANR threshold so a normal cold-start / GC pause
// doesn't get reported as a stall.
const JS_STALL_THRESHOLD_MS = 5000;
// Don't ship a megabyte of frames to PostHog if a sampled stack is pathological.
const MAX_STACK_CHARS = 8000;
// Start the watchdog only a few seconds after mount so it can never run during —
// or be blamed for — native startup. (A v1 build that auto-started it at native
// OnCreate froze before any telemetry fired.)
const WATCHDOG_START_DELAY_MS = 8000;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastTickAt = 0;
let worstGapMs = 0;

// A self-scheduling timer doesn't fire while the JS thread is blocked; when it
// resumes, the wall-clock gap since the previous tick reveals how long JS was
// stuck. setInterval coalesces missed ticks, so the gap (not the tick count) is
// the signal.
function startHeartbeat(): void {
  if (heartbeatTimer) return;
  lastTickAt = Date.now();
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    const gapMs = now - lastTickAt;
    lastTickAt = now;
    if (gapMs > worstGapMs) worstGapMs = gapMs;
    if (gapMs >= JS_STALL_THRESHOLD_MS) {
      track('JS Thread Stall', { gapMs, thresholdMs: JS_STALL_THRESHOLD_MS });
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export function getHeartbeatStatus(): { running: boolean; lastTickAt: number; worstGapMs: number } {
  return { running: heartbeatTimer !== null, lastTickAt, worstGapMs };
}

export function isWatchdogRunning(): boolean {
  try {
    return mainThreadWatchdogNative?.isRunning?.() ?? false;
  } catch {
    return false;
  }
}

function parseReports(raw: string): MainThreadStallReport[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MainThreadStallReport[]) : [];
  } catch {
    return [];
  }
}

export async function getPendingStallCount(): Promise<number> {
  const native = mainThreadWatchdogNative;
  if (!native?.getPendingStallReports) return 0;
  try {
    return parseReports(await native.getPendingStallReports()).length;
  } catch {
    return 0;
  }
}

// Drain the native watchdog's persisted main-thread stacks and forward each as a
// PostHog event, then clear the file. Called on launch and on every foreground so
// the report a tester triggers shows up the next time the app comes back.
export async function reportPendingMainThreadStalls(): Promise<number> {
  const native = mainThreadWatchdogNative;
  if (!native?.getPendingStallReports) return 0;

  let reports: MainThreadStallReport[];
  try {
    reports = parseReports(await native.getPendingStallReports());
  } catch {
    return 0;
  }
  if (reports.length === 0) return 0;

  for (const report of reports) {
    track('Main Thread Stall', {
      stalledMs: typeof report.stalledMs === 'number' ? report.stalledMs : null,
      thresholdMs: typeof report.thresholdMs === 'number' ? report.thresholdMs : null,
      sampleIndex: typeof report.sampleIndex === 'number' ? report.sampleIndex : null,
      capturedAt: typeof report.at === 'number' ? report.at : null,
      ageMs: typeof report.at === 'number' ? Date.now() - report.at : null,
      mainThreadStack:
        typeof report.mainThreadStack === 'string' ? report.mainThreadStack.slice(0, MAX_STACK_CHARS) : null,
    });
  }

  try {
    await native.clearStallReports?.();
  } catch {
    // If the clear fails the same reports re-send next launch — duplicates are
    // preferable to losing the one stack we care about.
  }
  return reports.length;
}

// Mounted once at the app root. Starts the JS heartbeat and drains any native
// main-thread stall captured before a previous force-kill, then again whenever
// the app returns to the foreground.
export function useFreezeDiagnostics(): void {
  const watchdogEnabled = useFreezeDebugFlag('enableWatchdog');

  // Drain any stack captured before a previous force-kill and report it on launch
  // + every foreground. Cheap and independent of the toggle (no-op when nothing
  // is persisted), and it runs BEFORE the watchdog is (re)started so a stack from
  // a frozen session uploads on the next clean launch.
  useEffect(() => {
    void reportPendingMainThreadStalls();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void reportPendingMainThreadStalls();
    });
    return () => {
      subscription.remove();
    };
  }, []);

  // Opt-in only. Start the JS heartbeat + native watchdog a few seconds after the
  // toggle goes on — never during boot, so the watchdog can't regress startup.
  useEffect(() => {
    if (!watchdogEnabled) {
      stopHeartbeat();
      try {
        mainThreadWatchdogNative?.stop?.();
      } catch {
        // ignore
      }
      return;
    }
    const timer = setTimeout(() => {
      startHeartbeat();
      try {
        mainThreadWatchdogNative?.start?.();
      } catch {
        // ignore
      }
    }, WATCHDOG_START_DELAY_MS);
    return () => {
      clearTimeout(timer);
      stopHeartbeat();
      try {
        mainThreadWatchdogNative?.stop?.();
      } catch {
        // ignore
      }
    };
  }, [watchdogEnabled]);
}

// Polled snapshot for the tester-only FreezeDebugPanel.
export function useFreezeDiagnosticsStatus(): {
  heartbeatRunning: boolean;
  lastTickAgeMs: number;
  worstGapMs: number;
  watchdogRunning: boolean;
  pendingStalls: number;
} {
  const [status, setStatus] = useState(() => ({
    heartbeatRunning: false,
    lastTickAgeMs: 0,
    worstGapMs: 0,
    watchdogRunning: false,
    pendingStalls: 0,
  }));

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      void getPendingStallCount().then((pendingStalls) => {
        if (!active) return;
        const heartbeat = getHeartbeatStatus();
        setStatus({
          heartbeatRunning: heartbeat.running,
          lastTickAgeMs: heartbeat.lastTickAt > 0 ? Date.now() - heartbeat.lastTickAt : 0,
          worstGapMs: heartbeat.worstGapMs,
          watchdogRunning: isWatchdogRunning(),
          pendingStalls,
        });
      });
    };
    refresh();
    const id = setInterval(refresh, 1000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return status;
}
