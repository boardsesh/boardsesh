import { beforeEach, describe, expect, it, vi } from 'vitest';

const posthogClientMocks = vi.hoisted(() => ({ getPostHogClient: vi.fn() }));

vi.mock('../posthog-client', () => ({
  getPostHogClient: posthogClientMocks.getPostHogClient,
}));

describe('theme super properties', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { _resetThemePropertiesForTests } = await import('../analytics-theme');
    _resetThemePropertiesForTests();
  });

  it('registers both properties, skips an unchanged pair, and re-registers on scheme or variant change', async () => {
    const fakeClient = { register: vi.fn() };
    posthogClientMocks.getPostHogClient.mockReturnValue(fakeClient);
    const { registerThemeProperties } = await import('../analytics-theme');

    registerThemeProperties({ color_scheme: 'light', ui_variant: 'material' });
    registerThemeProperties({ color_scheme: 'light', ui_variant: 'material' });
    registerThemeProperties({ color_scheme: 'dark', ui_variant: 'material' });
    registerThemeProperties({ color_scheme: 'dark', ui_variant: 'liquidGlass' });

    expect(fakeClient.register).toHaveBeenCalledTimes(3);
    expect(fakeClient.register).toHaveBeenNthCalledWith(1, { color_scheme: 'light', ui_variant: 'material' });
    expect(fakeClient.register).toHaveBeenNthCalledWith(2, { color_scheme: 'dark', ui_variant: 'material' });
    expect(fakeClient.register).toHaveBeenNthCalledWith(3, { color_scheme: 'dark', ui_variant: 'liquidGlass' });
  });

  it('is a silent no-op without an analytics client, and still remembers the values', async () => {
    posthogClientMocks.getPostHogClient.mockReturnValue(null);
    const { registerThemeProperties, reregisterThemeProperties } = await import('../analytics-theme');

    expect(() => registerThemeProperties({ color_scheme: 'dark', ui_variant: 'liquidGlass' })).not.toThrow();

    const lateClient = { register: vi.fn() };
    reregisterThemeProperties(lateClient);
    expect(lateClient.register).toHaveBeenCalledWith({ color_scheme: 'dark', ui_variant: 'liquidGlass' });
  });

  it('never throws when register rejects', async () => {
    const fakeClient = { register: vi.fn(() => Promise.reject(new Error('offline'))) };
    posthogClientMocks.getPostHogClient.mockReturnValue(fakeClient);
    const { registerThemeProperties } = await import('../analytics-theme');

    expect(() => registerThemeProperties({ color_scheme: 'light', ui_variant: 'material' })).not.toThrow();
    await Promise.resolve();
  });
});
