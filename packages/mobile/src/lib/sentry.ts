import type { ComponentType } from 'react';
import * as Sentry from '@sentry/react-native';
import { installGlobalErrorCapture } from './global-error-capture';

/**
 * Triage context attached to a reported error. Defined here (not in
 * error-reporting) because error-reporting depends on this module — keeping the
 * type here is what makes that dependency one-directional.
 */
export type ErrorReportContext = {
  level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
};

const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

/**
 * Whether Sentry is active for the current session. False in dev builds and
 * whenever no DSN is configured, so local Metro dev never sends. Preview
 * (TestFlight / internal) and production builds are both `!__DEV__`.
 */
export const isSentryEnabled = !!sentryDsn && !__DEV__;

if (isSentryEnabled) {
  Sentry.init({
    dsn: sentryDsn,
    tracesSampleRate: 0.1,
    // Explicit so a future option change can't silently turn either off. Native
    // crash handling persists SIGABRT / native exceptions across the crash and
    // uploads them on the next launch — the coverage gap PostHog (JS-only)
    // can't fill, and the reason Sentry is back. attachStacktrace gives
    // captureMessage calls a stack too.
    enableNativeCrashHandling: true,
    attachStacktrace: true,
    // App-hang / ANR tracking. This is what catches the freezes users actually
    // report in the wild (e.g. Galaxy S24 / Pixel 10) with a JS stack pinned to
    // the blocked frame — far more reliable than chasing a repro in an emulator.
    //   - iOS: enableAppHangTracking watches the main thread; any unresponsive
    //     stretch ≥ appHangTimeoutInterval seconds is reported as an App Hang.
    //     Both default on / 2s; set explicitly so a future SDK default can't
    //     flip them, matching the enableNativeCrashHandling rationale above.
    //   - Android: ANR detection is already on by default in the native
    //     sentry-android layer (5s main-thread block) — there's no JS init
    //     option to set; the @sentry/react-native/expo plugin wires the native
    //     SDK that captures it and attaches the JS stack.
    enableAppHangTracking: true,
    appHangTimeoutInterval: 2,
    // release/dist are intentionally left unset so @sentry/react-native
    // auto-detects them from the native build (CFBundleShortVersionString +
    // CFBundleVersion). Those are the exact values `sentry-cli react-native
    // xcode` tags the uploaded source maps with, so stack traces symbolicate.
    // Hardcoding release here (e.g. "2.0.0" without dist) would mismatch the
    // uploaded artifacts and break symbolication.
  });
}

// Sentry tags must be primitives; coerce non-scalar values to a readable string
// rather than dropping them so triage data survives. Objects/arrays would
// stringify to a useless "[object Object]", so JSON-serialize them to keep the
// real data; fall back to String() for anything JSON can't handle (circular
// refs, BigInt).
export function toSentryTag(value: unknown): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// The slice of Sentry's Scope this module writes to. Structural (not the SDK's
// `Scope`) so the mapping below is testable with a plain fake — and so the real
// `Scope` passed by `withScope` stays assignable to it.
type SentryScopeLike = {
  setLevel: (level: NonNullable<ErrorReportContext['level']>) => void;
  setTag: (key: string, value: string | number | boolean) => void;
  setExtra: (key: string, value: unknown) => void;
};

/**
 * Map our ErrorReportContext onto a Sentry scope. Extracted as a pure function
 * (no enablement gate, no SDK init) so the level/tag/extra mapping is directly
 * unit-testable: `captureToSentry` only runs on real builds (`!__DEV__`), so
 * without this the coercion/mapping would be invisible to CI behind the gate.
 */
export function applyErrorContextToScope(scope: SentryScopeLike, context?: ErrorReportContext): void {
  if (context?.level) scope.setLevel(context.level);
  for (const [key, value] of Object.entries(context?.tags ?? {})) {
    scope.setTag(key, toSentryTag(value));
  }
  for (const [key, value] of Object.entries(context?.extra ?? {})) {
    scope.setExtra(key, value);
  }
}

/**
 * Report an error to Sentry if it is active. No-op otherwise. The optional
 * context (level/tags/extra) is mapped onto a Sentry scope so callers can attach
 * triage data — e.g. a `source` tag and HTTP status on a failed session start.
 */
export function captureToSentry(error: unknown, context?: ErrorReportContext): void {
  if (!isSentryEnabled) return;
  Sentry.withScope((scope) => {
    applyErrorContextToScope(scope, context);
    Sentry.captureException(error);
  });
}

/** Best-effort flush so a report survives a later hard crash. */
export function flushSentry(): Promise<boolean> {
  return isSentryEnabled ? Sentry.flush() : Promise.resolve(true);
}

/**
 * Force a native crash to verify the native crash handler on a real binary — the
 * event is persisted across the crash and uploaded on the next launch. No-op
 * when Sentry is disabled so it can never hard-crash a dev / no-DSN build. Wired
 * behind the tester-only channel switcher; not for production code paths.
 */
export function nativeSentryCrash(): void {
  if (!isSentryEnabled) return;
  Sentry.nativeCrash();
}

// Wrap the RN global error handler regardless of whether Sentry is enabled: the
// console logging and worklet-serialization recovery are valuable even with no
// DSN (dev / DSN-less builds). Installed after Sentry.init so it wraps Sentry's
// handler rather than being clobbered by it. The `installed` latch inside makes
// this the single install site (posthog-client no longer installs it).
installGlobalErrorCapture({
  report: (error, context) => captureToSentry(error, context),
  flush: () => flushSentry(),
  isDev: __DEV__,
});

/**
 * Wrap a root component with the Sentry error tracking HOC. Returns the
 * component unchanged when Sentry is not active.
 */
// The constraint mirrors Sentry.wrap's signature exactly. Note: `unknown` is the
// top type, so `Record<string, unknown>` accepts any object props (including
// ReactNode children, callbacks, refs) — the constraint isn't restrictive.
export function wrapWithSentry<P extends Record<string, unknown>>(component: ComponentType<P>): ComponentType<P> {
  if (!isSentryEnabled) return component;
  return Sentry.wrap(component);
}
