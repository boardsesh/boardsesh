import { afterEach, describe, expect, it } from 'vite-plus/test';
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import Alert, { type AlertColor } from '@mui/material/Alert';
import { ThemeProvider, type Theme } from '@mui/material/styles';
import { STANDARD_ALERT_SEVERITIES, darkTheme } from '../mui-theme';
import { themeTokens } from '../theme-config';

afterEach(cleanup);

const SEVERITIES: AlertColor[] = ['error', 'warning', 'success', 'info'];
const VARIANTS = ['standard', 'filled', 'outlined'] as const;

/** The same theme without the MuiAlert override: what MUI drew before the fix. */
const themeWithoutOverride: Theme = {
  ...darkTheme,
  components: { ...darkTheme.components, MuiAlert: undefined },
};

function drawnColours(theme: Theme, variant: (typeof VARIANTS)[number], severity: AlertColor) {
  const { container } = render(
    <ThemeProvider theme={theme}>
      <Alert variant={variant} severity={severity}>
        Message
      </Alert>
    </ThemeProvider>,
  );
  const alert = container.querySelector('.MuiAlert-root');
  if (!alert) throw new Error('no Alert rendered');
  const style = getComputedStyle(alert);
  const colours = { color: style.color, background: style.backgroundColor };
  cleanup();
  return colours;
}

const overridden: ReadonlySet<string> = new Set(STANDARD_ALERT_SEVERITIES);

describe('Alert variants under the dark theme', () => {
  it.each(STANDARD_ALERT_SEVERITIES)('draws a standard %s message in opaque ink on its status tint', (severity) => {
    const { color, background } = drawnColours(darkTheme, 'standard', severity);
    expect(color).toBe('rgb(243, 239, 250)');
    expect(themeTokens.neutral[900].toLowerCase()).toBe('#f3effa');
    expect(background).toMatch(/^rgba\(.*, 0\.14\)$/);
  });

  it('reproduces the bug without the override, so the comparisons below can see a difference', () => {
    expect(drawnColours(themeWithoutOverride, 'standard', 'error').color).toMatch(/^rgba\(.*, 0\.14\)$/);
    expect(drawnColours(themeWithoutOverride, 'filled', 'error').background).toMatch(/^rgb\(/);
  });

  const untouched = VARIANTS.flatMap((variant) =>
    SEVERITIES.filter((severity) => variant !== 'standard' || !overridden.has(severity)).map(
      (severity) => [variant, severity] as const,
    ),
  );

  it.each(untouched)('leaves a %s %s Alert exactly as MUI drew it', (variant, severity) => {
    expect(drawnColours(darkTheme, variant, severity)).toEqual(drawnColours(themeWithoutOverride, variant, severity));
  });
});
