import type { ObserveRuntimeOverrides } from './observe-config';

/**
 * Pure in-memory slot for the expo-observe SDK, registered by
 * `observe-bootstrap.ts` (imported once, from app/_layout.tsx).
 *
 * Deliberately dependency-free — no `expo-observe`, no react-native — for the
 * same reason `analytics-bootstrap-id.ts` is: `error-reporting.ts` reads this,
 * and error-reporting is imported by a large part of the app that the node-env
 * test runner loads. Importing the SDK directly there drags in Expo's winter
 * runtime (`Cannot find module './ImportMetaRegistry'`) and takes 33 test files
 * down with it.
 *
 * Unregistered is the normal state under test and on Expo web, so every call
 * here is a no-op rather than an error.
 */
export type ObserveRuntime = {
  configure(overrides: ObserveRuntimeOverrides): void;
  reportError(error: unknown): void;
};

let runtime: ObserveRuntime | null = null;

export function setObserveRuntime(next: ObserveRuntime | null): void {
  runtime = next;
}

/** Test-only reset, so one test registering a runtime cannot leak into the next. */
export function resetObserveRuntimeForTests(): void {
  runtime = null;
}

export function configureObserve(overrides: ObserveRuntimeOverrides = {}): void {
  if (!runtime) return;
  try {
    runtime.configure(overrides);
  } catch {
    // A telemetry misconfiguration must not take the app down.
  }
}

/**
 * Report an error to Observe.
 *
 * Swallows its own failures. This runs inside the app's error-reporting funnel,
 * so a throw here would take out the Sentry report that follows it — telemetry
 * must never be able to lose the actual error.
 */
export function captureToObserve(error: unknown): void {
  if (!runtime) return;
  try {
    runtime.reportError(error);
  } catch {
    // Nothing useful to do: the reporting path itself is what failed.
  }
}
