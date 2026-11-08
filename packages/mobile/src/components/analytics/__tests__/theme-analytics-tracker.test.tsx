// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ThemeValue = { colorScheme: 'light' | 'dark'; variant: 'liquidGlass' | 'material' };

const themeMocks = vi.hoisted(() => ({ current: { colorScheme: 'light', variant: 'material' } as ThemeValue }));
const registerThemeProperties = vi.hoisted(() =>
  vi.fn<(properties: { color_scheme: string; ui_variant: string }) => void>(),
);

vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => themeMocks.current }));
const reregisterThemeProperties = vi.hoisted(() => vi.fn<() => void>());
const initializedListeners = vi.hoisted(() => new Set<() => void>());
const subscribePosthogInitialized = vi.hoisted(() =>
  vi.fn((listener: () => void) => {
    initializedListeners.add(listener);
    return () => initializedListeners.delete(listener);
  }),
);
vi.mock('../../../lib/analytics-theme', () => ({ registerThemeProperties, reregisterThemeProperties }));
vi.mock('../../../lib/posthog-client', () => ({ subscribePosthogInitialized }));

// Imported after the mocks (vi.mock is hoisted above imports).
import { ThemeAnalyticsTracker } from '../ThemeAnalyticsTracker';

describe('ThemeAnalyticsTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initializedListeners.clear();
    themeMocks.current = { colorScheme: 'light', variant: 'material' };
  });

  it('registers the resolved theme on mount', () => {
    render(createElement(ThemeAnalyticsTracker));
    expect(registerThemeProperties).toHaveBeenCalledTimes(1);
    expect(registerThemeProperties).toHaveBeenCalledWith({ color_scheme: 'light', ui_variant: 'material' });
  });

  it('re-registers when the scheme changes and when the variant changes', () => {
    const { rerender } = render(createElement(ThemeAnalyticsTracker));

    themeMocks.current = { colorScheme: 'dark', variant: 'material' };
    rerender(createElement(ThemeAnalyticsTracker));
    expect(registerThemeProperties).toHaveBeenLastCalledWith({ color_scheme: 'dark', ui_variant: 'material' });

    themeMocks.current = { colorScheme: 'dark', variant: 'liquidGlass' };
    rerender(createElement(ThemeAnalyticsTracker));
    expect(registerThemeProperties).toHaveBeenLastCalledWith({ color_scheme: 'dark', ui_variant: 'liquidGlass' });
    expect(registerThemeProperties).toHaveBeenCalledTimes(3);
  });

  it('does not re-register on a rerender with the same theme', () => {
    const { rerender } = render(createElement(ThemeAnalyticsTracker));
    rerender(createElement(ThemeAnalyticsTracker));
    expect(registerThemeProperties).toHaveBeenCalledTimes(1);
  });

  it('writes the remembered theme once the PostHog client finishes initialising', () => {
    const { unmount } = render(createElement(ThemeAnalyticsTracker));
    expect(reregisterThemeProperties).not.toHaveBeenCalled();

    for (const listener of initializedListeners) listener();
    expect(reregisterThemeProperties).toHaveBeenCalledTimes(1);

    unmount();
    expect(initializedListeners.size).toBe(0);
  });
});
