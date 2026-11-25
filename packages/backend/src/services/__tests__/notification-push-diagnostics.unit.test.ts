import { describe, expect, it } from 'vitest';
import { safeExpoPushError } from '../notification-push-diagnostics';

describe('safe Expo push diagnostics', () => {
  it('preserves actionable credential and device error codes', () => {
    expect(safeExpoPushError('InvalidCredentials')).toEqual({
      errorCode: 'InvalidCredentials',
      errorMessage: 'The APNs or FCM push credentials are invalid.',
    });
    expect(safeExpoPushError('DeviceNotRegistered').errorCode).toBe('DeviceNotRegistered');
  });

  it.each([undefined, 'ExpoPushToken[secret]', 'Waiting wall', 'constructor', '__proto__', 'x'.repeat(10000)])(
    'withholds unrecognized upstream strings: %s',
    (upstreamCode) => {
      expect(safeExpoPushError(upstreamCode)).toEqual({
        errorCode: 'unknown',
        errorMessage: 'Expo rejected the notification; upstream message withheld.',
      });
    },
  );
});
