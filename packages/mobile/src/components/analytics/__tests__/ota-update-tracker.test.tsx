// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ track: vi.fn(), registerSuperProperties: vi.fn() }));
const sentry = vi.hoisted(() => ({ setOtaSentryTags: vi.fn(), setOtaChannelTag: vi.fn() }));
const prefs = vi.hoisted(() => ({ getPreference: vi.fn() }));

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

// Spy on the Sentry tag setters so the override effect's wiring is observable
// without a real (disabled) Sentry. The module-scope setOtaSentryTags stamp also
// routes through this mock at import.
vi.mock('../../../lib/sentry', () => ({
  setOtaSentryTags: sentry.setOtaSentryTags,
  setOtaChannelTag: sentry.setOtaChannelTag,
}));

// Drives the AsyncStorage override mirror the channel-override effect reads.
vi.mock('../../../lib/preference-store', () => ({
  getPreference: prefs.getPreference,
}));

vi.mock('expo-updates', () => ({
  isEnabled: true,
  isEmbeddedLaunch: false,
  updateId: 'a1b2c3d4-0000-0000-0000-000000000000',
  channel: 'production',
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

// A macrotask boundary drains ALL pending microtasks — so the override effect's
// getPreference().then().catch() chain has fully settled before a negative
// assertion, avoiding the false-green of flushing only one microtask deep.
function flushPendingPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  analytics.track.mockClear();
  analytics.registerSuperProperties.mockClear();
  sentry.setOtaSentryTags.mockClear();
  sentry.setOtaChannelTag.mockClear();
  // Default: no tester override stored, so the override effect leaves the tag alone.
  prefs.getPreference.mockReset().mockResolvedValue(null);
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
      runtimeVersion: 'abcdef123456',
      createdAtIso: '2026-06-20T07:53:51.000Z',
    });
    expect(analytics.registerSuperProperties).toHaveBeenCalledWith({
      ota_update_id: 'a1b2c3d4-0000-0000-0000-000000000000',
      ota_is_embedded: false,
      ota_runtime_version: 'abcdef123456',
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

describe('OtaUpdateTracker channel-override Sentry tag', () => {
  it('overrides ota_channel with a tester-stored override channel', async () => {
    prefs.getPreference.mockResolvedValue('pr-3327');
    render(createElement(OtaUpdateTracker));

    await waitFor(() => expect(sentry.setOtaChannelTag).toHaveBeenCalledWith('pr-3327'));
  });

  it('leaves the build-channel tag in place when no override is stored', async () => {
    prefs.getPreference.mockResolvedValue(null);
    render(createElement(OtaUpdateTracker));

    await waitFor(() => expect(prefs.getPreference).toHaveBeenCalled());
    await flushPendingPromises();
    expect(sentry.setOtaChannelTag).not.toHaveBeenCalled();
  });

  it('swallows a storage read failure without overriding the tag or throwing', async () => {
    prefs.getPreference.mockRejectedValue(new Error('secure store unavailable'));
    render(createElement(OtaUpdateTracker));

    await waitFor(() => expect(prefs.getPreference).toHaveBeenCalled());
    await flushPendingPromises();
    expect(sentry.setOtaChannelTag).not.toHaveBeenCalled();
  });
});

describe('stampOtaLaunchSentryTags', () => {
  it('stamps the launch OTA cohort onto Sentry from the Updates.* constants', () => {
    sentry.setOtaSentryTags.mockClear();
    stampOtaLaunchSentryTags();
    expect(sentry.setOtaSentryTags).toHaveBeenCalledWith({
      channel: 'production',
      updateId: 'a1b2c3d4-0000-0000-0000-000000000000',
      runtimeVersion: 'abcdef123456',
      isEmbeddedLaunch: false,
    });
  });
});
