import { describe, it, expect } from 'vitest';
import {
  classifyBleFailure,
  classifyBleFailureReason,
  isDisconnectionError,
  type BleFailureCategory,
  type BleSendFailureReason,
} from '../connection-error';

// Mimics a react-native-ble-plx BleError: an Error subclass whose `name` is
// 'BleError' (so the predicate classifies from the message, not the name).
function bleError(message: string): Error {
  const error = new Error(message);
  error.name = 'BleError';
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
