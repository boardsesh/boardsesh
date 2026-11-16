import { describe, expect, it, vi } from 'vitest';
import { launchIosCaptureReady, waitForIosCaptureReady } from '../lib/ios-capture-ready';

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

describe('process-scoped iOS readiness', () => {
  it.each([false, true])('ignores late old-process readiness; fresh ping=%s', (freshPing) => {
    let markers = 0;
    let readyPings = 0;
    let contentLog = '';
    let launches = 0;
    let judgedContent = '';
    const result = launchIosCaptureReady({
      snapshot: () => ({ markers, readyPings, contentOffset: contentLog.length }),
      launch: () => {
        launches++;
        if (launches === 2 && freshPing) {
          markers++;
          readyPings++;
          contentLog += 'new-process-content\n';
        }
        return true;
      },
      terminate: () => {
        // The old app finishes loading while simctl terminate is still running.
        markers++;
        readyPings++;
        contentLog += 'old-process-content\n';
        return true;
      },
      waitReady: (baseline) => {
        judgedContent = contentLog.slice(baseline.contentOffset);
        return markers > baseline.markers || readyPings > baseline.readyPings;
      },
      beforeRetry: () => {},
    });
    expect(result).toBe(freshPing);
    expect(judgedContent).toBe(freshPing ? 'new-process-content\n' : '');
    expect(launches).toBe(freshPing ? 2 : 4);
  });

  it('does not accept readiness from a failed launch', () => {
    const waitReady = vi.fn(() => true);
    expect(
      launchIosCaptureReady({
        snapshot: () => 0,
        launch: () => false,
        terminate: () => true,
        waitReady,
        beforeRetry: () => {},
      }),
    ).toBe(false);
    expect(waitReady).not.toHaveBeenCalled();
  });

  it('does not snapshot or relaunch when termination fails', () => {
    const snapshot = vi.fn(() => 0);
    const launch = vi.fn(() => true);
    expect(
      launchIosCaptureReady({
        snapshot,
        launch,
        terminate: () => false,
        waitReady: () => false,
        beforeRetry: () => {},
      }),
    ).toBe(false);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
