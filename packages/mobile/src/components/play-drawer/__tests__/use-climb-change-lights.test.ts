// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { resetAllSettings, setSetting } from '../../../settings';

const drive = vi.hoisted(() => ({ phase: 'off' as 'off' | 'arming' | 'live', windowLapsed: false }));
vi.mock('../drive-mode-store', () => ({
  getDriveMode: () => (drive.phase === 'off' ? null : { phase: drive.phase }),
  // The store's at-pick read: a keep-lighting window past its end is no drive (#7038).
  drivingAtPick: (rendered: boolean) => rendered && !drive.windowLapsed,
  useDriveModePhase: () => drive.phase,
}));

import { isDrivingWall, useDrivingWall } from '../use-climb-change-lights';

beforeEach(() => {
  resetAllSettings();
  drive.phase = 'off';
  drive.windowLapsed = false;
});

// Preview-first: a change of climb lights the wall only while this phone
// drives it. Always drive the wall is a drive like any other, so no setting is
// read here.
describe('the live preview-first lighting policy', () => {
  it('keeps taps and navigation in preview outside a drive', () => {
    expect(isDrivingWall()).toBe(false);
    expect(renderHook(() => useDrivingWall()).result.current).toBe(false);
  });

  it('reads no setting: Always drive the wall on with no drive still previews', () => {
    setSetting('alwaysDrive', true);
    expect(isDrivingWall()).toBe(false);
    expect(renderHook(() => useDrivingWall()).result.current).toBe(false);
  });

  it('lights only once the drive is live', () => {
    drive.phase = 'arming';
    expect(isDrivingWall()).toBe(false);
    expect(renderHook(() => useDrivingWall()).result.current).toBe(false);
    drive.phase = 'live';
    expect(isDrivingWall()).toBe(true);
    expect(renderHook(() => useDrivingWall()).result.current).toBe(true);
  });

  it('reads a keep-lighting window past its end as no drive at the tap', () => {
    drive.phase = 'live';
    expect(isDrivingWall()).toBe(true);
    drive.windowLapsed = true;
    expect(isDrivingWall()).toBe(false);
  });
});
