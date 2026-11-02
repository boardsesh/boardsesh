// Disconnect Bluetooth when driving ends (2.7, replacing auto-disconnect): the
// ends that let go of the board, and the checks after a wait.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));

import { createBleWriteActivityStore } from '../../../lib/ble/write-activity-store';
import { enterDriveMode, resetDriveModeForTests, type DriveEnded, type DriveModeExitReason } from '../drive-mode-store';
import {
  DRIVE_END_WRITE_WAIT_MS,
  disconnectForDriveEnd,
  shouldDisconnectWhenDrivingEnds,
} from '../use-driving-ended-disconnect';

afterEach(() => {
  vi.useRealTimers();
  resetDriveModeForTests();
});

const ALL_REASONS: readonly DriveModeExitReason[] = [
  'stopped',
  'window_ended',
  'link_dropped',
  'connect_failed',
  'commit_failed',
  'arming_timed_out',
  'session_changed',
  'board_changed',
  'signed_out',
];

function ended(
  reason: DriveModeExitReason,
  disconnectAfter: DriveEnded['disconnectAfter'] = null,
  keepLink = false,
): DriveEnded {
  return { reason, drive: null, disconnectAfter, keepLink };
}

describe('shouldDisconnectWhenDrivingEnds', () => {
  it.each(ALL_REASONS)('%s', (reason) => {
    const climberOrClock = reason === 'stopped' || reason === 'window_ended';
    expect(shouldDisconnectWhenDrivingEnds({ reason, keepLink: false }, true)).toBe(climberOrClock);
    expect(shouldDisconnectWhenDrivingEnds({ reason, keepLink: false }, false)).toBe(false);
    // An end Settings › Board caused keeps the link, whatever its reason.
    expect(shouldDisconnectWhenDrivingEnds({ reason, keepLink: true }, true)).toBe(false);
  });
});

describe('disconnectForDriveEnd', () => {
  it('lets go at once, without forgetting the board', () => {
    const disconnect = vi.fn(async () => undefined);
    disconnectForDriveEnd({
      ended: ended('stopped'),
      enabled: true,
      readLink: () => ({ isConnected: true, disconnect }),
    });
    expect(disconnect).toHaveBeenCalledExactlyOnceWith('driving_ended');
  });

  it('lets go of nothing with no link, or with the setting off', () => {
    const disconnect = vi.fn(async () => undefined);
    disconnectForDriveEnd({
      ended: ended('stopped'),
      enabled: true,
      readLink: () => ({ isConnected: false, disconnect }),
    });
    disconnectForDriveEnd({ ended: ended('stopped'), enabled: true, readLink: () => null });
    disconnectForDriveEnd({
      ended: ended('stopped'),
      enabled: false,
      readLink: () => ({ isConnected: true, disconnect }),
    });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('waits for what is on its way to the wall, then reads the link again', async () => {
    const disconnect = vi.fn(async () => undefined);
    let finish: () => void = () => {};
    const after = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let link = { isConnected: true, disconnect };
    disconnectForDriveEnd({ ended: ended('window_ended', after), enabled: true, readLink: () => link });
    expect(after).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(disconnect).not.toHaveBeenCalled();
    // The link dropped on its own meanwhile: nothing left to let go.
    link = { isConnected: false, disconnect };
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('lets go after a wait that failed too', async () => {
    const disconnect = vi.fn(async () => undefined);
    disconnectForDriveEnd({
      ended: ended('stopped', () => Promise.reject(new Error('write failed'))),
      enabled: true,
      readLink: () => ({ isConnected: true, disconnect }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(disconnect).toHaveBeenCalledExactlyOnceWith('driving_ended');
  });

  it('keeps the board a new drive took during the wait, and never asks to wait when it would not let go', async () => {
    const disconnect = vi.fn(async () => undefined);
    let finish: () => void = () => {};
    disconnectForDriveEnd({
      ended: ended(
        'window_ended',
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
      enabled: true,
      readLink: () => ({ isConnected: true, disconnect }),
    });
    enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: null });
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(disconnect).not.toHaveBeenCalled();
    const after = vi.fn(async () => undefined);
    disconnectForDriveEnd({ ended: ended('link_dropped', after), enabled: true, readLink: () => null });
    expect(after).not.toHaveBeenCalled();
  });

  // A climb picked in the drive's last moments is still being written when the
  // clock ends it: the link goes once that write lands, so the climb lights.
  it('waits for a write in flight before letting go, then lets go at once', () => {
    vi.useFakeTimers();
    const writeActivity = createBleWriteActivityStore();
    const release = writeActivity.begin();
    const disconnect = vi.fn(async () => undefined);
    disconnectForDriveEnd({
      ended: ended('window_ended'),
      enabled: true,
      readLink: () => ({ isConnected: true, disconnect }),
      writeActivity,
    });
    expect(disconnect).not.toHaveBeenCalled();
    release();
    expect(disconnect).toHaveBeenCalledExactlyOnceWith('driving_ended');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets go anyway once a write in flight takes longer than the wait', () => {
    vi.useFakeTimers();
    const writeActivity = createBleWriteActivityStore();
    writeActivity.begin();
    const disconnect = vi.fn(async () => undefined);
    disconnectForDriveEnd({
      ended: ended('stopped'),
      enabled: true,
      readLink: () => ({ isConnected: true, disconnect }),
      writeActivity,
    });
    vi.advanceTimersByTime(DRIVE_END_WRITE_WAIT_MS - 1);
    expect(disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(disconnect).toHaveBeenCalledExactlyOnceWith('driving_ended');
  });

  it('lets go at once with no write in flight, and keeps the link on an end Settings caused', () => {
    const writeActivity = createBleWriteActivityStore();
    const disconnect = vi.fn(async () => undefined);
    disconnectForDriveEnd({
      ended: ended('window_ended', null, true),
      enabled: true,
      readLink: () => ({ isConnected: true, disconnect }),
      writeActivity,
    });
    expect(disconnect).not.toHaveBeenCalled();
    disconnectForDriveEnd({
      ended: ended('window_ended'),
      enabled: true,
      readLink: () => ({ isConnected: true, disconnect }),
      writeActivity,
    });
    expect(disconnect).toHaveBeenCalledExactlyOnceWith('driving_ended');
  });
});
