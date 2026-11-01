import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAllSettings, setSetting } from '../../../settings';

const drive = vi.hoisted(() => ({ phase: 'off' as 'off' | 'arming' | 'live', stopped: false }));
vi.mock('../../../providers/queue-provider', () => ({ useIsSharedSession: () => false }));
vi.mock('../drive-mode-store', () => ({
  getDriveMode: () => (drive.phase === 'off' ? null : { phase: drive.phase }),
  isDrivingStoppedForLink: () => drive.stopped,
  useDriveModePhase: () => drive.phase,
  useDrivingStoppedForLink: () => drive.stopped,
}));

import { readClimbChangeLights } from '../use-climb-change-lights';

beforeEach(() => {
  resetAllSettings();
  drive.phase = 'off';
  drive.stopped = false;
});

describe('the live preview-first lighting policy', () => {
  it('keeps taps and navigation in preview with untouched settings', () => {
    expect(readClimbChangeLights('tap', { inSharedSession: false })).toBe(false);
    expect(readClimbChangeLights('swipe', { inSharedSession: false })).toBe(false);
  });

  it('reads each saved opt-in independently when the selection happens', () => {
    setSetting('lightOnClimbTap', true);
    expect(readClimbChangeLights('tap', { inSharedSession: false })).toBe(true);
    expect(readClimbChangeLights('swipe', { inSharedSession: false })).toBe(false);
    setSetting('lightOnClimbTap', false);
    setSetting('lightOnSwipe', true);
    expect(readClimbChangeLights('tap', { inSharedSession: false })).toBe(false);
    expect(readClimbChangeLights('swipe', { inSharedSession: false })).toBe(true);
  });

  it('keeps opted-in selections private in a crew until Driver mode is live', () => {
    setSetting('lightOnClimbTap', true);
    expect(readClimbChangeLights('tap', { inSharedSession: true })).toBe(false);
    drive.phase = 'arming';
    expect(readClimbChangeLights('tap', { inSharedSession: true })).toBe(false);
    drive.phase = 'live';
    expect(readClimbChangeLights('tap', { inSharedSession: true })).toBe(true);
    expect(readClimbChangeLights('swipe', { inSharedSession: true })).toBe(true);
  });

  it('honors a stop on the current link even when both lighting settings are on', () => {
    setSetting('lightOnClimbTap', true);
    setSetting('lightOnSwipe', true);
    drive.stopped = true;
    expect(readClimbChangeLights('tap', { inSharedSession: false })).toBe(false);
    expect(readClimbChangeLights('swipe', { inSharedSession: false })).toBe(false);
  });
});
