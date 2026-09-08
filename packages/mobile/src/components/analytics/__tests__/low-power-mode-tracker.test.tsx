// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const batteryMocks = vi.hoisted(() => ({
  isLowPowerModeEnabledAsync: vi.fn<() => Promise<boolean>>(),
  addLowPowerModeListener: vi.fn<(listener: (event: { lowPowerMode: boolean }) => void) => { remove: () => void }>(),
}));
const registerLowPowerMode = vi.hoisted(() => vi.fn<(lowPowerMode: boolean) => void>());

vi.mock('expo-battery', () => ({
  isLowPowerModeEnabledAsync: batteryMocks.isLowPowerModeEnabledAsync,
  addLowPowerModeListener: batteryMocks.addLowPowerModeListener,
}));
vi.mock('../../../lib/analytics-low-power-mode', () => ({ registerLowPowerMode }));

// Imported after the mocks (vi.mock is hoisted above imports).
import { LowPowerModeTracker } from '../LowPowerModeTracker';

type Deferred = { promise: Promise<boolean>; resolve: (value: boolean) => void };
function deferred(): Deferred {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('LowPowerModeTracker', () => {
  let listener: ((event: { lowPowerMode: boolean }) => void) | null;
  const remove = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    listener = null;
    batteryMocks.addLowPowerModeListener.mockImplementation((nextListener) => {
      listener = nextListener;
      return { remove };
    });
  });

  it('registers the initial read, then follows the listener', async () => {
    batteryMocks.isLowPowerModeEnabledAsync.mockResolvedValue(true);
    render(createElement(LowPowerModeTracker));
    await vi.waitFor(() => expect(registerLowPowerMode).toHaveBeenCalledWith(true));

    listener?.({ lowPowerMode: false });
    expect(registerLowPowerMode).toHaveBeenLastCalledWith(false);
  });

  // The initial read is async; a power-state change that lands while it is in
  // flight is the newer fact, and the read must not overwrite it on resolve.
  it('drops an initial read that resolves after a listener event', async () => {
    const initialRead = deferred();
    batteryMocks.isLowPowerModeEnabledAsync.mockReturnValue(initialRead.promise);
    render(createElement(LowPowerModeTracker));

    listener?.({ lowPowerMode: true });
    initialRead.resolve(false);
    await initialRead.promise;
    await Promise.resolve();

    expect(registerLowPowerMode).toHaveBeenCalledTimes(1);
    expect(registerLowPowerMode).toHaveBeenCalledWith(true);
  });

  it('removes the listener and ignores a late read on unmount', async () => {
    const initialRead = deferred();
    batteryMocks.isLowPowerModeEnabledAsync.mockReturnValue(initialRead.promise);
    const { unmount } = render(createElement(LowPowerModeTracker));
    unmount();
    expect(remove).toHaveBeenCalledOnce();

    initialRead.resolve(true);
    await initialRead.promise;
    await Promise.resolve();
    expect(registerLowPowerMode).not.toHaveBeenCalled();
  });

  it('survives a platform without the listener API', async () => {
    batteryMocks.isLowPowerModeEnabledAsync.mockResolvedValue(false);
    batteryMocks.addLowPowerModeListener.mockImplementation(() => {
      throw new Error('not available');
    });
    expect(() => render(createElement(LowPowerModeTracker))).not.toThrow();
    await vi.waitFor(() => expect(registerLowPowerMode).toHaveBeenCalledWith(false));
  });
});
