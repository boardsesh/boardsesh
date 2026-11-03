import { describe, expect, it } from 'vitest';
import { blePickerSessionProps, type BlePickerSessionInput } from '../ble-picker-events';
import * as analytics from '../index';

describe('blePickerSessionProps', () => {
  const session: BlePickerSessionInput = {
    targetFiltered: true,
    searchedAnyBoard: false,
    listedCount: 1,
    targetNotListedSeen: false,
    tipsSeen: false,
    tipsSeenAt: null,
    browsedForNow: false,
    openedAt: 10_000,
    closedAt: 22_400,
    phoneNeverConnected: true,
    entrySurface: 'play_drawer',
  };

  it('carries the session as it was, with its length in whole seconds', () => {
    expect(blePickerSessionProps(session)).toEqual({
      targetFiltered: true,
      searchedAnyBoard: false,
      listedCount: 1,
      targetNotListedSeen: false,
      tipsSeen: false,
      tipsShownAtMs: null,
      browsedForNow: false,
      secondsOpen: 12,
      phoneNeverConnected: true,
      entrySurface: 'play_drawer',
    });
  });

  it('never reports a negative length or count (a clock step, a bad tally)', () => {
    const props = blePickerSessionProps({ ...session, closedAt: 9_000, listedCount: -2 });
    expect(props.secondsOpen).toBe(0);
    expect(props.listedCount).toBe(0);
  });

  it('says how long into the list the tips showed, and that the climber browsed on', () => {
    const props = blePickerSessionProps({ ...session, tipsSeen: true, tipsSeenAt: 15_000, browsedForNow: true });
    expect(props.tipsShownAtMs).toBe(5_000);
    expect(props.browsedForNow).toBe(true);
  });

  it('reads tips that showed in the commit before the list opened as 0, never negative', () => {
    const props = blePickerSessionProps({ ...session, tipsSeen: true, tipsSeenAt: 9_999 });
    expect(props.tipsShownAtMs).toBe(0);
  });

  it('keeps an unknown phone history and a picker with no tap before it as null', () => {
    const props = blePickerSessionProps({ ...session, phoneNeverConnected: null, entrySurface: null });
    expect(props.phoneNeverConnected).toBeNull();
    expect(props.entrySurface).toBeNull();
  });

  it('names no field the resolution stats already send', () => {
    // #7202 sends targetMatchedDevices / targetUnknownDevices / targetOtherDevices.
    const keys = Object.keys(blePickerSessionProps(session));
    for (const taken of ['devicesTotal', 'targetMatchedDevices', 'targetUnknownDevices', 'targetOtherDevices']) {
      expect(keys).not.toContain(taken);
    }
  });

  it('is exported from the package index', () => {
    expect(analytics.blePickerSessionProps).toBe(blePickerSessionProps);
  });
});
