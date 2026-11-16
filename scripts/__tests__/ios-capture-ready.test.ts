import { describe, expect, it, vi } from 'vitest';
import { waitForIosCaptureReady } from '../lib/ios-capture-ready';

describe('bounded iOS capture launch recovery', () => {
  it('does not relaunch an application that is ready', () => {
    const relaunch = vi.fn();
    const beforeRetry = vi.fn();
    expect(waitForIosCaptureReady({ waitReady: () => true, relaunch, beforeRetry })).toBe(true);
    expect(relaunch).not.toHaveBeenCalled();
    expect(beforeRetry).not.toHaveBeenCalled();
  });
  it('keeps each failed launch evidence before relaunching and checks readiness again', () => {
    const events: string[] = [];
    let checks = 0;
    expect(
      waitForIosCaptureReady({
        waitReady: () => {
          events.push('wait');
          return ++checks === 3;
        },
        beforeRetry: (attempt) => {
          events.push(`preserve-${attempt}`);
        },
        relaunch: (attempt) => {
          events.push(`launch-${attempt}`);
        },
      }),
    ).toBe(true);
    expect(events).toEqual(['wait', 'preserve-1', 'launch-1', 'wait', 'preserve-2', 'launch-2', 'wait']);
  });
  it('fails after three relaunches instead of accepting launch success as readiness', () => {
    const waitReady = vi.fn(() => false);
    const relaunch = vi.fn();
    const beforeRetry = vi.fn();
    expect(waitForIosCaptureReady({ waitReady, relaunch, beforeRetry })).toBe(false);
    expect(waitReady).toHaveBeenCalledTimes(4);
    expect(relaunch).toHaveBeenCalledTimes(3);
    expect(beforeRetry).toHaveBeenCalledTimes(3);
  });
});
