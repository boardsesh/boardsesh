import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KIOSK_THEMES } from '@boardsesh/kiosk';
import { resolveKioskPalette } from '@/app/lib/kiosk/brand-contrast';
import KioskThemeScope from '../kiosk-theme-scope';

describe('KioskThemeScope server rendering', () => {
  it.each(KIOSK_THEMES)('includes the %s theme and complete palette before hydration', (theme) => {
    const html = renderToStaticMarkup(
      <KioskThemeScope gym={{ brandAccentColor: '#FDCF07' }} theme={theme}>
        <img src="/gym-logo.png" alt="Gym" />
      </KioskThemeScope>,
    );
    const container = document.createElement('div');
    container.innerHTML = html;
    const scope = container.querySelector<HTMLElement>('[data-kiosk-theme]')!;
    const palette = resolveKioskPalette(theme);
    expect(scope.dataset.kioskTheme).toBe(theme);
    expect(scope.style.colorScheme).toBe(theme);
    expect(scope.style.getPropertyValue('--kiosk-surface')).toBe(palette.surface);
    expect(scope.style.getPropertyValue('--kiosk-surface-raised')).toBe(palette.raised);
    expect(scope.style.getPropertyValue('--kiosk-text')).toBe(palette.text);
    expect(scope.style.getPropertyValue('--kiosk-text-muted')).toBe(palette.muted);
    expect(scope.style.getPropertyValue('--kiosk-overlay')).toBe(palette.overlay);
    const logo = scope.querySelector('img')!;
    expect(logo.getAttribute('src')).toBe('/gym-logo.png');
    expect(logo.getAttribute('style')).toBeNull();
  });

  it('keeps existing embeds and unavailable-config retry screens dark by default', () => {
    const html = renderToStaticMarkup(<KioskThemeScope gym={{}}>Display</KioskThemeScope>);
    expect(html).toContain('data-kiosk-theme="dark"');
  });
});
