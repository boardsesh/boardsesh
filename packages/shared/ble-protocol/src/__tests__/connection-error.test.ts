// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, it, expect } from 'vitest';
import {
  blePlxErrorCodes,
  classifyBleFailure,
  classifyBleFailureReason,
  isBleWriteRecoveryFailedError,
  isBleWriteTimeoutError,
  isDisconnectionError,
  type BleFailureCategory,
  type BleSendFailureReason,
} from '../connection-error';

const WRITE_RECOVERY_FAILED_MESSAGE =
  'BLE write failed; board stopped accepting data and recovery attempts were exhausted';

// Mimics a react-native-ble-plx BleError: an Error subclass whose `name` is
// 'BleError' (so the predicate classifies from the message, not the name).
function bleError(message: string): Error {
  const error = new Error(message);
  error.name = 'BleError';
  return error;
}

// Mimics a react-native-ble-plx BleError that also carries a numeric BleErrorCode
// (and, optionally, the low-level platform codes) — the shape the connect path
// receives from `connectToDevice()`. The classifier prefers the code over the
// message on these.
function bleErrorWithCode(
  errorCode: number,
  message: string,
  extra?: { androidErrorCode?: number; iosErrorCode?: number },
): Error {
  const error = new Error(message) as Error & {
    errorCode: number;
    androidErrorCode?: number;
    iosErrorCode?: number;
  };
  error.name = 'BleError';
  error.errorCode = errorCode;
  if (extra?.androidErrorCode !== undefined) error.androidErrorCode = extra.androidErrorCode;
  if (extra?.iosErrorCode !== undefined) error.iosErrorCode = extra.iosErrorCode;
  return error;
}

describe('classifyBleFailure', () => {
  const cases: Array<{ name: string; error: unknown; stage?: string; expected: BleFailureCategory }> = [
    // user cancelled
    {
      name: 'DOMException NotFoundError',
      error: new DOMException('No device chosen', 'NotFoundError'),
      expected: 'user_cancelled',
    },
    {
      name: 'Device selection cancelled (capacitor picker)',
      error: new Error('Device selection cancelled'),
      expected: 'user_cancelled',
    },
    {
      name: 'generic user cancel message',
      error: new Error('The user cancelled the request'),
      expected: 'user_cancelled',
    },

    // board not found — the exact strings both adapters throw on scan timeout
    {
      name: 'capacitor/native scan timeout',
      error: new Error('Target board not found during scan'),
      expected: 'board_not_found',
    },
    {
      name: 'native swift device-not-found',
      error: new Error('Bluetooth device was not found'),
      expected: 'board_not_found',
    },
    {
      name: 'native RN scan-timeout (no boards advertised)',
      error: new Error('No boards found within scan window'),
      expected: 'board_not_found',
    },

    // service missing — native swift error descriptions
    { name: 'swift UART service missing', error: new Error('UART service was not found'), expected: 'service_missing' },
    {
      name: 'write characteristic missing',
      error: new Error('Write characteristic was not found'),
      expected: 'service_missing',
    },
    {
      name: 'web adapter UART characteristic',
      error: new Error('Failed to get UART characteristic'),
      expected: 'service_missing',
    },

    // connect failed
    { name: 'swift connect timeout', error: new Error('Bluetooth connection timed out'), expected: 'connect_failed' },
    { name: 'gatt error message', error: new Error('GATT operation failed'), expected: 'connect_failed' },
    { name: 'failed to connect', error: new Error('failed to connect to peripheral'), expected: 'connect_failed' },
    // stage fallback: a bare message but the stage tells us it was the connect step
    {
      name: 'gatt_connect stage fallback',
      error: new Error('something opaque'),
      stage: 'gatt_connect',
      expected: 'connect_failed',
    },

    // unavailable
    {
      name: 'bluetooth not available',
      error: new Error('Bluetooth is not available on this device'),
      expected: 'unavailable',
    },
    { name: 'powered off', error: new Error('Bluetooth poweredOff'), expected: 'unavailable' },

    // unknown
    { name: 'opaque error, no stage', error: new Error('something opaque'), expected: 'unknown' },
    { name: 'non-error value', error: 'a plain string', expected: 'unknown' },
    // A real failure that merely contains the word "cancel" must NOT be treated
    // as a user cancel (which would be silent) — it should surface.
    { name: 'CoreBluetooth operation cancelled', error: new Error('The operation was cancelled'), expected: 'unknown' },
    { name: 'connection cancelled by peer', error: new Error('Connection cancelled by peer'), expected: 'unknown' },
  ];

  for (const { name, error, stage, expected } of cases) {
    it(`classifies: ${name} -> ${expected}`, () => {
      expect(classifyBleFailure(error, stage)).toBe(expected);
    });
  }

  it('user_cancelled wins even when the stage is gatt_connect', () => {
    // A cancel can surface after the stage was advanced; the cancel signal must win.
    expect(classifyBleFailure(new Error('Device selection cancelled'), 'gatt_connect')).toBe('user_cancelled');
  });
});

describe('isDisconnectionError', () => {
  const disconnects: Array<{ name: string; error: unknown }> = [
    {
      name: 'web NetworkError (GATT disconnected)',
      error: new DOMException('GATT Server is disconnected.', 'NetworkError'),
    },
    {
      name: 'web InvalidStateError (dead handle)',
      error: new DOMException('GATT operation failed', 'InvalidStateError'),
    },
    { name: 'capacitor/native "Not connected"', error: new Error('Not connected') },
    { name: 'adapter "Device disconnected during write"', error: new Error('Device disconnected during write') },
    { name: 'plugin peripheral disconnected', error: new Error('The peripheral disconnected unexpectedly') },
    { name: 'generic gatt-not-connected message', error: new Error('GATT operation failed: not connected') },
    // react-native-ble-plx BleError message shapes (name === 'BleError', so the
    // predicate classifies from the message). These two carry the disconnect
    // keyword and must be caught directly.
    { name: 'rn-ble-plx DeviceDisconnected (201)', error: bleError('Device 5C:F8 was disconnected') },
    { name: 'rn-ble-plx DeviceNotConnected (205)', error: bleError('Device 5C:F8 is not connected') },
  ];

  for (const { name, error } of disconnects) {
    it(`treats as disconnect: ${name}`, () => {
      expect(isDisconnectionError(error)).toBe(true);
    });
  }

  const notDisconnects: Array<{ name: string; error: unknown }> = [
    // Unmount-mid-write must never tear down the connection.
    { name: 'AbortError', error: new DOMException('The operation was aborted', 'AbortError') },
    // InvalidStateError without a GATT mention is a different DOM failure
    // (e.g. a closed IDBTransaction) — must not be treated as a disconnect.
    {
      name: 'InvalidStateError without GATT',
      error: new DOMException('The transaction has finished', 'InvalidStateError'),
    },
    // Picker-dismissed.
    { name: 'NotFoundError', error: new DOMException('No device chosen', 'NotFoundError') },
    // The write-stall recovery give-up message (#3181) must NOT classify as a
    // disconnect: that path settles the failed write so JS surfaces a real
    // failure, but the JS write-failure handler must NOT call native disconnect()
    // (which would clear the stored board the lightbulb reconnects to).
    { name: 'write-recovery give-up', error: new Error(WRITE_RECOVERY_FAILED_MESSAGE) },
    // Validation-shaped messages from the write path.
    { name: 'LED data missing', error: new Error('LED placement map is empty') },
    { name: 'incompatible climb', error: new Error('climb incompatible with board') },
    // rn-ble-plx CharacteristicWriteFailed (401) does NOT name the disconnect.
    // The predicate deliberately leaves it unclassified — a write can fail on a
    // live link too. The RNBleAdapter re-probes device.isConnected() and only
    // then normalises to "Device disconnected during write" (caught above).
    {
      name: 'rn-ble-plx CharacteristicWriteFailed (401)',
      error: bleError('Characteristic ABCD write failed for device 5C:F8 and service 1234'),
    },
    // Opaque / non-error values.
    { name: 'opaque error', error: new Error('something opaque') },
    { name: 'plain string', error: 'a plain string' },
  ];

  for (const { name, error } of notDisconnects) {
    it(`treats as non-disconnect: ${name}`, () => {
      expect(isDisconnectionError(error)).toBe(false);
    });
  }
});

describe('isBleWriteTimeoutError', () => {
  it('matches the native iOS write-resume timeout message', () => {
    expect(isBleWriteTimeoutError(new Error('BLE write timed out waiting for the board to accept data'))).toBe(true);
  });

  it('is NOT a disconnection error (JS keeps isConnected=true while native recovers — #3181)', () => {
    expect(isDisconnectionError(new Error('BLE write timed out waiting for the board to accept data'))).toBe(false);
  });

  const notWriteTimeouts: Array<{ name: string; error: unknown }> = [
    // A connect timeout is a different failure — must not be downgraded as a
    // self-healing write stall.
    { name: 'connect timeout', error: new Error('Bluetooth connection timed out') },
    { name: 'disconnect', error: new Error('Device disconnected during write') },
    // The recovery give-up is a hard failure, not a self-healing timeout.
    { name: 'write-recovery give-up', error: new Error(WRITE_RECOVERY_FAILED_MESSAGE) },
    { name: 'validation', error: new Error('LED placement map is empty') },
    { name: 'opaque', error: new Error('something opaque') },
    { name: 'plain string', error: 'a plain string' },
  ];

  for (const { name, error } of notWriteTimeouts) {
    it(`treats as non-write-timeout: ${name}`, () => {
      expect(isBleWriteTimeoutError(error)).toBe(false);
    });
  }
});

describe('isBleWriteRecoveryFailedError', () => {
  it('matches the native recovery give-up message', () => {
    expect(isBleWriteRecoveryFailedError(new Error(WRITE_RECOVERY_FAILED_MESSAGE))).toBe(true);
  });

  it('does not match a plain write-resume timeout (the recoverable case)', () => {
    expect(isBleWriteTimeoutError(new Error(WRITE_RECOVERY_FAILED_MESSAGE))).toBe(false);
    expect(isBleWriteRecoveryFailedError(new Error('BLE write timed out waiting for the board to accept data'))).toBe(
      false,
    );
  });

  const notRecoveryFailures: Array<{ name: string; error: unknown }> = [
    { name: 'disconnect', error: new Error('Device disconnected during write') },
    { name: 'generic write failure', error: new Error('something opaque') },
    { name: 'plain string', error: 'a plain string' },
  ];

  for (const { name, error } of notRecoveryFailures) {
    it(`treats as non-recovery-failure: ${name}`, () => {
      expect(isBleWriteRecoveryFailedError(error)).toBe(false);
    });
  }
});

describe('classifyBleFailureReason', () => {
  const cases: Array<{ name: string; error: unknown; expected: BleSendFailureReason }> = [
    // A dead-link write is the dominant real cause — it must win over the
    // DOMException fallback (NetworkError is a DOMException too).
    {
      name: 'web NetworkError (GATT disconnected)',
      error: new DOMException('GATT Server is disconnected.', 'NetworkError'),
      expected: 'disconnected',
    },
    { name: 'native "Not connected"', error: new Error('Not connected'), expected: 'disconnected' },
    // The mirror builder throws this exact phrase when a hold has no mirror id.
    {
      name: 'mirror mapping missing',
      error: new Error('Mirrored hold ID is not defined for hold ID 42.'),
      expected: 'missing_mirror_mapping',
    },
    // A DOMException we don't otherwise classify is namespaced by its name.
    {
      name: 'unclassified DOMException',
      error: new DOMException('boom', 'OperationError'),
      expected: 'dom_OperationError',
    },
    { name: 'DOMException with empty name', error: new DOMException('boom', ''), expected: 'dom_exception' },
    // Native write-resume timeout gets its own bucket so #3181 recovery is
    // measurable instead of hiding in write_failed.
    {
      name: 'write-resume timeout',
      error: new Error('BLE write timed out waiting for the board to accept data'),
      expected: 'write_timeout',
    },
    // The recovery give-up (#3181) gets its own terminal bucket so the give-up
    // rate is measurable separately from generic write failures.
    {
      name: 'write-recovery give-up',
      error: new Error(WRITE_RECOVERY_FAILED_MESSAGE),
      expected: 'write_recovery_failed',
    },
    // Anything else thrown on a live link.
    { name: 'opaque write error', error: new Error('something opaque'), expected: 'write_failed' },
    { name: 'plain string', error: 'a plain string', expected: 'write_failed' },
  ];

  for (const { name, error, expected } of cases) {
    it(`classifies: ${name} -> ${expected}`, () => {
      expect(classifyBleFailureReason(error)).toBe(expected);
    });
  }
});

describe('classifyBleFailure — ble-plx BleErrorCode (#3608)', () => {
  // ble-plx (Android) puts a numeric BleErrorCode on every thrown BleError. It is
  // authoritative and must win over ble-plx's English message, which matches none
  // of the message patterns and used to fall through to `unknown` — then get
  // re-bucketed as the write-path `disconnected` reason, hiding the real cause.
  const cases: Array<{ name: string; error: unknown; expected: BleFailureCategory }> = [
    // 201 DeviceDisconnected is the dominant Android mis-bucket: its message
    // ("… was disconnected") previously classified as `unknown` -> `disconnected`.
    {
      name: 'DeviceDisconnected (201) on connect',
      error: bleErrorWithCode(201, 'Device 5C:F8 was disconnected'),
      expected: 'connect_failed',
    },
    {
      name: 'DeviceConnectionFailed (200)',
      error: bleErrorWithCode(200, 'Device 5C:F8 was not able to connect'),
      expected: 'connect_failed',
    },
    {
      name: 'DeviceNotConnected (205)',
      error: bleErrorWithCode(205, 'Device 5C:F8 is not connected'),
      expected: 'connect_failed',
    },
    { name: 'OperationTimedOut (3)', error: bleErrorWithCode(3, 'Operation timed out'), expected: 'connect_failed' },
    {
      name: 'DeviceMTUChangeFailed (206)',
      error: bleErrorWithCode(206, 'MTU change failed for device 5C:F8'),
      expected: 'connect_failed',
    },
    // Code beats a misleading "unavailable" in the message.
    {
      name: 'DeviceNotFound (204) with a misleading message',
      error: bleErrorWithCode(204, 'Device 5C:F8 is unavailable'),
      expected: 'board_not_found',
    },
    // Discovery failures whose message names no "... not found" — the message
    // alone would fall through to unknown.
    {
      name: 'ServicesDiscoveryFailed (300)',
      error: bleErrorWithCode(300, 'Services discovery failed for device 5C:F8'),
      expected: 'service_missing',
    },
    {
      name: 'IncludedServicesDiscoveryFailed (301)',
      error: bleErrorWithCode(301, 'opaque'),
      expected: 'service_missing',
    },
    { name: 'ServiceNotFound (302)', error: bleErrorWithCode(302, 'opaque'), expected: 'service_missing' },
    { name: 'ServicesNotDiscovered (303)', error: bleErrorWithCode(303, 'opaque'), expected: 'service_missing' },
    {
      name: 'CharacteristicsDiscoveryFailed (400)',
      error: bleErrorWithCode(400, 'Characteristics discovery failed'),
      expected: 'service_missing',
    },
    { name: 'CharacteristicNotFound (404)', error: bleErrorWithCode(404, 'opaque'), expected: 'service_missing' },
    {
      name: 'CharacteristicsNotDiscovered (405)',
      error: bleErrorWithCode(405, 'opaque'),
      expected: 'service_missing',
    },
    // Radio / permission / OS state.
    { name: 'BluetoothPoweredOff (102)', error: bleErrorWithCode(102, 'opaque'), expected: 'unavailable' },
    { name: 'BluetoothUnauthorized (101)', error: bleErrorWithCode(101, 'opaque'), expected: 'unavailable' },
    { name: 'BluetoothUnsupported (100)', error: bleErrorWithCode(100, 'opaque'), expected: 'unavailable' },
    { name: 'BluetoothInUnknownState (103)', error: bleErrorWithCode(103, 'opaque'), expected: 'unavailable' },
    { name: 'BluetoothResetting (104)', error: bleErrorWithCode(104, 'opaque'), expected: 'unavailable' },
    { name: 'BluetoothStateChangeFailed (105)', error: bleErrorWithCode(105, 'opaque'), expected: 'unavailable' },
    {
      name: 'LocationServicesDisabled (601)',
      error: bleErrorWithCode(601, 'Location services are disabled'),
      expected: 'unavailable',
    },
    // Fallthrough preserved: UnknownError (0) and unmapped codes defer to the
    // message ladder (here no pattern matches → unknown).
    {
      name: 'UnknownError (0) falls through to the message',
      error: bleErrorWithCode(0, 'Cannot connect to device 5C:F8'),
      expected: 'unknown',
    },
    // OperationCancelled (2) is intentionally NOT mapped to user_cancelled (it can
    // be our own connect-timeout cancelDeviceConnection) — it defers to the message.
    {
      name: 'OperationCancelled (2) is not silenced as user_cancelled',
      error: bleErrorWithCode(2, 'Operation was cancelled'),
      expected: 'unknown',
    },
  ];

  for (const { name, error, expected } of cases) {
    it(`classifies: ${name} -> ${expected}`, () => {
      expect(classifyBleFailure(error)).toBe(expected);
    });
  }

  it('ignores a numeric errorCode on a non-BleError (e.g. an iOS CBError)', () => {
    // A foreign error whose numeric `errorCode` collides with the ble-plx enum
    // must not be read against it — the name gate blocks it, so it classifies by
    // message only (here: unknown).
    const cbError = new Error('peripheral is gone') as Error & { errorCode: number };
    cbError.name = 'CBError';
    cbError.errorCode = 201; // would be DeviceDisconnected -> connect_failed if misread
    expect(classifyBleFailure(cbError)).toBe('unknown');
  });

  it('the numeric code wins over the message when both point to different categories', () => {
    // 302 ServiceNotFound with a message that reads like a board-not-found: the
    // code branch runs first, so it classifies as service_missing.
    expect(classifyBleFailure(bleErrorWithCode(302, 'device not found'))).toBe('service_missing');
  });
});

describe('blePlxErrorCodes (#3608)', () => {
  it('extracts the ble-plx code and the low-level Android GATT status', () => {
    const error = bleErrorWithCode(201, 'Device 5C:F8 was disconnected', { androidErrorCode: 133 });
    expect(blePlxErrorCodes(error)).toEqual({ bleErrorCode: 201, androidErrorCode: 133 });
  });

  it('includes iosErrorCode when present (ble-plx iOS path)', () => {
    const error = bleErrorWithCode(201, 'disconnected', { iosErrorCode: 7 });
    expect(blePlxErrorCodes(error)).toEqual({ bleErrorCode: 201, iosErrorCode: 7 });
  });

  it('omits platform codes that are absent', () => {
    expect(blePlxErrorCodes(bleErrorWithCode(204, 'not found'))).toEqual({ bleErrorCode: 204 });
  });

  it('returns {} for a non-ble-plx error (web / native iOS)', () => {
    expect(blePlxErrorCodes(new Error('GATT operation failed'))).toEqual({});
    expect(blePlxErrorCodes(new DOMException('boom', 'NetworkError'))).toEqual({});
    expect(blePlxErrorCodes('a plain string')).toEqual({});
  });

  it('ignores a numeric errorCode on a non-BleError name', () => {
    const cbError = new Error('boom') as Error & { errorCode: number };
    cbError.name = 'CBError';
    cbError.errorCode = 7;
    expect(blePlxErrorCodes(cbError)).toEqual({});
  });
});
