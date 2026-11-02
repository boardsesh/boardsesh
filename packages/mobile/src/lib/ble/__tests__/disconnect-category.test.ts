import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyBleDisconnect, isBluetoothSwitchedOff } from '../disconnect-category';

describe('classifyBleDisconnect', () => {
  it('returns unknown when no info was captured', () => {
    expect(classifyBleDisconnect(undefined)).toBe('unknown');
    expect(classifyBleDisconnect(null)).toBe('unknown');
    expect(classifyBleDisconnect({ source: 'native-ios' })).toBe('unknown');
  });

  it('gives the write-failure drop path its own bucket', () => {
    expect(classifyBleDisconnect({ source: 'write-failure' })).toBe('write_failure');
  });

  it('maps the write-stall recovery contexts to app_recovery', () => {
    expect(classifyBleDisconnect({ source: 'native-ios', context: 'write_stall_recovery_failed' })).toBe(
      'app_recovery',
    );
    expect(classifyBleDisconnect({ source: 'native-ios', context: 'write_stall_budget_exhausted' })).toBe(
      'app_recovery',
    );
    expect(classifyBleDisconnect({ source: 'native-ios', context: 'write_stall_recovery_timeout' })).toBe(
      'app_recovery',
    );
    expect(classifyBleDisconnect({ source: 'native-ios', context: 'write_stall_recovery_stale' })).toBe('app_recovery');
  });

  it('maps the central-state marker to bluetooth_off', () => {
    expect(classifyBleDisconnect({ source: 'native-ios', context: 'bluetooth_unavailable' })).toBe('bluetooth_off');
  });

  it('leaves an unrecognised context unknown rather than guessing', () => {
    expect(classifyBleDisconnect({ source: 'native-ios', context: 'some_future_marker' })).toBe('unknown');
  });

  it('classifies CoreBluetooth codes from the native adapter (domain-gated)', () => {
    // CBError 7 peripheralDisconnected — the takeover signature.
    expect(classifyBleDisconnect({ source: 'native-ios', iosErrorCode: 7, errorDomain: 'CBErrorDomain' })).toBe(
      'peer_terminated',
    );
    // CBError 6 connectionTimeout — range/idle drop.
    expect(classifyBleDisconnect({ source: 'native-ios', iosErrorCode: 6, errorDomain: 'CBErrorDomain' })).toBe(
      'link_timeout',
    );
    // Same numeric code in CBATTErrorDomain means something else entirely.
    expect(classifyBleDisconnect({ source: 'native-ios', iosErrorCode: 7, errorDomain: 'CBATTErrorDomain' })).toBe(
      'unknown',
    );
    // The native adapter always carries a domain; a domain-less native-ios code
    // is off-contract and must not be trusted.
    expect(classifyBleDisconnect({ source: 'native-ios', iosErrorCode: 7 })).toBe('unknown');
  });

  it('classifies ble-plx iOS codes without a domain', () => {
    expect(classifyBleDisconnect({ source: 'ble-plx', iosErrorCode: 7, bleErrorCode: 205 })).toBe('peer_terminated');
    expect(classifyBleDisconnect({ source: 'ble-plx', iosErrorCode: 6 })).toBe('link_timeout');
  });

  it('classifies Android GATT status codes', () => {
    // 19 = 0x13 remote user terminated — the takeover signature on Android.
    expect(classifyBleDisconnect({ source: 'ble-plx', androidErrorCode: 19 })).toBe('peer_terminated');
    // 8 = 0x08 connection (supervision) timeout.
    expect(classifyBleDisconnect({ source: 'ble-plx', androidErrorCode: 8 })).toBe('link_timeout');
    // Unmapped status stays unknown.
    expect(classifyBleDisconnect({ source: 'ble-plx', androidErrorCode: 22 })).toBe('unknown');
  });
});

// Board plan item 8: a drive that ends on a Bluetooth drop the climber made is
// not said; one the phone's Bluetooth stack made on its own is.
describe('isBluetoothSwitchedOff', () => {
  const centralState = (state: number) => ({
    source: 'native-ios' as const,
    context: 'bluetooth_unavailable',
    description: `central state ${state}`,
  });

  it.each([
    ['poweredOff', 4],
    ['unauthorized', 3],
    ['unsupported', 2],
  ])('is true for %s', (_state, rawValue) => {
    expect(isBluetoothSwitchedOff(centralState(rawValue))).toBe(true);
  });

  it.each([
    ['resetting (the Bluetooth daemon restarting)', 1],
    ['unknown', 0],
  ])('is false for %s, which comes back on its own', (_state, rawValue) => {
    expect(isBluetoothSwitchedOff(centralState(rawValue))).toBe(false);
  });

  it('reads a marker without a state as switched off', () => {
    expect(isBluetoothSwitchedOff({ source: 'native-ios', context: 'bluetooth_unavailable' })).toBe(true);
  });

  it('is false for every other drop', () => {
    expect(isBluetoothSwitchedOff(undefined)).toBe(false);
    expect(isBluetoothSwitchedOff({ source: 'native-ios', iosErrorCode: 7, errorDomain: 'CBErrorDomain' })).toBe(false);
    expect(isBluetoothSwitchedOff({ source: 'native-ios', description: 'central state 4' })).toBe(false);
  });
});

// The parser reads the text BoardBleManager.swift writes on a bluetooth_unavailable
// drop. Pin that literal so a rename on the Swift side fails here instead of
// silently turning every stack reset back into a silent "switched off".
describe('BoardBleManager.swift bluetooth_unavailable description', () => {
  const swiftSource = readFileSync(
    join(__dirname, '../../../../modules/live-activity/ios/BoardBleManager.swift'),
    'utf8',
  );
  const emitted = /"context": "bluetooth_unavailable",\s*"errorDescription": "([^"]*)\\\(state\.rawValue\)"/.exec(
    swiftSource,
  );

  it('still writes the central state the parser reads', () => {
    expect(emitted?.[1]).toBe('central state ');
  });

  it('parses what Swift writes for poweredOff and resetting', () => {
    const asSwiftWrites = (rawValue: number) => ({
      source: 'native-ios' as const,
      context: 'bluetooth_unavailable',
      description: `${emitted?.[1] ?? ''}${rawValue}`,
    });
    expect(isBluetoothSwitchedOff(asSwiftWrites(4))).toBe(true);
    expect(isBluetoothSwitchedOff(asSwiftWrites(1))).toBe(false);
  });
});
