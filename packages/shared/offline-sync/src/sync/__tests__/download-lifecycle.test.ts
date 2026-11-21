import { describe, expect, it, vi } from 'vitest';
import { createScopeDownloadLifecycle } from '../download-lifecycle';

const scopeKey = 'kilter:1:10';
const context = { requestId: 'request-one', attemptId: 'attempt-one' };

describe('scope download lifecycle', () => {
  it('shares one attempt across bootstrap and paging, completing after fallback', () => {
    const report = vi.fn();
    const lifecycle = createScopeDownloadLifecycle(new Map([[scopeKey, context]]), report);
    lifecycle.start(scopeKey);
    lifecycle.defer(scopeKey, 'http-range', 'download');
    lifecycle.start(scopeKey);
    lifecycle.complete(scopeKey, 'download');
    lifecycle.close('cycle-interrupted');
    expect(report.mock.calls.map(([event]) => event.state)).toEqual(['started', 'deferred', 'completed']);
    expect(report.mock.calls.every(([event]) => event.context === context)).toBe(true);
  });

  it('allows cached completion with no Started', () => {
    const report = vi.fn();
    const lifecycle = createScopeDownloadLifecycle(new Map([[scopeKey, context]]), report);
    lifecycle.complete(scopeKey, 'cached');
    lifecycle.complete(scopeKey, 'cached');
    lifecycle.start(scopeKey);
    lifecycle.close('background');
    expect(report).toHaveBeenCalledExactlyOnceWith({
      scopeKey,
      context,
      state: 'completed',
      completionSource: 'cached',
    });
  });

  it('pauses only attempts whose work actually stopped', () => {
    const report = vi.fn();
    const lifecycle = createScopeDownloadLifecycle(
      new Map([
        [scopeKey, context],
        ['tension:2:10', context],
      ]),
      report,
    );
    lifecycle.start(scopeKey);
    expect(report).toHaveBeenCalledTimes(1);
    lifecycle.close('background');
    expect(report).toHaveBeenCalledWith({ scopeKey, context, state: 'paused', reason: 'background', stage: undefined });
    expect(report).toHaveBeenLastCalledWith({
      scopeKey: 'tension:2:10',
      context,
      state: 'deferred',
      reason: 'background',
      stage: 'preparation',
    });
    expect(report).toHaveBeenCalledTimes(3);
  });

  it('preserves the observed failure without inventing a terminal request failure', () => {
    const report = vi.fn();
    const lifecycle = createScopeDownloadLifecycle(new Map([[scopeKey, context]]), report);
    lifecycle.start(scopeKey);
    lifecycle.defer(scopeKey, 'database-locked', 'import');
    lifecycle.close('cycle-interrupted');
    expect(report).toHaveBeenLastCalledWith({
      scopeKey,
      context,
      state: 'deferred',
      reason: 'database-locked',
      stage: 'import',
    });
    expect(report.mock.calls.some(([event]) => event.state === 'failed')).toBe(false);
  });

  it('cannot fail sync when a consumer throws', () => {
    const report = vi.fn(() => {
      throw new Error('analytics unavailable');
    });
    const lifecycle = createScopeDownloadLifecycle(new Map([[scopeKey, context]]), report);
    expect(() => {
      lifecycle.start(scopeKey);
      lifecycle.defer(scopeKey, 'network');
      lifecycle.complete(scopeKey, 'download');
      lifecycle.close('offline');
    }).not.toThrow();
  });

  it('does not turn a recorded HTTP failure into an expected background pause', () => {
    const report = vi.fn();
    const lifecycle = createScopeDownloadLifecycle(new Map([[scopeKey, context]]), report);
    lifecycle.start(scopeKey);
    lifecycle.defer(scopeKey, 'http-range', 'download');
    lifecycle.close('background');
    expect(report).toHaveBeenLastCalledWith({
      scopeKey,
      context,
      state: 'deferred',
      reason: 'http-range',
      stage: 'download',
    });
  });
});
