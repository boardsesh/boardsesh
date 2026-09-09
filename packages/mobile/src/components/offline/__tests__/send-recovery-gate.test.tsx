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
  delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
});

describe('SendRecoveryGate', () => {
  it('tells the climber how many sends came back, and reports it once', async () => {
    render(<SendRecoveryGate ready />);

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith({ pathname: '/send-recovery', params: { count: '3' } }));
    expect(trackMock).toHaveBeenCalledWith('Offline Send Recovery Shown', { recoveredCount: 3 });
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it('says nothing when the recovery found nothing', async () => {
    readNoticeMock.mockResolvedValue(null);

    render(<SendRecoveryGate ready />);

    await waitFor(() => expect(readNoticeMock).toHaveBeenCalled());
    expect(pushMock).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
    expect(clearNoticeMock).not.toHaveBeenCalled();
  });

  it('clears the note before navigating, so a later launch stays quiet', async () => {
    render(<SendRecoveryGate ready />);

    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(clearNoticeMock).toHaveBeenCalledTimes(1);

    // The next cold start reads what the first one left: nothing.
    resetSendRecoverySessionForTests();
    readNoticeMock.mockResolvedValue(null);
    pushMock.mockClear();
    trackMock.mockClear();

    render(<SendRecoveryGate ready />);

    await waitFor(() => expect(readNoticeMock).toHaveBeenCalledTimes(2));
    expect(pushMock).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('does not push twice within one session', async () => {
    const first = render(<SendRecoveryGate ready />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    first.unmount();

    render(<SendRecoveryGate ready />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it('waits for the schema, because the migration is what does the recovering', async () => {
    dbCtrl.schemaReady = false;

    render(<SendRecoveryGate ready />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readNoticeMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('yields to the first-run walkthrough and tries again next launch', async () => {
    hasSeenOnboardingMock.mockResolvedValue(false);

    render(<SendRecoveryGate ready />);
    await waitFor(() => expect(hasSeenOnboardingMock).toHaveBeenCalled());

    expect(pushMock).not.toHaveBeenCalled();
    // The note is still there for the next launch — nothing was consumed.
    expect(clearNoticeMock).not.toHaveBeenCalled();
  });

  it('yields to a cold start that came in through a deep link', async () => {
    getInitialURLMock.mockResolvedValue('com.boardsesh.app://join/abc');

    render(<SendRecoveryGate ready />);
    await waitFor(() => expect(getInitialURLMock).toHaveBeenCalled());

    expect(pushMock).not.toHaveBeenCalled();
    expect(clearNoticeMock).not.toHaveBeenCalled();
  });

  it('never announces a notice it could not consume', async () => {
    clearNoticeMock.mockRejectedValue(new Error('database is locked'));

    render(<SendRecoveryGate ready />);
    await waitFor(() => expect(reportHandledErrorMock).toHaveBeenCalled());

    // Telling somebody twice is worse than telling them next launch: the sends
    // are already back on the queue either way.
    expect(pushMock).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('stays out of App Store screenshots', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';

    render(<SendRecoveryGate ready />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readNoticeMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
