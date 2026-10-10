// @vitest-environment jsdom
// Existing flow fixtures begin after the privacy choice has settled.
vi.mock('../../../lib/consent-hooks', () => ({ useConsentSettled: () => true }));
//
// The component is wiring only: when it adopts the running pin, when it starts
// a sync, and with what. The policy is `decideEarlyUpdatesSync`
// (early-updates.test.ts) and what a sync does to a device is
// ota-track-sequences.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const interactions = vi.hoisted(() => ({ pending: [] as { run: () => void; cancelled: boolean }[] }));
vi.mock('react-native', () => ({
  InteractionManager: {
    runAfterInteractions: (run: () => void) => {
      const task = { run, cancelled: false };
      interactions.pending.push(task);
      return {
        cancel: () => {
          task.cancelled = true;
        },
      };
    },
  },
}));

const syncEarlyUpdates = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/qa/early-updates', () => ({ syncEarlyUpdates }));
const adoptRunningOtaPin = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/qa/qa-surf', () => ({ adoptRunningOtaPin }));

const environment = vi.hoisted(() => ({
  current: {
    surfingBuild: true,
    surfingReady: true,
    flagsResolved: true,
    flag: 'on' as 'on' | 'off' | 'unknown',
    flagOffConfirmed: false,
  },
}));
vi.mock('../../../lib/qa/use-early-updates', () => ({
  useEarlyUpdatesSyncEnvironment: () => environment.current,
}));

import { EarlyUpdatesLaunchSync } from '../EarlyUpdatesLaunchSync';

function runInteractions() {
  const tasks = interactions.pending.filter((task) => !task.cancelled);
  interactions.pending = [];
  for (const task of tasks) task.run();
}

beforeEach(() => {
  vi.clearAllMocks();
  interactions.pending = [];
  syncEarlyUpdates.mockReset().mockResolvedValue('none');
  environment.current = {
    surfingBuild: true,
    surfingReady: true,
    flagsResolved: true,
    flag: 'on',
    flagOffConfirmed: false,
  };
});

describe('EarlyUpdatesLaunchSync', () => {
  it('never syncs during render or mount: only after the first interactions', () => {
    render(<EarlyUpdatesLaunchSync />);
    expect(syncEarlyUpdates).not.toHaveBeenCalled();

    runInteractions();
    expect(syncEarlyUpdates).toHaveBeenCalledExactlyOnceWith(environment.current);
  });

  it('adopts the running pin before the first sync', () => {
    render(<EarlyUpdatesLaunchSync />);
    expect(adoptRunningOtaPin).toHaveBeenCalledOnce();
    expect(syncEarlyUpdates).not.toHaveBeenCalled();
  });

  it('waits for the surfing migration, whose reload would wipe any pin', () => {
    environment.current = { ...environment.current, surfingReady: false };
    const { rerender } = render(<EarlyUpdatesLaunchSync />);
    runInteractions();
    expect(adoptRunningOtaPin).not.toHaveBeenCalled();
    expect(syncEarlyUpdates).not.toHaveBeenCalled();

    environment.current = { ...environment.current, surfingReady: true };
    rerender(<EarlyUpdatesLaunchSync />);
    runInteractions();
    expect(adoptRunningOtaPin).toHaveBeenCalledOnce();
    expect(syncEarlyUpdates).toHaveBeenCalledOnce();
  });

  it('does nothing on a build that cannot surf', () => {
    environment.current = { ...environment.current, surfingBuild: false };
    render(<EarlyUpdatesLaunchSync />);
    runInteractions();

    expect(adoptRunningOtaPin).not.toHaveBeenCalled();
    expect(syncEarlyUpdates).not.toHaveBeenCalled();
  });

  it('syncs again when the flag lands or changes, and adopts only once', () => {
    environment.current = { ...environment.current, flagsResolved: false, flag: 'unknown' };
    const { rerender } = render(<EarlyUpdatesLaunchSync />);
    runInteractions();

    environment.current = { ...environment.current, flagsResolved: true, flag: 'off' };
    rerender(<EarlyUpdatesLaunchSync />);
    runInteractions();

    expect(syncEarlyUpdates).toHaveBeenCalledTimes(2);
    expect(syncEarlyUpdates).toHaveBeenLastCalledWith(environment.current);
    // The running bundle stops proving the pin once anything has switched.
    expect(adoptRunningOtaPin).toHaveBeenCalledOnce();
  });

  it('does not sync again on a re-render that changed nothing', () => {
    const { rerender } = render(<EarlyUpdatesLaunchSync />);
    runInteractions();
    rerender(<EarlyUpdatesLaunchSync />);
    runInteractions();

    expect(syncEarlyUpdates).toHaveBeenCalledOnce();
  });

  it('drops a sync it had not started when it unmounts', () => {
    render(<EarlyUpdatesLaunchSync />).unmount();
    runInteractions();
    expect(syncEarlyUpdates).not.toHaveBeenCalled();
  });
});

import { grantAnalyticsForTest } from '../../../../test/consent-fixture';
beforeEach(() => grantAnalyticsForTest());
