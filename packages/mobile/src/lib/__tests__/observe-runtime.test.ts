import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureToObserve, configureObserve, resetObserveRuntimeForTests, setObserveRuntime } from '../observe-runtime';

afterEach(() => {
  resetObserveRuntimeForTests();
});

describe('observe-runtime slot', () => {
  it('is a no-op before the SDK registers', () => {
    // The normal state under test and on Expo web. Must not throw, because
    // error-reporting calls straight through it.
    expect(() => captureToObserve(new Error('boom'))).not.toThrow();
    expect(() => configureObserve({ sampleRate: 0.5 })).not.toThrow();
  });

  it('forwards to the registered runtime', () => {
    const reportError = vi.fn();
    const configure = vi.fn();
    setObserveRuntime({ configure, reportError });

    const error = new Error('boom');
    captureToObserve(error);
    configureObserve({ sampleRate: 0.25 });

    expect(reportError).toHaveBeenCalledWith(error);
    expect(configure).toHaveBeenCalledWith({ sampleRate: 0.25 });
  });

  it('swallows a throwing reporter', () => {
    // This runs inside the error-reporting funnel, so a throw here would take
    // out the Sentry report that follows it — telemetry must never be able to
    // lose the actual error.
    setObserveRuntime({
      configure: vi.fn(),
      reportError: () => {
        throw new Error('native module exploded');
      },
    });

    expect(() => captureToObserve(new Error('boom'))).not.toThrow();
  });

  it('swallows a throwing configure', () => {
    setObserveRuntime({
      configure: () => {
        throw new Error('bad config');
      },
      reportError: vi.fn(),
    });

    expect(() => configureObserve({ sampleRate: 2 })).not.toThrow();
  });

  it('stops forwarding once unregistered', () => {
    const reportError = vi.fn();
    setObserveRuntime({ configure: vi.fn(), reportError });
    setObserveRuntime(null);

    captureToObserve(new Error('boom'));
    expect(reportError).not.toHaveBeenCalled();
  });
});
