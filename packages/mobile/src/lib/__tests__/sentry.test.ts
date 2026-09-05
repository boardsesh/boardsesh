import { describe, it, expect, vi } from 'vitest';
import type { ComponentType } from 'react';
import type { InterruptedLiveActivityIntentDiagnostic } from '../../../modules/live-activity/src/index';

// Spy on the SDK so we can assert the disabled-build contract. Under vitest
// `__DEV__` is true (vite.config define) and no DSN is set, so `isSentryEnabled`
// is false for the whole suite — exactly the dev / no-DSN / test build path,
// which must stay a silent no-op (never construct, send, or wrap). vi.mock takes
// precedence over the vite alias stub so we can assert the spies are untouched.
vi.mock('@sentry/react-native', () => ({
  init: vi.fn(),
  withScope: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(() => Promise.resolve(true)),
  close: vi.fn(() => Promise.resolve()),
  wrap: vi.fn((component: unknown) => component),
  setTag: vi.fn(),
}));

import * as Sentry from '@sentry/react-native';
import {
  applyBleDiagnosticsToScope,
  applyErrorContextToScope,
  applyLiveActivityIntentDiagnosticToScope,
  captureEnabledLiveActivityIntentDiagnostic,
  captureEnabledErrorToSentry,
  applyOtaTagsToScope,
  captureLiveActivityIntentDiagnostic,
  captureToSentry,
  flushSentry,
  isExpoUiSheetNoHandlerRejection,
  normalizeCapturedValueForSentry,
  setOtaSentryTags,
  wrapWithSentry,
  isSentryEnabled,
  toSentryTag,
  LIVE_ACTIVITY_INTENT_INTERRUPTED_FINGERPRINT,
  createSentryLifecycleController,
  initializeConfiguredSentryIfAllowed,
} from '../sentry';
import { setNetworkPolicy } from '../network-policy';

describe('isSentryEnabled', () => {
  it('is false in dev / test (no DSN + __DEV__)', () => {
    expect(isSentryEnabled).toBe(false);
  });
});

describe('captureToSentry (disabled build)', () => {
  it('is a no-op — never reaches the Sentry SDK', () => {
    captureToSentry(new Error('boom'), { level: 'error', tags: { source: 'react-query' } });
    expect(Sentry.withScope).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('Sentry network policy', () => {
  it.each(['local-catalog-only', 'account-offline'] as const)(
    'makes initialization and enabled error capture zero-call sinks in %s mode',
    (policy) => {
      const initialize = vi.fn();
      const withScope = vi.fn();
      const captureException = vi.fn();
      setNetworkPolicy(policy);

      expect(initializeConfiguredSentryIfAllowed(true, initialize)).toBe(false);
      captureEnabledErrorToSentry(new Error('blocked'), undefined, withScope, captureException);

      expect(initialize).not.toHaveBeenCalled();
      expect(withScope).not.toHaveBeenCalled();
      expect(captureException).not.toHaveBeenCalled();
      setNetworkPolicy('online');
    },
  );

  it('closes native reporting offline and reinitializes after close online', async () => {
    let allowed = true;
    let finishClose: (() => void) | undefined;
    const initialize = vi.fn();
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const lifecycle = createSentryLifecycleController({
      configured: true,
      isAllowed: () => allowed,
      initialize,
      close,
    });

    lifecycle.reconcile();
    expect(lifecycle.isActive()).toBe(true);
    expect(initialize).toHaveBeenCalledTimes(1);

    allowed = false;
    lifecycle.reconcile();
    expect(lifecycle.isActive()).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);

    allowed = true;
    lifecycle.reconcile();
    expect(initialize).toHaveBeenCalledTimes(1);
    finishClose?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(lifecycle.isActive()).toBe(true);
    expect(initialize).toHaveBeenCalledTimes(2);
  });
});

describe('Live Activity intent diagnostic reporting', () => {
  const diagnostic = {
    schemaVersion: 1 as const,
    runId: '30fe8dab-7c3f-4ed0-ae20-291a87390001',
    processId: 'b5a82684-6a2c-4bbb-a9cc-b7bfc1df0001',
    intentKind: 'nextClimb' as const,
    appVersion: '2.0.0',
    buildNumber: '481',
    startedAtMs: 1_000,
    updatedAtMs: 3_500,
    lastStage: 'bleStarted' as const,
    reactRootMounted: true,
  } satisfies InterruptedLiveActivityIntentDiagnostic;

  it('maps to info level, a fixed fingerprint, fixed tags, and generated-id extras', () => {
    const scope = {
      setLevel: vi.fn(),
      setFingerprint: vi.fn(),
      setTag: vi.fn(),
      setExtra: vi.fn(),
    };

    applyLiveActivityIntentDiagnosticToScope(scope, diagnostic);

    expect(scope.setLevel).toHaveBeenCalledWith('info');
    expect(scope.setFingerprint).toHaveBeenCalledWith([LIVE_ACTIVITY_INTENT_INTERRUPTED_FINGERPRINT]);
    expect(scope.setTag).toHaveBeenCalledWith('source', 'live-activity-intent-diagnostics');
    expect(scope.setTag).toHaveBeenCalledWith('intent_kind', 'nextClimb');
    expect(scope.setTag).toHaveBeenCalledWith('last_stage', 'bleStarted');
    expect(scope.setTag).toHaveBeenCalledWith('react_root_mounted', 'true');
    expect(scope.setTag).not.toHaveBeenCalledWith('completion_class', expect.anything());
    expect(scope.setExtra).toHaveBeenCalledWith('run_id', diagnostic.runId);
    expect(scope.setExtra).toHaveBeenCalledWith('process_id', diagnostic.processId);
    expect(scope.setExtra).toHaveBeenCalledWith('elapsed_ms', 2_500);
  });

  it('is a no-op in disabled builds and never masquerades as an exception', () => {
    captureLiveActivityIntentDiagnostic(diagnostic);
    expect(Sentry.withScope).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('captures an enabled diagnostic as an informational Sentry message', () => {
    const scope = {
      setLevel: vi.fn(),
      setFingerprint: vi.fn(),
      setTag: vi.fn(),
      setExtra: vi.fn(),
    };
    vi.mocked(Sentry.withScope).mockImplementation((callback) => callback(scope as never));

    captureEnabledLiveActivityIntentDiagnostic(diagnostic, Sentry.withScope, Sentry.captureMessage);

    expect(Sentry.withScope).toHaveBeenCalledTimes(1);
    expect(scope.setLevel).toHaveBeenCalledWith('info');
    expect(scope.setFingerprint).toHaveBeenCalledWith([LIVE_ACTIVITY_INTENT_INTERRUPTED_FINGERPRINT]);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'Live Activity intent did not complete before its process ended',
      'info',
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('wrapWithSentry (disabled build)', () => {
  it('returns the component unchanged without calling Sentry.wrap', () => {
    const Component: ComponentType = () => null;
    expect(wrapWithSentry(Component)).toBe(Component);
    expect(Sentry.wrap).not.toHaveBeenCalled();
  });
});

describe('flushSentry (disabled build)', () => {
  it('resolves true without flushing the SDK', async () => {
    await expect(flushSentry()).resolves.toBe(true);
    expect(Sentry.flush).not.toHaveBeenCalled();
  });
});

describe('OTA tag setters (disabled build)', () => {
  it('setOtaSentryTags is a no-op — never reaches Sentry.setTag', () => {
    setOtaSentryTags({
      channel: 'production',
      branch: 'pr-123',
      updateId: 'abc',
      runtimeVersion: 'fp',
      isEmbeddedLaunch: false,
    });
    expect(Sentry.setTag).not.toHaveBeenCalled();
  });
});

// toSentryTag runs purely (no SDK), so it's testable regardless of enablement —
// it guards the tag coercion that keeps triage data readable in Sentry.
describe('toSentryTag', () => {
  it('passes primitives through unchanged', () => {
    expect(toSentryTag('react-query')).toBe('react-query');
    expect(toSentryTag(404)).toBe(404);
    expect(toSentryTag(true)).toBe(true);
  });

  it('JSON-serializes objects and arrays instead of "[object Object]"', () => {
    expect(toSentryTag({ status: 500 })).toBe('{"status":500}');
    expect(toSentryTag([1, 2, 3])).toBe('[1,2,3]');
  });

  it('falls back to String() for values JSON cannot serialize (circular)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // The point is it returns a string and does not throw — exact text is the
    // String() fallback, not a crash.
    expect(typeof toSentryTag(circular)).toBe('string');
  });
});

// captureToSentry only runs the scope mapping when isSentryEnabled (false under
// vitest, since __DEV__ is frozen true), so the mapping is extracted into this
// pure function and exercised here with a fake scope — that's where a level /
// tag / extra bug would otherwise hide behind the enablement gate.
describe('applyErrorContextToScope', () => {
  function makeScope() {
    return { setLevel: vi.fn(), setTag: vi.fn(), setExtra: vi.fn() };
  }

  it('sets the level when one is provided', () => {
    const scope = makeScope();
    applyErrorContextToScope(scope, { level: 'warning' });
    expect(scope.setLevel).toHaveBeenCalledWith('warning');
  });

  it('sets each tag with its coerced value (objects → JSON, not "[object Object]")', () => {
    const scope = makeScope();
    applyErrorContextToScope(scope, { tags: { source: 'react-query', response: { status: 500 } } });
    expect(scope.setTag).toHaveBeenCalledWith('source', 'react-query');
    expect(scope.setTag).toHaveBeenCalledWith('response', '{"status":500}');
  });

  it('sets each extra verbatim (no coercion)', () => {
    const scope = makeScope();
    const payload = { board: 'kilter', angle: 40 };
    applyErrorContextToScope(scope, { extra: { payload } });
    expect(scope.setExtra).toHaveBeenCalledWith('payload', payload);
  });

  it('touches nothing when there is no context', () => {
    const scope = makeScope();
    applyErrorContextToScope(scope);
    expect(scope.setLevel).not.toHaveBeenCalled();
    expect(scope.setTag).not.toHaveBeenCalled();
    expect(scope.setExtra).not.toHaveBeenCalled();
  });
});

describe('applyBleDiagnosticsToScope', () => {
  function makeScope() {
    return { setTag: vi.fn() };
  }

  it('sets each provided tag and stringifies the boolean for filter-friendliness', () => {
    const scope = makeScope();
    applyBleDiagnosticsToScope(scope, {
      chosenWriteType: 'withoutResponse',
      supportsWriteWithoutResponse: false,
      characteristicProperties: 12,
      maxWriteWithResponse: 512,
      maxWriteWithoutResponse: 185,
    });
    expect(scope.setTag).toHaveBeenCalledWith('ble_chosen_write_type', 'withoutResponse');
    expect(scope.setTag).toHaveBeenCalledWith('ble_supports_without_response', 'false'); // string, not boolean
    expect(scope.setTag).toHaveBeenCalledWith('ble_char_properties', 12);
    expect(scope.setTag).toHaveBeenCalledWith('ble_max_with_response', 512);
    expect(scope.setTag).toHaveBeenCalledWith('ble_max_without_response', 185);
  });

  it('skips fields that are undefined', () => {
    const scope = makeScope();
    applyBleDiagnosticsToScope(scope, { chosenWriteType: 'withResponse' });
    expect(scope.setTag).toHaveBeenCalledTimes(1);
    expect(scope.setTag).toHaveBeenCalledWith('ble_chosen_write_type', 'withResponse');
  });

  it('clears every BLE tag (sets undefined) when given null', () => {
    const scope = makeScope();
    applyBleDiagnosticsToScope(scope, null);
    expect(scope.setTag).toHaveBeenCalledTimes(5);
    for (const key of [
      'ble_chosen_write_type',
      'ble_supports_without_response',
      'ble_char_properties',
      'ble_max_with_response',
      'ble_max_without_response',
    ]) {
      expect(scope.setTag).toHaveBeenCalledWith(key, undefined);
    }
  });
});

describe('applyOtaTagsToScope', () => {
  function makeScope() {
    return { setTag: vi.fn() };
  }

  it('sets each provided tag and stringifies the embedded boolean for filter-friendliness', () => {
    const scope = makeScope();
    applyOtaTagsToScope(scope, {
      channel: 'preview-2',
      branch: 'pr-123',
      updateId: 'abc-123',
      runtimeVersion: 'fp-9f',
      isEmbeddedLaunch: false,
    });
    expect(scope.setTag).toHaveBeenCalledWith('ota_channel', 'preview-2');
    expect(scope.setTag).toHaveBeenCalledWith('ota_branch', 'pr-123');
    expect(scope.setTag).toHaveBeenCalledWith('ota_update_id', 'abc-123');
    expect(scope.setTag).toHaveBeenCalledWith('ota_runtime_version', 'fp-9f');
    expect(scope.setTag).toHaveBeenCalledWith('ota_is_embedded', 'false'); // string, not boolean
  });

  it('clears null / undefined fields (undefined) instead of writing the string "null"', () => {
    const scope = makeScope();
    applyOtaTagsToScope(scope, { channel: null, updateId: undefined, runtimeVersion: 'fp-9f' });
    expect(scope.setTag).toHaveBeenCalledWith('ota_channel', undefined);
    expect(scope.setTag).toHaveBeenCalledWith('ota_branch', undefined);
    expect(scope.setTag).toHaveBeenCalledWith('ota_update_id', undefined);
    expect(scope.setTag).toHaveBeenCalledWith('ota_runtime_version', 'fp-9f');
    // isEmbeddedLaunch was omitted here too, so its tag clears alongside the others.
    expect(scope.setTag).toHaveBeenCalledWith('ota_is_embedded', undefined);
  });

  it('treats an empty-string channel as absent (clears rather than writing a blank tag)', () => {
    const scope = makeScope();
    applyOtaTagsToScope(scope, { channel: '', updateId: '', runtimeVersion: 'fp-9f' });
    expect(scope.setTag).toHaveBeenCalledWith('ota_channel', undefined);
    expect(scope.setTag).toHaveBeenCalledWith('ota_update_id', undefined);
    expect(scope.setTag).toHaveBeenCalledWith('ota_runtime_version', 'fp-9f');
  });

  it('distinguishes an omitted embedded flag (cleared) from an explicit false', () => {
    const omitted = makeScope();
    applyOtaTagsToScope(omitted, {});
    expect(omitted.setTag).toHaveBeenCalledWith('ota_is_embedded', undefined);

    const explicit = makeScope();
    applyOtaTagsToScope(explicit, { isEmbeddedLaunch: false });
    expect(explicit.setTag).toHaveBeenCalledWith('ota_is_embedded', 'false');
  });
});

// normalizeCapturedValueForSentry runs purely (no SDK), so it's directly
// testable regardless of enablement — it guards the #4241 fix: a raw
// WebSocket Event/CloseEvent must never reach Sentry.captureException as an
// opaque object that renders as `<unknown>` / `Event` / `anonymous`.
describe('normalizeCapturedValueForSentry', () => {
  it('passes a real Error through unchanged with no extra', () => {
    const original = new Error('socket boom');
    const result = normalizeCapturedValueForSentry(original);
    expect(result.error).toBe(original);
    expect(result.extra).toBeUndefined();
  });

  it('rewraps a CloseEvent-shaped object, surfaces code/reason/wasClean/readyState, and strips the query string from the target URL', () => {
    const result = normalizeCapturedValueForSentry({
      type: 'close',
      code: 1001,
      reason: 'Stream end encountered',
      wasClean: false,
      target: { readyState: 3, url: 'wss://api.example.com/graphql?token=SECRET' },
    });
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toContain('close');
    expect(result.error.message).toContain('1001');
    expect(result.extra).toEqual({
      type: 'close',
      code: 1001,
      reason: 'Stream end encountered',
      wasClean: false,
      readyState: 3,
      url: 'wss://api.example.com/graphql',
    });
  });

  it('rewraps a bare Event with no code/reason into just a type extra', () => {
    const result = normalizeCapturedValueForSentry({ type: 'error' });
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toContain('error');
    expect(result.extra).toEqual({ type: 'error' });
  });

  it('falls back to String(value) for a non-object, non-Error value', () => {
    const stringResult = normalizeCapturedValueForSentry('connection reset');
    expect(stringResult.error).toBeInstanceOf(Error);
    expect(stringResult.error.message).toBe('connection reset');
    expect(stringResult.extra).toBeUndefined();

    const numberResult = normalizeCapturedValueForSentry(42);
    expect(numberResult.error.message).toBe('42');
  });

  it('falls back to String(value) for a plain object with no `type` field', () => {
    const result = normalizeCapturedValueForSentry({ status: 500 });
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe('[object Object]');
    expect(result.extra).toBeUndefined();
  });

  it('drops a malformed target URL instead of throwing', () => {
    const result = normalizeCapturedValueForSentry({
      type: 'close',
      code: 1006,
      target: { readyState: 3, url: 'not a url' },
    });
    expect(result.extra).toEqual({ type: 'close', code: 1006, readyState: 3 });
  });
});

// The beforeSend drop only runs on real builds (isSentryEnabled), so the match logic
// lives in this pure predicate and is exercised here against the real captured event
// shape — that's where a too-broad or too-narrow filter would otherwise hide behind the
// enablement gate.
describe('isExpoUiSheetNoHandlerRejection', () => {
  it('drops the real two-value event (outer "has been rejected" + native cause)', () => {
    const event = {
      exception: {
        values: [
          { value: "Call to function 'ModalBottomSheetView.partialExpand' has been rejected." },
          { value: "No handler registered for AsyncFunction 'partialExpand' on view 'ModalBottomSheetView'" },
        ],
      },
    };
    expect(isExpoUiSheetNoHandlerRejection(event)).toBe(true);
  });

  it('drops when only the hint.originalException carries the signature', () => {
    const event = { exception: { values: [{ value: 'Unhandled promise rejection' }] } };
    const originalException = new Error("Call to function 'ModalBottomSheetView.partialExpand' has been rejected.");
    expect(isExpoUiSheetNoHandlerRejection(event, originalException)).toBe(true);
  });

  it('also drops the expand() variant (same mechanism)', () => {
    const event = {
      exception: {
        values: [{ value: "No handler registered for AsyncFunction 'expand' on view 'ModalBottomSheetView'" }],
      },
    };
    expect(isExpoUiSheetNoHandlerRejection(event)).toBe(true);
  });

  it('keeps an unrelated rejection', () => {
    const event = { exception: { values: [{ value: 'TypeError: undefined is not a function' }] } };
    expect(isExpoUiSheetNoHandlerRejection(event)).toBe(false);
  });

  it('keeps a no-handler error on a different native view', () => {
    const event = {
      exception: {
        values: [{ value: "No handler registered for AsyncFunction 'partialExpand' on view 'SomeOtherView'" }],
      },
    };
    expect(isExpoUiSheetNoHandlerRejection(event)).toBe(false);
  });

  it('keeps a message that merely mentions the word partialExpand (not the view + handler phrasing)', () => {
    const event = { exception: { values: [{ value: 'partialExpand is not a great API name' }] } };
    expect(isExpoUiSheetNoHandlerRejection(event)).toBe(false);
  });

  it('keeps events with no exception payload', () => {
    expect(isExpoUiSheetNoHandlerRejection({})).toBe(false);
    expect(isExpoUiSheetNoHandlerRejection({ exception: { values: [] } })).toBe(false);
    expect(isExpoUiSheetNoHandlerRejection({}, 'not an Error instance')).toBe(false);
  });
});
