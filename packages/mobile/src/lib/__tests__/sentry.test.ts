import { describe, it, expect, vi } from 'vitest';
import type { ComponentType } from 'react';

// Spy on the SDK so we can assert the disabled-build contract. Under vitest
// `__DEV__` is true (vite.config define) and no DSN is set, so `isSentryEnabled`
// is false for the whole suite — exactly the dev / no-DSN / test build path,
// which must stay a silent no-op (never construct, send, or wrap). vi.mock takes
// precedence over the vite alias stub so we can assert the spies are untouched.
vi.mock('@sentry/react-native', () => ({
  init: vi.fn(),
  withScope: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn(() => Promise.resolve(true)),
  wrap: vi.fn((component: unknown) => component),
}));

import * as Sentry from '@sentry/react-native';
import {
  applyErrorContextToScope,
  captureToSentry,
  flushSentry,
  wrapWithSentry,
  isSentryEnabled,
  toSentryTag,
} from '../sentry';

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
