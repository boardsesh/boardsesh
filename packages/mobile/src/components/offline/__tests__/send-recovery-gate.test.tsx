// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const pushMock = vi.hoisted(() => vi.fn());
const segmentsCtrl = vi.hoisted(() => ({ segments: ['(tabs)', 'climbs'] as string[] }));
const hasSeenOnboardingMock = vi.hoisted(() => vi.fn());
const getInitialURLMock = vi.hoisted(() => vi.fn());
const readNoticeMock = vi.hoisted(() => vi.fn());
const clearNoticeMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const reportHandledErrorMock = vi.hoisted(() => vi.fn());
const dbCtrl = vi.hoisted(() => ({ handle: { name: 'db' } as object | null, schemaReady: true }));
const launchCtrl = vi.hoisted(() => ({ ready: true }));
const flagsCtrl = vi.hoisted(() => ({ enabled: true, resolved: true }));

vi.mock('expo-router', () => ({
  router: { push: pushMock },
  useSegments: () => segmentsCtrl.segments,
}));
vi.mock('expo-linking', () => ({ getInitialURL: getInitialURLMock }));
// Run the deferred work inline so each case is one awaited tick rather than a
// timer dance; the real InteractionManager only postpones it past the frame.
vi.mock('react-native', () => ({
  InteractionManager: {
    runAfterInteractions: (task: () => void) => {
      task();
      return { cancel: vi.fn() };
    },
  },
}));
vi.mock('@boardsesh/offline-sync', () => ({
  readDeadLetterRecoveryNotice: readNoticeMock,
  clearDeadLetterRecoveryNotice: clearNoticeMock,
}));
vi.mock('../../../db/connection', () => ({ getDatabaseHandle: () => dbCtrl.handle }));
vi.mock('../../../db/use-offline-schema-ready', () => ({ useOfflineSchemaReady: () => dbCtrl.schemaReady }));
vi.mock('../../../lib/onboarding/onboarding-storage', () => ({ hasSeenOnboarding: hasSeenOnboardingMock }));
vi.mock('../../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: reportHandledErrorMock }));
vi.mock('../../../providers/launch-ready-context', () => ({ useLaunchReady: () => launchCtrl.ready }));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useSendRecoveryGateEnabled: () => flagsCtrl.enabled,
  useFeatureFlagsResolved: () => flagsCtrl.resolved,
}));

import { SendRecoveryGate, resetSendRecoverySessionForTests } from '../SendRecoveryGate';

beforeEach(() => {
  resetSendRecoverySessionForTests();
  pushMock.mockClear();
  trackMock.mockClear();
  reportHandledErrorMock.mockClear();
  hasSeenOnboardingMock.mockReset().mockResolvedValue(true);
  getInitialURLMock.mockReset().mockResolvedValue(null);
  readNoticeMock.mockReset().mockResolvedValue(3);
  clearNoticeMock.mockReset().mockResolvedValue(undefined);
  segmentsCtrl.segments = ['(tabs)', 'climbs'];
  dbCtrl.handle = { name: 'db' };
  dbCtrl.schemaReady = true;
  launchCtrl.ready = true;
  flagsCtrl.enabled = true;
  flagsCtrl.resolved = true;
  delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
});

describe('SendRecoveryGate', () => {
  it('tells the climber how many sends came back, and reports it once', async () => {
    render(<SendRecoveryGate />);

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith({ pathname: '/send-recovery', params: { count: '3' } }));
    expect(trackMock).toHaveBeenCalledWith('Offline Send Recovery Shown', { recoveredCount: 3 });
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it('says nothing when the recovery found nothing', async () => {
    readNoticeMock.mockResolvedValue(null);

    render(<SendRecoveryGate />);

    await waitFor(() => expect(readNoticeMock).toHaveBeenCalled());
    expect(pushMock).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
    expect(clearNoticeMock).not.toHaveBeenCalled();
  });

  it('clears the note before navigating, so a later launch stays quiet', async () => {
    render(<SendRecoveryGate />);

    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(clearNoticeMock).toHaveBeenCalledTimes(1);

    // The next cold start reads what the first one left: nothing.
    resetSendRecoverySessionForTests();
    readNoticeMock.mockResolvedValue(null);
    pushMock.mockClear();
    trackMock.mockClear();

    render(<SendRecoveryGate />);

    await waitFor(() => expect(readNoticeMock).toHaveBeenCalledTimes(2));
    expect(pushMock).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('does not push twice within one session', async () => {
    const first = render(<SendRecoveryGate />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    first.unmount();

    render(<SendRecoveryGate />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it('waits for the schema, because the migration is what does the recovering', async () => {
    dbCtrl.schemaReady = false;

    render(<SendRecoveryGate />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readNoticeMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('yields to the first-run walkthrough and tries again next launch', async () => {
    hasSeenOnboardingMock.mockResolvedValue(false);

    render(<SendRecoveryGate />);
    await waitFor(() => expect(hasSeenOnboardingMock).toHaveBeenCalled());

    expect(pushMock).not.toHaveBeenCalled();
    // The note is still there for the next launch — nothing was consumed.
    expect(clearNoticeMock).not.toHaveBeenCalled();
  });

  it('yields to a cold start that came in through a deep link', async () => {
    getInitialURLMock.mockResolvedValue('com.boardsesh.app://join/abc');

    render(<SendRecoveryGate />);
    await waitFor(() => expect(getInitialURLMock).toHaveBeenCalled());

    expect(pushMock).not.toHaveBeenCalled();
    expect(clearNoticeMock).not.toHaveBeenCalled();
  });

  it('never announces a notice it could not consume', async () => {
    clearNoticeMock.mockRejectedValue(new Error('database is locked'));

    render(<SendRecoveryGate />);
    await waitFor(() => expect(reportHandledErrorMock).toHaveBeenCalled());

    // Telling somebody twice is worse than telling them next launch: the sends
    // are already back on the queue either way.
    expect(pushMock).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('stays out of App Store screenshots', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';

    render(<SendRecoveryGate />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readNoticeMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

// #5654: this gate sat frozen at "not ready" from 2.2.0 until the wiring fix, so
// readiness now arrives through the launch-ready context, and the gate carries a
// kill switch that must land before it consumes the note.
describe('SendRecoveryGate readiness and its kill switch', () => {
  it('does nothing until the app is ready, then delivers the notice', async () => {
    launchCtrl.ready = false;
    const { rerender } = render(<SendRecoveryGate />);
    await Promise.resolve();
    expect(readNoticeMock).not.toHaveBeenCalled();

    launchCtrl.ready = true;
    rerender(<SendRecoveryGate />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
  });

  it('waits for the feature flags to resolve before reading the note', async () => {
    flagsCtrl.resolved = false;
    const { rerender } = render(<SendRecoveryGate />);
    await Promise.resolve();
    expect(readNoticeMock).not.toHaveBeenCalled();

    flagsCtrl.resolved = true;
    rerender(<SendRecoveryGate />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
  });

  it('leaves the note owed when send-recovery-gate-kill is on', async () => {
    flagsCtrl.enabled = false;
    render(<SendRecoveryGate />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readNoticeMock).not.toHaveBeenCalled();
    expect(clearNoticeMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
