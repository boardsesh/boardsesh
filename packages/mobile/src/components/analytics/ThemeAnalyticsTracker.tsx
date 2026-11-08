import { useEffect } from 'react';
import { registerThemeProperties, reregisterThemeProperties } from '../../lib/analytics-theme';
import { subscribePosthogInitialized } from '../../lib/posthog-client';
import { useTheme } from '../../providers/theme-provider';

/**
 * Keeps the `color_scheme` and `ui_variant` super properties in step with the
 * resolved theme. Registers on mount and again whenever either value changes;
 * it never fires an event. Renders nothing; mounted once inside ThemeProvider
 * beside LowPowerModeTracker.
 *
 * The PostHog client is created asynchronously, usually after this first
 * mounts, so a registration made before then has no client to land on. The
 * initialised listener writes the remembered values once the client exists.
 */
export function ThemeAnalyticsTracker(): null {
  const { colorScheme, variant } = useTheme();
  useEffect(() => subscribePosthogInitialized(() => reregisterThemeProperties()), []);
  useEffect(() => {
    registerThemeProperties({ color_scheme: colorScheme, ui_variant: variant });
  }, [colorScheme, variant]);
  return null;
}
