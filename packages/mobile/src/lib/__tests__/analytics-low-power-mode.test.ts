import { beforeEach, describe, expect, it, vi } from 'vitest';

const posthogClientMocks = vi.hoisted(() => ({ getPostHogClient: vi.fn() }));

vi.mock('../posthog-client', () => ({
  getPostHogClient: posthogClientMocks.getPostHogClient,
}));

describe('low power mode super property', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { _resetLowPowerModeForTests } = await import('../analytics-low-power-mode');
    _resetLowPowerModeForTests();
  });

  it('registers the value once per change, not once per read', async () => {
    const fakeClient = { register: vi.fn() };
    posthogClientMocks.getPostHogClient.mockReturnValue(fakeClient);
    const { registerLowPowerMode } = await import('../analytics-low-power-mode');

    registerLowPowerMode(true);
    registerLowPowerMode(true);
    registerLowPowerMode(false);

    expect(fakeClient.register).toHaveBeenCalledTimes(2);
    expect(fakeClient.register).toHaveBeenNthCalledWith(1, { low_power_mode: true });
    expect(fakeClient.register).toHaveBeenNthCalledWith(2, { low_power_mode: false });
  });

  it('is a silent no-op without an analytics client, and still remembers the value', async () => {
    posthogClientMocks.getPostHogClient.mockReturnValue(null);
    const { registerLowPowerMode, reregisterLowPowerMode } = await import('../analytics-low-power-mode');

    expect(() => registerLowPowerMode(true)).not.toThrow();

    const lateClient = { register: vi.fn() };
    reregisterLowPowerMode(lateClient);
    expect(lateClient.register).toHaveBeenCalledWith({ low_power_mode: true });
  });

  it('never throws when register rejects', async () => {
    const fakeClient = { register: vi.fn(() => Promise.reject(new Error('offline'))) };
    posthogClientMocks.getPostHogClient.mockReturnValue(fakeClient);
    const { registerLowPowerMode } = await import('../analytics-low-power-mode');

    expect(() => registerLowPowerMode(true)).not.toThrow();
    await Promise.resolve();
  });
});
