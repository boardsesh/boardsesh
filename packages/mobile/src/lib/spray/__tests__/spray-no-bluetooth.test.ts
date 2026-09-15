// No Bluetooth prompt, device picker or LED control anywhere on a wall.
//
// That is an acceptance criterion of SW-11 (#5444) rather than a new mechanism:
// a wall is created with `user_boards.has_leds = false` (the backend's
// `createSprayWall` hard-codes it, and its input schema has no `hasLeds` key at
// all), which routes every board-control surface down the LED-less path that
// #4585 already shipped. These tests pin the two facts that path depends on, so
// a change to either fails here rather than on a photograph of someone's garage.

import { describe, expect, it } from 'vitest';
import { getBoardCapabilities } from '@boardsesh/board-config';
import { derivePlayDrawerLightbulbPressAction } from '../../../components/play-drawer/lightbulb-control';

describe('a spray wall never offers Bluetooth', () => {
  // `nativeBoardControl` is what gates the native BLE adapter and the Live
  // Activity's board-control affordances. A wall has no radio, no firmware and
  // nothing to encode.
  it('declares no native board control', () => {
    expect(getBoardCapabilities('spray').nativeBoardControl).toBe(false);
  });

  const ledlessBulb = {
    hasBluetooth: true,
    isBluetoothConnected: false,
    isBluetoothLoading: false,
    ledless: true,
    wallHeld: false,
    holderIsAuthoritative: false,
    canRelay: false,
  };

  // The bulb is the one control that survives on a wall, and it means "I'm on the
  // wall" rather than "connect". `connect` is what opens the scan and the device
  // picker, so this is the assertion that keeps both off a wall.
  it('turns the bulb into taking the wall, never a connect', () => {
    expect(derivePlayDrawerLightbulbPressAction(ledlessBulb)).toBe('takeWall');
  });

  it('releases the wall rather than disconnecting a radio', () => {
    expect(derivePlayDrawerLightbulbPressAction({ ...ledlessBulb, wallHeld: true })).toBe('releaseWall');
  });

  // The same inputs on a board WITH lights do open a scan — which is what makes
  // the assertion above about `ledless` and not about the other six fields.
  it('still offers a connect on a board with a light kit', () => {
    expect(derivePlayDrawerLightbulbPressAction({ ...ledlessBulb, ledless: false })).toBe('connect');
  });
});
