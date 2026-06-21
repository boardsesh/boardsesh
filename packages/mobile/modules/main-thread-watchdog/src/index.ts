import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Android-only native watchdog for the climb-list main-thread freeze
 * (S24 / Pixel 10, Android 16). A background thread posts a tick to the main
 * `Looper` every second; if the main thread doesn't run it within the threshold
 * the UI is hung. On a hang it captures the main thread's Java stack trace,
 * samples it a few times so we can tell a *parked* thread (same frame = blocked
 * on a lock / IPC / layout) from a *busy* one (frame moves = runaway loop), and
 * persists each sample to a file. The freeze ends in a force-kill, so capture +
 * persistence has to survive the process dying — the JS side drains the file and
 * reports it to PostHog on the next launch (see `src/lib/main-thread-watchdog.ts`).
 *
 * `requireOptionalNativeModule` returns null when the module isn't linked into
 * the running binary (iOS — this module is Android-only — or Expo Go / a stale
 * dev client), so every JS caller no-ops gracefully.
 */
export type MainThreadStallReport = {
  /** Wall-clock ms (Date) when this sample was captured. */
  at: number;
  /** How long the main thread had been unresponsive at capture, in ms. */
  stalledMs: number;
  /** The unresponsiveness threshold that armed the capture, in ms. */
  thresholdMs: number;
  /** 0-based index of this sample within a single stall (re-sampled while hung). */
  sampleIndex: number;
  /** The main thread's Java stack trace, one frame per line. */
  mainThreadStack: string;
};

type MainThreadWatchdogNativeModule = {
  start?(): void;
  stop?(): void;
  isRunning?(): boolean;
  /** Returns the persisted stall reports as a JSON-array string ("[]" when none). */
  getPendingStallReports?(): Promise<string>;
  clearStallReports?(): Promise<void>;
};

export const mainThreadWatchdogNative =
  requireOptionalNativeModule<MainThreadWatchdogNativeModule>('MainThreadWatchdog');
