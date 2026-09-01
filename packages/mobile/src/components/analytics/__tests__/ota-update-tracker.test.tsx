// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ track: vi.fn(), registerSuperProperties: vi.fn() }));
const sentry = vi.hoisted(() => ({ setOtaSentryTags: vi.fn() }));

// Drives Updates.useUpdates() per test. The constants below mirror an OTA'd
// production launch; `current` is swapped to exercise the downloaded-bundle
// branch (a newer bundle fetched but not yet applied).
const updates = vi.hoisted(() => ({
  current: {
    isUpdatePending: false,
    downloadedUpdate: undefined as undefined | { updateId?: string; createdAt?: Date },
  },
}));

vi.mock('../../../lib/analytics', () => ({
  track: analytics.track,
  registerSuperProperties: analytics.registerSuperProperties,
}));

// Spy on the Sentry tag setter so launch stamping is observable without a real
// (disabled) Sentry. The module-scope stamp also routes through this mock.
vi.mock('../../../lib/sentry', () => ({
  setOtaSentryTags: sentry.setOtaSentryTags,
}));

vi.mock('expo-updates', () => ({
  isEnabled: true,
  isEmbeddedLaunch: false,
  updateId: 'a1b2c3d4-0000-0000-0000-000000000000',
  channel: 'production',
  manifest: { extra: { branch: 'pr-3327' } },
  runtimeVersion: 'abcdef123456',
  createdAt: new Date('2026-06-20T07:53:51.000Z'),
  isEmergencyLaunch: false,
  emergencyLaunchReason: null,
  useUpdates: () => updates.current,
}));

// Imported after the mocks (vi.mock is hoisted above imports).
import { OtaUpdateTracker, resetOtaStatusReportedForTests, stampOtaLaunchSentryTags } from '../OtaUpdateTracker';

function trackCallsFor(eventName: string) {
  return analytics.track.mock.calls.filter(([name]) => name === eventName);
}

beforeEach(() => {
  analytics.track.mockClear();
  analytics.registerSuperProperties.mockClear();
  sentry.setOtaSentryTags.mockClear();
  updates.current = { isUpdatePending: false, downloadedUpdate: undefined };
  // The status guard is module-scoped (once per launch); reset it so each test
  // starts from a clean "nothing reported yet" state.
  resetOtaStatusReportedForTests();
});

describe('OtaUpdateTracker', () => {
  it('reports the running bundle once and registers the OTA cohort', () => {
    render(createElement(OtaUpdateTracker));

    const statusCalls = trackCallsFor('OTA Update Status');
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0][1]).toMatchObject({
      isEnabled: true,
      isEmbeddedLaunch: false,
      updateId: 'a1b2c3d4-0000-0000-0000-000000000000',
      channel: 'production',
      branch: 'pr-3327',
      runtimeVersion: 'abcdef123456',
      createdAtIso: '2026-06-20T07:53:51.000Z',
    });
    // Keep the fixed channel and the running xprem branch as super properties so
    // all events can distinguish production traffic from a surfed pr-* preview.
    expect(analytics.registerSuperProperties).toHaveBeenCalledWith({
      ota_update_id: 'a1b2c3d4-0000-0000-0000-000000000000',
      ota_is_embedded: false,
      ota_runtime_version: 'abcdef123456',
      ota_channel: 'production',
      ota_branch: 'pr-3327',
    });
  });

  it('reports a freshly downloaded bundle, deduped on updateId', () => {
    updates.current = {
      isUpdatePending: true,
      downloadedUpdate: { updateId: 'next-update-id', createdAt: new Date('2026-06-21T00:00:00.000Z') },
    };
    const { rerender } = render(createElement(OtaUpdateTracker));

    // A new object with the same updateId — the ref dedup must suppress a second
    // event even though the effect re-runs on the changed reference.
    updates.current = {
      isUpdatePending: true,
      downloadedUpdate: { updateId: 'next-update-id', createdAt: new Date('2026-06-21T00:00:00.000Z') },
    };
    rerender(createElement(OtaUpdateTracker));

    const downloadedCalls = trackCallsFor('OTA Update Downloaded');
    expect(downloadedCalls).toHaveLength(1);
    expect(downloadedCalls[0][1]).toEqual({
      updateId: 'next-update-id',
      createdAtIso: '2026-06-21T00:00:00.000Z',
    });
  });

  it('reports the launch status only once across a remount (same launch)', () => {
    const first = render(createElement(OtaUpdateTracker));
    first.unmount();
    render(createElement(OtaUpdateTracker));

    // Same JS runtime ⇒ same updateId ⇒ the module-scoped guard suppresses the
    // second report.
    expect(trackCallsFor('OTA Update Status')).toHaveLength(1);
  });

  it('coalesces a downloaded bundle with no createdAt to null', () => {
    updates.current = {
      isUpdatePending: true,
      downloadedUpdate: { updateId: 'rollback-or-undated', createdAt: undefined },
    };
    render(createElement(OtaUpdateTracker));

    const downloadedCalls = trackCallsFor('OTA Update Downloaded');
    expect(downloadedCalls).toHaveLength(1);
    expect(downloadedCalls[0][1]).toEqual({
      updateId: 'rollback-or-undated',
      createdAtIso: null,
    });
  });

  it('does not report a download when none is pending', () => {
    render(createElement(OtaUpdateTracker));
    expect(trackCallsFor('OTA Update Downloaded')).toHaveLength(0);
  });

  it('does not report a download when pending but no bundle is downloaded yet', () => {
    updates.current = { isUpdatePending: true, downloadedUpdate: undefined };
    render(createElement(OtaUpdateTracker));
    expect(trackCallsFor('OTA Update Downloaded')).toHaveLength(0);
  });
});

describe('stampOtaLaunchSentryTags', () => {
  it('stamps the launch OTA cohort onto Sentry from the Updates.* constants', () => {
    sentry.setOtaSentryTags.mockClear();
    stampOtaLaunchSentryTags();
    expect(sentry.setOtaSentryTags).toHaveBeenCalledWith({
      channel: 'production',
      branch: 'pr-3327',
      updateId: 'a1b2c3d4-0000-0000-0000-000000000000',
      runtimeVersion: 'abcdef123456',
      isEmbeddedLaunch: false,
    });
  });
});
