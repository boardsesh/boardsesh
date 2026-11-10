import { describe, expect, it } from 'vite-plus/test';
import { STANDARD_ALERT_SEVERITIES, darkTheme } from '../mui-theme';
import { themeTokens } from '../theme-config';

type AlertVariant = { props: { variant: string; severity: string }; style: { color: string; backgroundColor: string } };

/**
 * MUI's standard Alert lightens `palette.<status>.light` into its text colour. Ours
 * is the translucent status tint, so without the override the message rendered at
 * 14% alpha: a form error on /auth/login or /oauth/sign-in was unreadable.
 */
describe('standard Alert text', () => {
  const root = darkTheme.components?.MuiAlert?.styleOverrides?.root as { variants?: AlertVariant[] } | undefined;

  it.each(STANDARD_ALERT_SEVERITIES)('draws %s messages in opaque, max-contrast ink on the status tint', (severity) => {
    const variant = root?.variants?.find(
      (candidate) => candidate.props.variant === 'standard' && candidate.props.severity === severity,
    );
    expect(variant?.style.color).toBe(themeTokens.neutral[900]);
    expect(variant?.style.color).toMatch(/^#[0-9A-F]{6}$/i);
    expect(variant?.style.backgroundColor).toBe(themeTokens.colors[`${severity}Bg`]);
  });
});
