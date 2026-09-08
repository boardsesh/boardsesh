import { describe, expect, it } from 'vitest';
import { classifyBleDisconnect } from '../disconnect-category';

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
