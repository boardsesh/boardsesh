// Catches uncaught JS errors that React error boundaries can't — specifically
// the ones thrown on the JS thread during microtask draining (Promise
// continuations, Reanimated worklet creation). The BLE-connect crash is exactly
// this shape: react-native-worklets fails to serialize a value to the UI runtime
// (`extractSerializableOrThrow` inside `makeShareableCloneRecursive`), the throw
// is uncaught, and React Native escalates it to a fatal `RCTFatal` abort.
//
// We wrap the global handler to (1) always log the full message + stack so a
// TestFlight reproduction is diagnosable from Console.app even when production
// reporting is unavailable, and (2) recover from worklet-serialization fatals
// instead of aborting the whole app. A value that can't cross to the UI runtime
// should degrade the animation, not SIGABRT.

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

type ErrorUtilsLike = {
  getGlobalHandler: () => GlobalErrorHandler;
  setGlobalHandler: (handler: GlobalErrorHandler) => void;
};

export type GlobalErrorCaptureDeps = {
  /** Forward to production error reporting. No-op when reporting is disabled. */
  report: (error: Error, context: { level: 'fatal' | 'error'; tags: Record<string, string> }) => void;
  /** Best-effort flush so a report survives a later hard crash. */
  flush?: () => Promise<unknown>;
  /** In dev we keep the red box (don't swallow) — it's more useful than recovery. */
  isDev: boolean;
};

// Self-sufficient serialization signatures from react-native-worklets /
// Reanimated's clone path. The thrown message varies by version, so match
// generously across message + stack — but only on tokens specific to the
// serialization path.
const SERIALIZATION_SIGNATURE =
  /cannot be (sent|serialized|cloned|copied)|extractSerializable|makeShareable|makeSerializable|ValueUnpacker/i;

// "UI runtime"/"UI thread" shows up in unrelated native threading errors too, so
// it must NOT classify a fatal on its own — only when paired with a
// serialization token. (A bare "worklet" mention is likewise excluded: it would
// swallow unrelated crashes in *-worklet.ts files.)
const UI_RUNTIME_HINT = /UI (runtime|thread)/i;
const SERIALIZATION_HINT = /serializ|shareable|unpack|\bclone/i;

function isWorkletSerializationError(text: string): boolean {
  return SERIALIZATION_SIGNATURE.test(text) || (UI_RUNTIME_HINT.test(text) && SERIALIZATION_HINT.test(text));
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

let installed = false;

/**
 * Wrap the React Native global error handler. Idempotent and safe to call when
 * `ErrorUtils` is unavailable (e.g. under the test runner) — it no-ops.
 */
export function installGlobalErrorCapture(deps: GlobalErrorCaptureDeps): void {
  if (installed) return;
  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (!errorUtils) return;
  installed = true;

  const previousHandler = errorUtils.getGlobalHandler();
  // Guards against the reporting path itself throwing back into this handler.
  let reentrant = false;

  errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    const normalized = toError(error);
    const haystack = `${normalized.message ?? ''}\n${normalized.stack ?? ''}`;
    const isWorkletSerialization = isWorkletSerializationError(haystack);

    // Always surface the full error to the device log.
    console.error(
      `[global-error-capture] ${isFatal ? 'FATAL' : 'non-fatal'}` +
        `${isWorkletSerialization ? ' worklet-serialization' : ''}: ${normalized.message ?? ''}\n${normalized.stack ?? ''}`,
    );

    // Recover from worklet-serialization fatals rather than aborting the app.
    const shouldRecover = isWorkletSerialization && isFatal === true && !deps.isDev;

    if (shouldRecover && !reentrant) {
      reentrant = true;
      try {
        deps.report(normalized, {
          level: 'error',
          tags: { mechanism: 'global-error-capture', kind: 'worklet-serialization' },
        });
        // Swallow any flush rejection here: an unhandled rejection would loop
        // back through this same global handler as re-entrant noise.
        void deps.flush?.().catch(() => {});
      } catch {
        // Reporting must never become a secondary crash.
      } finally {
        reentrant = false;
      }
      return;
    }

    // Everything else falls through to the previous handler (PostHog's, then
    // RN's default), preserving normal fatal/red-box behaviour and capture.
    previousHandler(error, isFatal);
  });
}

/** Test-only: reset the install latch so each test starts clean. */
export function resetGlobalErrorCaptureForTests(): void {
  installed = false;
}
