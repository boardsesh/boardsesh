import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useTheme } from '@mui/material/styles';
import AppThemeProvider from '../app-theme-provider';
import { themeTokens } from '@/app/theme/theme-config';

function ThemeProbe() {
  const theme = useTheme();
  return (
    <>
      <span data-testid="mode">{theme.palette.mode}</span>
      <span data-testid="primary">{theme.palette.primary.main}</span>
      <span data-testid="fill">{theme.palette.primaryFill.main}</span>
    </>
  );
}

describe('AppThemeProvider', () => {
  it('renders its children', () => {
    render(
      <AppThemeProvider>
        <p>hello</p>
      </AppThemeProvider>,
    );
    expect(screen.getByText('hello')).toBeTruthy();
  });

  // The only thing that would catch the provider being wired to a stale or
  // undefined theme object after the light scheme came out.
  it('hands children the dark theme', () => {
    render(
      <AppThemeProvider>
        <ThemeProbe />
      </AppThemeProvider>,
    );
    expect(screen.getByTestId('mode').textContent).toBe('dark');
    expect(screen.getByTestId('primary').textContent).toBe(themeTokens.colors.primary);
    // The foreground/fill split is load-bearing: white on the lifted foreground
    // violet is 2.5:1, so a filled button must use the darker fill.
    expect(screen.getByTestId('fill').textContent).toBe(themeTokens.colors.primaryFill);
    expect(themeTokens.colors.primary).not.toBe(themeTokens.colors.primaryFill);
    expect(themeTokens.colors.onPrimary).toBe('#FFFFFF');
  });
});
