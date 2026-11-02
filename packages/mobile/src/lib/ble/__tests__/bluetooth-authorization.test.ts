import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  installIosBluetoothAuthorization,
  nativeBluetoothAuthorizationHarness,
  resetNativeBluetoothAuthorizationHarness,
} from './native-bluetooth-authorization-test-harness';

vi.mock('../../../../modules/live-activity/src/index', async () => {
  const { nativeBluetoothAuthorizationHarness: harness } =
    await import('./native-bluetooth-authorization-test-harness');
  return {
    get boardBleNative() {
      return harness.nativeModule;
    },
  };
});

import {
  allowsBluetoothUse,
  isBluetoothAuthorizationRefused,
  readBluetoothAuthorization,
  requestBluetoothAuthorization,
} from '../bluetooth-authorization';

beforeEach(() => {
  resetNativeBluetoothAuthorizationHarness();
});

describe('readBluetoothAuthorization', () => {
  it('is null without the BoardBle module (Android, web), so nothing changes there', () => {
    expect(readBluetoothAuthorization()).toBeNull();
  });

  it('is null on an iOS binary that still asks at launch (no native read)', () => {
    nativeBluetoothAuthorizationHarness.nativeModule = {};
    expect(readBluetoothAuthorization()).toBeNull();
  });

  it.each(['notDetermined', 'allowedAlways', 'denied', 'restricted'] as const)('reads %s', (authorization) => {
    installIosBluetoothAuthorization(authorization);
    expect(readBluetoothAuthorization()).toBe(authorization);
  });

  it('reads a value it does not know as "can\'t tell"', () => {
    nativeBluetoothAuthorizationHarness.nativeModule = { getBluetoothAuthorization: () => 'unknown' };
    expect(readBluetoothAuthorization()).toBeNull();
  });

  it('reads a throwing native call as "can\'t tell"', () => {
    nativeBluetoothAuthorizationHarness.nativeModule = {
      getBluetoothAuthorization: () => {
        throw new Error('bridge gone');
      },
    };
    expect(readBluetoothAuthorization()).toBeNull();
  });
});

describe('requestBluetoothAuthorization', () => {
  it('asks when the climber has never answered, and returns the answer', async () => {
    installIosBluetoothAuthorization('notDetermined', 'denied');

    await expect(requestBluetoothAuthorization()).resolves.toBe('denied');
    expect(nativeBluetoothAuthorizationHarness.requestCount).toBe(1);
  });

  it('does not ask again once answered', async () => {
    installIosBluetoothAuthorization('allowedAlways');

    await expect(requestBluetoothAuthorization()).resolves.toBe('allowedAlways');
    expect(nativeBluetoothAuthorizationHarness.requestCount).toBe(0);
  });

  it('is null, and asks nothing, without the native surface', async () => {
    await expect(requestBluetoothAuthorization()).resolves.toBeNull();
  });

  it('re-reads the authorization when the native ask rejects', async () => {
    installIosBluetoothAuthorization('notDetermined');
    const nativeModule = nativeBluetoothAuthorizationHarness.nativeModule;
    if (!nativeModule) throw new Error('harness not installed');
    nativeModule.requestBluetoothAuthorization = vi.fn(async () => {
      nativeBluetoothAuthorizationHarness.authorization = 'allowedAlways';
      throw new Error('promise dropped');
    });

    await expect(requestBluetoothAuthorization()).resolves.toBe('allowedAlways');
  });
});

describe('isBluetoothAuthorizationRefused', () => {
  it.each([
    ['denied', true],
    ['restricted', true],
    ['allowedAlways', false],
    ['notDetermined', false],
    [null, false],
  ] as const)('%s → %s', (authorization, refused) => {
    expect(isBluetoothAuthorizationRefused(authorization)).toBe(refused);
  });
});

describe('allowsBluetoothUse', () => {
  it.each([
    ['allowedAlways', true],
    // Nothing to ask through (Android, web, an older binary): the old path.
    [null, true],
    ['notDetermined', false],
    ['denied', false],
    ['restricted', false],
  ] as const)('%s → %s', (authorization, allowed) => {
    expect(allowsBluetoothUse(authorization)).toBe(allowed);
  });
});
