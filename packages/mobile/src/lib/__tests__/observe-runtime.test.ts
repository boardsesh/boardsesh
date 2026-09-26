import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureToObserve,
  configureObserve,
  dispatchObserveEvents,
  resetObserveRuntimeForTests,
  setObserveRuntime,
} from '../observe-runtime';

afterEach(() => {
  resetObserveRuntimeForTests();
});

describe('observe-runtime slot', () => {
  it('is a no-op before the SDK registers', async () => {
    // The normal state under test and on Expo web. Must not throw, because
    // error-reporting calls straight through it.
    expect(() => captureToObserve(new Error('boom'))).not.toThrow();
    expect(() => configureObserve({ sampleRate: 0.5 })).not.toThrow();
    await expect(dispatchObserveEvents()).resolves.toBeUndefined();
  });

  it('forwards to the registered runtime', async () => {
    const reportError = vi.fn();
    const configure = vi.fn();
    const dispatchEvents = vi.fn(async () => undefined);
    setObserveRuntime({ configure, dispatchEvents, reportError });

    const error = new Error('boom');
    captureToObserve(error);
    configureObserve({ sampleRate: 0.25 });
    await dispatchObserveEvents();

    expect(reportError).toHaveBeenCalledWith(error);
    expect(configure).toHaveBeenCalledWith({ sampleRate: 0.25 });
    expect(dispatchEvents).toHaveBeenCalledOnce();
  });

  it('swallows a throwing reporter', () => {
    // This runs inside the error-reporting funnel, so a throw here would take
    // out the Sentry report that follows it — telemetry must never be able to
    // lose the actual error.
    setObserveRuntime({
      configure: vi.fn(),
      dispatchEvents: vi.fn(async () => undefined),
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
      dispatchEvents: vi.fn(async () => undefined),
      reportError: vi.fn(),
    });

    expect(() => configureObserve({ sampleRate: 2 })).not.toThrow();
  });

  it('swallows synchronous and asynchronous dispatch failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setObserveRuntime({
      configure: vi.fn(),
      dispatchEvents: () => {
        throw new Error('native module exploded');
      },
      reportError: vi.fn(),
    });
    await expect(dispatchObserveEvents()).resolves.toBeUndefined();

    setObserveRuntime({
      configure: vi.fn(),
      dispatchEvents: () => Promise.reject(new Error('network failed')),
      reportError: vi.fn(),
    });
    await expect(dispatchObserveEvents()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('[observe] event dispatch failed; will retry later', expect.any(Error));
  });

  it('stops forwarding once unregistered', async () => {
    const reportError = vi.fn();
    const dispatchEvents = vi.fn(async () => undefined);
    setObserveRuntime({ configure: vi.fn(), dispatchEvents, reportError });
    setObserveRuntime(null);

    captureToObserve(new Error('boom'));
    await dispatchObserveEvents();
    expect(reportError).not.toHaveBeenCalled();
    expect(dispatchEvents).not.toHaveBeenCalled();
  });
});
