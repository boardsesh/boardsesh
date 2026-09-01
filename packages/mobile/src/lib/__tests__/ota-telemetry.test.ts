import { describe, expect, it } from 'vitest';
import {
  OTA_UPDATE_DOWNLOADED_EVENT,
  OTA_UPDATE_STATUS_EVENT,
  buildOtaStatusProperties,
  readOtaBranch,
} from '../ota-telemetry';

describe('buildOtaStatusProperties', () => {
  it('maps a downloaded-bundle launch to flat PostHog props', () => {
    const createdAt = new Date('2026-06-20T07:53:51.000Z');
    expect(
      buildOtaStatusProperties({
        isEnabled: true,
        isEmbeddedLaunch: false,
        updateId: 'a1b2c3d4-0000-0000-0000-000000000000',
        channel: 'production',
        branch: 'pr-1234',
        runtimeVersion: 'abcdef123456',
        createdAt,
        isEmergencyLaunch: false,
        emergencyLaunchReason: null,
      }),
    ).toEqual({
      isEnabled: true,
      isEmbeddedLaunch: false,
      updateId: 'a1b2c3d4-0000-0000-0000-000000000000',
      channel: 'production',
      branch: 'pr-1234',
      runtimeVersion: 'abcdef123456',
      createdAtIso: '2026-06-20T07:53:51.000Z',
      isEmergencyLaunch: false,
      emergencyLaunchReason: null,
    });
  });

  it('coerces absent fields (dev / Expo Go, where Updates is disabled) to null', () => {
    expect(
      buildOtaStatusProperties({
        isEnabled: false,
        isEmbeddedLaunch: true,
        updateId: undefined,
        channel: undefined,
        branch: undefined,
        runtimeVersion: undefined,
        createdAt: undefined,
        isEmergencyLaunch: false,
        emergencyLaunchReason: undefined,
      }),
    ).toEqual({
      isEnabled: false,
      isEmbeddedLaunch: true,
      updateId: null,
      channel: null,
      branch: null,
      runtimeVersion: null,
      createdAtIso: null,
      isEmergencyLaunch: false,
      emergencyLaunchReason: null,
    });
  });

  it('reads the running xprem branch from manifest extra', () => {
    expect(readOtaBranch({ extra: { branch: 'pr-1234' } })).toBe('pr-1234');
    expect(readOtaBranch({ extra: { branch: '' } })).toBeNull();
    expect(readOtaBranch({ extra: {} })).toBeNull();
    expect(readOtaBranch(null)).toBeNull();
  });

  it('keeps the mobile-only event names stable', () => {
    expect(OTA_UPDATE_STATUS_EVENT).toBe('OTA Update Status');
    expect(OTA_UPDATE_DOWNLOADED_EVENT).toBe('OTA Update Downloaded');
  });
});
