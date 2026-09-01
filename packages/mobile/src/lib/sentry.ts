import type { ComponentType } from 'react';
import * as Sentry from '@sentry/react-native';
import { installGlobalErrorCapture } from './global-error-capture';
import { resolveAppEnvironment } from './app-environment';
import type { InterruptedLiveActivityIntentDiagnostic } from './live-activity/live-activity-plugin';

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

// @expo/ui's Android bottom sheet fires `sheetRef.partialExpand()` / `expand()`
// fire-and-forget inside `snapToIndex` (community/bottom-sheet/BottomSheet.android.tsx).
// A store binary built against an older @expo/ui native layer never registered that
// AsyncFunction on the `ModalBottomSheetView` native view, so the call rejects
// ("No handler registered for AsyncFunction '<method>' on view 'ModalBottomSheetView'")
// and, being unawaited, surfaces as an onunhandledrejection. The op is a no-op on those
// binaries (the sheet is already at that detent).
//
// The real fix guards the call at source: `patches/@expo%2Fui@57.0.3.patch` attaches a
// `.catch` to both calls in BottomSheet.android.tsx (issue #3478), so once a binary pulls
// that OTA the rejection never fires. This filter is now belt-and-braces: it still drops
// the report from binaries running the pre-patch OTA bundle, and from the tail of old
// binaries before the next native build ships. Match the view name + method (never a bare
// `partialExpand` substring) so no unrelated error is ever dropped; cover `expand` too —
// same mechanism, even though only `partialExpand` rejects on today's fleet. See
// docs/mobile-ota-updates.md: JS-only, so it keeps the same fingerprint and rides the OTA.
const EXPO_UI_SHEET_NO_HANDLER =
  /Call to function 'ModalBottomSheetView\.(?:partialExpand|expand)' has been rejected|No handler registered for AsyncFunction '(?:partialExpand|expand)' on view 'ModalBottomSheetView'/;

type SentryEventLike = { exception?: { values?: Array<{ value?: string | undefined }> } };

/**
 * Pure predicate: does this Sentry event / hint carry the benign @expo/ui Android sheet
 * "No handler registered" rejection? Exported (no enablement gate, no SDK) so it's
 * directly unit-testable, matching applyErrorContextToScope et al. Both the event's
 * `exception.values[].value` and `hint.originalException` are checked because Sentry can
 * split the JS `Error.cause` chain (the outer "has been rejected" vs the native
 * IllegalStateException cause) across those two places.
 */
export function isExpoUiSheetNoHandlerRejection(event: SentryEventLike, originalException?: unknown): boolean {
  const values = event.exception?.values ?? [];
  const fromEvent = values.map((entry) => entry.value ?? '').join('\n');
  const fromHint =
    originalException instanceof Error ? `${originalException.message}\n${originalException.stack ?? ''}` : '';
  return EXPO_UI_SHEET_NO_HANDLER.test(fromEvent) || EXPO_UI_SHEET_NO_HANDLER.test(fromHint);
}

if (isSentryEnabled) {
  Sentry.init({
    dsn: sentryDsn,
    // production for store/TestFlight bundles; 'preview' for pr-* OTA bundles so
    // their crashes are filterable out of the prod view. See resolveAppEnvironment
    // (shared with PostHog — app-environment.ts).
    environment: resolveAppEnvironment(),
    tracesSampleRate: 0.1,
    // Drop the benign @expo/ui Android sheet "No handler registered" unhandled rejection
    // (partialExpand/expand on a binary whose native layer predates the method). Scoped
    // to that exact signature so every other rejection still reports. See
    // isExpoUiSheetNoHandlerRejection above.
    beforeSend(event, hint) {
      if (isExpoUiSheetNoHandlerRejection(event, hint?.originalException)) return null;
      return event;
    },
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

/** Result of normalizing a captured value into something Sentry can render usefully. */
export type NormalizedCapturedError = {
  error: Error;
  extra?: Record<string, unknown>;
};

// Structural shape of a browser Event/CloseEvent/ErrorEvent — every field is
// `unknown` on purpose since we only trust it after checking its runtime type.
type EventLike = {
  type?: unknown;
  code?: unknown;
  reason?: unknown;
  wasClean?: unknown;
  target?: unknown;
};

/**
 * Strip a WebSocket URL down to protocol+host+pathname so a captured auth
 * token or session id in the query string (or userinfo) never reaches
 * Sentry. Returns undefined for anything that isn't a parseable URL string.
 */
function sanitizeSocketUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * Normalizes a value on its way to `Sentry.captureException`. graphql-ws's
 * `dispose()` and raw `wsClient.subscribe` error sinks reject/forward the
 * browser's native `Event`/`CloseEvent` objects (not `Error` instances) on a
 * WebSocket failure — Sentry renders those as `<unknown>` / `Event` /
 * `anonymous`, discarding the close code and reason that would actually
 * explain the failure (#4241).
 *
 * Duck-types on a `type` field rather than `instanceof Event`/`CloseEvent`:
 * RN/Hermes' DOM-event polyfills aren't reliable across native vs. Expo-web,
 * so structural detection is the only check that holds in both. A match is
 * rewrapped as a proper `Error` (message carries the event type and close
 * code, when present) with the code/reason/wasClean/readyState/sanitized
 * socket URL surfaced as `extra` so triage isn't blind. Anything already an
 * `Error` passes through unchanged; anything else (string, number, plain
 * object with no `type`) falls back to `new Error(String(value))` so no
 * value is ever handed to Sentry raw.
 */
export function normalizeCapturedValueForSentry(value: unknown): NormalizedCapturedError {
  if (value instanceof Error) return { error: value };
  if (typeof value === 'object' && value !== null && 'type' in value) {
    const eventLike = value as EventLike;
    const type = typeof eventLike.type === 'string' ? eventLike.type : 'unknown';
    const code = typeof eventLike.code === 'number' ? eventLike.code : undefined;
    const extra: Record<string, unknown> = { type };
    if (code !== undefined) extra.code = code;
    if (typeof eventLike.reason === 'string' && eventLike.reason) extra.reason = eventLike.reason;
    if (typeof eventLike.wasClean === 'boolean') extra.wasClean = eventLike.wasClean;
    if (typeof eventLike.target === 'object' && eventLike.target !== null) {
      const target = eventLike.target as { readyState?: unknown; url?: unknown };
      if (typeof target.readyState === 'number') extra.readyState = target.readyState;
      const sanitizedUrl = sanitizeSocketUrl(target.url);
      if (sanitizedUrl) extra.url = sanitizedUrl;
    }
    return {
      error: new Error(`WebSocket ${type}${code !== undefined ? ` (code ${code})` : ''}`),
      extra,
    };
  }
  return { error: new Error(String(value)) };
}

/**
 * Report an error to Sentry if it is active. No-op otherwise. The optional
 * context (level/tags/extra) is mapped onto a Sentry scope so callers can attach
 * triage data — e.g. a `source` tag and HTTP status on a failed session start.
 * The captured value is normalized first (see normalizeCapturedValueForSentry)
 * so a raw WebSocket Event/CloseEvent never reaches Sentry as an opaque object.
 */
export function captureToSentry(error: unknown, context?: ErrorReportContext): void {
  if (!isSentryEnabled) return;
  const { error: normalizedError, extra } = normalizeCapturedValueForSentry(error);
  Sentry.withScope((scope) => {
    applyErrorContextToScope(scope, context);
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        scope.setExtra(key, value);
      }
    }
    Sentry.captureException(normalizedError);
  });
}

export const LIVE_ACTIVITY_INTENT_INTERRUPTED_FINGERPRINT = 'live-activity-intent-interrupted';

type LiveActivityIntentDiagnosticScope = {
  setLevel: (level: 'info') => void;
  setFingerprint: (fingerprint: string[]) => void;
  setTag: (key: string, value: string | number | boolean) => void;
  setExtra: (key: string, value: unknown) => void;
};

/**
 * Applies the fixed grouping and bounded, native-sanitized context for one
 * previous-process Live Activity intent marker. Extracted so CI can prove the
 * informational-message contract even though Sentry is disabled in tests.
 */
export function applyLiveActivityIntentDiagnosticToScope(
  scope: LiveActivityIntentDiagnosticScope,
  diagnostic: InterruptedLiveActivityIntentDiagnostic,
): void {
  scope.setLevel('info');
  scope.setFingerprint([LIVE_ACTIVITY_INTENT_INTERRUPTED_FINGERPRINT]);
  scope.setTag('source', 'live-activity-intent-diagnostics');
  scope.setTag('intent_kind', diagnostic.intentKind);
  scope.setTag('last_stage', diagnostic.lastStage);
  scope.setTag('react_root_mounted', String(diagnostic.reactRootMounted));
  scope.setTag('intent_schema_version', diagnostic.schemaVersion);
  scope.setTag('app_version', diagnostic.appVersion);
  scope.setTag('build_number', diagnostic.buildNumber);
  // Random recorder IDs are extras rather than high-cardinality indexed tags.
  // They identify only this diagnostic run/process, never a user or session.
  scope.setExtra('run_id', diagnostic.runId);
  scope.setExtra('process_id', diagnostic.processId);
  scope.setExtra('started_at_ms', diagnostic.startedAtMs);
  scope.setExtra('updated_at_ms', diagnostic.updatedAtMs);
  scope.setExtra('elapsed_ms', Math.max(0, diagnostic.updatedAtMs - diagnostic.startedAtMs));
}

type LiveActivityIntentDiagnosticWithScope = (callback: (scope: LiveActivityIntentDiagnosticScope) => void) => void;

type LiveActivityIntentDiagnosticCaptureMessage = (message: string, level: 'info') => void;

/**
 * Sends an intent diagnostic through an already-enabled Sentry context.
 * Kept separate from the production enablement gate so the actual SDK emission
 * contract remains directly testable in Vitest, where __DEV__ is inlined true.
 */
export function captureEnabledLiveActivityIntentDiagnostic(
  diagnostic: InterruptedLiveActivityIntentDiagnostic,
  withScope: LiveActivityIntentDiagnosticWithScope,
  captureMessage: LiveActivityIntentDiagnosticCaptureMessage,
): void {
  withScope((scope) => {
    applyLiveActivityIntentDiagnosticToScope(scope, diagnostic);
    captureMessage('Live Activity intent did not complete before its process ended', 'info');
  });
}

/**
 * Reports an interrupted native intent as an informational message. It is not
 * an exception or crash and therefore cannot inflate crash-free statistics.
 */
export function captureLiveActivityIntentDiagnostic(diagnostic: InterruptedLiveActivityIntentDiagnostic): void {
  if (!isSentryEnabled) return;
  captureEnabledLiveActivityIntentDiagnostic(diagnostic, Sentry.withScope, Sentry.captureMessage);
}

// The global-scope tag keys written on connect, cleared together on disconnect
// so a non-BLE error firing afterwards can't carry stale BLE tags.
const BLE_DIAGNOSTIC_TAG_KEYS = [
  'ble_chosen_write_type',
  'ble_supports_without_response',
  'ble_char_properties',
  'ble_max_with_response',
  'ble_max_without_response',
] as const;

export type BleConnectionDiagnostics = {
  characteristicProperties?: number;
  supportsWriteWithoutResponse?: boolean;
  // Mirrors NativeBleConnectedDevice.chosenWriteType so a new write-type string
  // is caught at this boundary rather than silently widened.
  chosenWriteType?: 'withoutResponse' | 'withResponse';
  maxWriteWithResponse?: number;
  maxWriteWithoutResponse?: number;
};

// A scope whose tags accept `undefined` (the clear value) — wider than
// SentryScopeLike, which only models the set path. Structural so the mapping is
// unit-testable with a plain fake, like applyErrorContextToScope. Shared by the
// BLE-diagnostics and OTA tag mappers below.
type TagScope = { setTag: (key: string, value: string | number | boolean | undefined) => void };

/**
 * Pure mapping of BLE diagnostics onto a scope's tags. `null` diagnostics =
 * clear: every BLE key is set to `undefined`, which drops it from serialized
 * events (this SDK's Scope exposes no `removeTag`; `setTag(key, undefined)` is
 * the supported clear). Extracted (no enablement gate, no SDK) so the set/clear
 * + boolean-stringify behaviour is directly unit-testable.
 */
export function applyBleDiagnosticsToScope(scope: TagScope, diagnostics: BleConnectionDiagnostics | null): void {
  if (!diagnostics) {
    for (const key of BLE_DIAGNOSTIC_TAG_KEYS) scope.setTag(key, undefined);
    return;
  }
  if (diagnostics.chosenWriteType !== undefined) scope.setTag('ble_chosen_write_type', diagnostics.chosenWriteType);
  // Sentry stores/queries tag values as strings; stringify the boolean so a
  // filter reads `true`/`false` rather than a coerced primitive.
  if (diagnostics.supportsWriteWithoutResponse !== undefined) {
    scope.setTag('ble_supports_without_response', String(diagnostics.supportsWriteWithoutResponse));
  }
  if (diagnostics.characteristicProperties !== undefined) {
    scope.setTag('ble_char_properties', diagnostics.characteristicProperties);
  }
  if (diagnostics.maxWriteWithResponse !== undefined) {
    scope.setTag('ble_max_with_response', diagnostics.maxWriteWithResponse);
  }
  if (diagnostics.maxWriteWithoutResponse !== undefined) {
    scope.setTag('ble_max_without_response', diagnostics.maxWriteWithoutResponse);
  }
}

// Adapts the top-level functional API to a TagScope. `Sentry.setTag` accepts
// `undefined` (Primitive), so it carries the clear path too. Shared by the BLE
// and OTA global-tag setters.
const tagScope: TagScope = { setTag: (key, value) => Sentry.setTag(key, value) };

/**
 * BLE write diagnostics captured at connect, kept as GLOBAL scope tags (not the
 * per-event `withScope` tags) so they ride later `ble-send` error reports —
 * which is the point: a `write_timeout`/`write_recovery_failed` report can then
 * show whether the board advertised write-without-response and which write type
 * was chosen. Cleared on disconnect via clearBleDiagnosticsTags. Passing
 * null/undefined diagnostics clears too — so the adopt path (which resolves to
 * null on a binary that can't report them) drops any stale tags rather than
 * leaving the previous connection's behind. No-op when Sentry is disabled.
 */
export function setBleDiagnosticsTags(diagnostics: BleConnectionDiagnostics | null | undefined): void {
  if (!isSentryEnabled) return;
  applyBleDiagnosticsToScope(tagScope, diagnostics ?? null);
}

/**
 * Drop the global BLE diagnostic tags set on connect, so a non-BLE error firing
 * after a board drop doesn't carry stale `ble_*` tags from the previous link.
 */
export function clearBleDiagnosticsTags(): void {
  if (!isSentryEnabled) return;
  applyBleDiagnosticsToScope(tagScope, null);
}

export type OtaTagFields = {
  // Updates.channel is string | null (null on embedded / dev-server launches).
  channel?: string | null;
  branch?: string | null;
  updateId?: string | null;
  runtimeVersion?: string | null;
  isEmbeddedLaunch?: boolean;
};

/**
 * Pure mapping of OTA bundle fields onto a scope's tags. A null/undefined/empty
 * field is cleared (setTag(key, undefined)) rather than written as the string
 * "null" or a blank value, matching applyBleDiagnosticsToScope: only real values
 * become filterable tags, so an embedded / dev-server launch (channel === null)
 * leaves no noise. The string fields use `|| undefined` so an empty string is
 * treated as absent too. The boolean is stringified so a Sentry filter reads
 * `true`/`false`. Extracted (no enablement gate, no SDK) so the coercion is
 * directly unit-testable.
 */
export function applyOtaTagsToScope(scope: TagScope, fields: OtaTagFields): void {
  scope.setTag('ota_channel', fields.channel || undefined);
  scope.setTag('ota_branch', fields.branch || undefined);
  scope.setTag('ota_update_id', fields.updateId || undefined);
  scope.setTag('ota_runtime_version', fields.runtimeVersion || undefined);
  scope.setTag('ota_is_embedded', fields.isEmbeddedLaunch === undefined ? undefined : String(fields.isEmbeddedLaunch));
}

/**
 * Stamp the running OTA bundle's channel + identifiers as GLOBAL scope tags so
 * they ride every later event, including native crashes. Called once per launch
 * from OtaUpdateTracker. No-op when Sentry is disabled. Takes the fields IN so
 * this module never imports expo-updates (which is unstubbed under vitest and
 * would break the sentry suite).
 */
export function setOtaSentryTags(fields: OtaTagFields): void {
  if (!isSentryEnabled) return;
  applyOtaTagsToScope(tagScope, fields);
}

/** Best-effort flush so a report survives a later hard crash. */
export function flushSentry(): Promise<boolean> {
  return isSentryEnabled ? Sentry.flush() : Promise.resolve(true);
}

/**
 * Force a native crash to verify the native crash handler on a real binary — the
 * event is persisted across the crash and uploaded on the next launch. No-op
 * when Sentry is disabled so it can never hard-crash a dev / no-DSN build. Wired
 * behind the tester-only Sentry diagnostics screen; not for regular app paths.
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
