import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installGlobalErrorCapture,
  resetGlobalErrorCaptureForTests,
  type GlobalErrorCaptureDeps,
} from '../global-error-capture';

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

function installFakeErrorUtils() {
  let handler: GlobalErrorHandler = () => {};
  const previousHandler = vi.fn<GlobalErrorHandler>();
  handler = previousHandler;
  const errorUtils = {
    getGlobalHandler: () => handler,
    setGlobalHandler: (next: GlobalErrorHandler) => {
      handler = next;
    },
  };
  (globalThis as { ErrorUtils?: typeof errorUtils }).ErrorUtils = errorUtils;
  // Return the dispatcher (the handler our code installs) lazily.
  return {
    previousHandler,
    dispatch: (error: unknown, isFatal?: boolean) => handler(error, isFatal),
  };
}

describe('installGlobalErrorCapture', () => {
  let report: ReturnType<typeof vi.fn<GlobalErrorCaptureDeps['report']>>;
  let flush: ReturnType<typeof vi.fn<NonNullable<GlobalErrorCaptureDeps['flush']>>>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetGlobalErrorCaptureForTests();
    report = vi.fn<GlobalErrorCaptureDeps['report']>();
    flush = vi.fn<NonNullable<GlobalErrorCaptureDeps['flush']>>(() => Promise.resolve(true));
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    delete (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
  });

  it('recovers from a worklet-serialization fatal instead of re-throwing it', () => {
    const { previousHandler, dispatch } = installFakeErrorUtils();
    installGlobalErrorCapture({ report, flush, isDev: false });

    const error = new Error('Trying to access property `foo` of an object which cannot be sent to the UI runtime');
    dispatch(error, true);

    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0][1]).toMatchObject({ tags: { kind: 'worklet-serialization' } });
    expect(flush).toHaveBeenCalledOnce();
    // The whole point: the original (fatal) handler is NOT invoked, so RN doesn't abort.
    expect(previousHandler).not.toHaveBeenCalled();
  });

  it('matches serialization failures by stack when the message is generic', () => {
    const { previousHandler, dispatch } = installFakeErrorUtils();
    installGlobalErrorCapture({ report, flush, isDev: false });

    const error = new Error('Object could not be cloned');
    error.stack = 'Error\n  at makeShareableCloneRecursive (worklets.js:1:1)';
    dispatch(error, true);

    expect(report).toHaveBeenCalledOnce();
    expect(previousHandler).not.toHaveBeenCalled();
  });

  it('does not swallow a bare "UI thread" fatal without a serialization token', () => {
    const { previousHandler, dispatch } = installFakeErrorUtils();
    installGlobalErrorCapture({ report, flush, isDev: false });

    // A native threading error, not a worklet serialization failure.
    const error = new Error('Attempted to call a method on the UI thread from a background thread');
    dispatch(error, true);

    expect(previousHandler).toHaveBeenCalledWith(error, true);
    expect(report).not.toHaveBeenCalled();
  });

  it('swallows "UI runtime" only when paired with a serialization token', () => {
    const { previousHandler, dispatch } = installFakeErrorUtils();
    installGlobalErrorCapture({ report, flush, isDev: false });

    const error = new Error('Value passed to the UI runtime could not be serialized');
    dispatch(error, true);

    expect(report).toHaveBeenCalledOnce();
    expect(previousHandler).not.toHaveBeenCalled();
  });

  it('passes ordinary fatals through to the previous handler', () => {
    const { previousHandler, dispatch } = installFakeErrorUtils();
    installGlobalErrorCapture({ report, flush, isDev: false });

    const error = new Error('undefined is not a function');
    dispatch(error, true);

    expect(previousHandler).toHaveBeenCalledWith(error, true);
    // The previous handler captures it, so we don't double-report.
    expect(report).not.toHaveBeenCalled();
  });

  it('does not swallow in dev (keeps the red box)', () => {
    const { previousHandler, dispatch } = installFakeErrorUtils();
    installGlobalErrorCapture({ report, flush, isDev: true });

    const error = new Error('cannot be sent to the UI runtime');
    dispatch(error, true);

    expect(previousHandler).toHaveBeenCalledWith(error, true);
  });

  it('logs the full message and stack for every error', () => {
    const { dispatch } = installFakeErrorUtils();
    installGlobalErrorCapture({ report, flush, isDev: false });

    dispatch(new Error('boom'), false);

    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0][0])).toContain('boom');
  });

  it('no-ops when ErrorUtils is unavailable', () => {
    delete (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
    expect(() => installGlobalErrorCapture({ report, flush, isDev: false })).not.toThrow();
  });
});
