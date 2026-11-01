import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleIdleTask } from '../schedule-idle-task';

let paintFrame: () => void;
let runIdle: () => void;
const cancelFrame = vi.fn();
const cancelIdle = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    paintFrame = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', cancelFrame);
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
    runIdle = callback;
    return 2;
  });
  vi.stubGlobal('cancelIdleCallback', cancelIdle);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('scheduleIdleTask', () => {
  it('leaves the first frame cheap and only runs when idle', () => {
    const callback = vi.fn();
    scheduleIdleTask(callback);
    expect(callback).not.toHaveBeenCalled();
    paintFrame();
    expect(callback).not.toHaveBeenCalled();
    runIdle();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('cancels before the frame without scheduling idle work', () => {
    const callback = vi.fn();
    const task = scheduleIdleTask(callback);
    task.cancel();
    paintFrame();
    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(callback).not.toHaveBeenCalled();
    expect(cancelIdle).not.toHaveBeenCalled();
  });

  it('cancels queued idle work and ignores an already dispatched callback', () => {
    const callback = vi.fn();
    const task = scheduleIdleTask(callback);
    paintFrame();
    task.cancel();
    runIdle();
    expect(cancelIdle).toHaveBeenCalledWith(2);
    expect(callback).not.toHaveBeenCalled();
  });

  it('defers through a cancellable timer on browsers without idle callbacks', () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    const callback = vi.fn();
    scheduleIdleTask(callback);
    paintFrame();
    expect(callback).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(callback).toHaveBeenCalledOnce();

    const cancelled = scheduleIdleTask(callback);
    paintFrame();
    cancelled.cancel();
    vi.runAllTimers();
    expect(callback).toHaveBeenCalledOnce();
  });
});
