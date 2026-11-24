// Scoped kiosk theming. Server-safe: resolves the gym's brand accent (clamped
// for contrast) into CSS custom properties on a wrapper element, so every
// kiosk component styles itself with `var(--kiosk-*)` and never touches the
// gym's raw hex. The saved kiosk theme is applied during server rendering.

import React, { type CSSProperties, type ReactNode } from 'react';
import type { Gym } from '@boardsesh/shared-schema';
import { KIOSK_DEFAULT_THEME, type KioskTheme } from '@boardsesh/kiosk';
import { resolveKioskBrand, resolveKioskPalette } from '@/app/lib/kiosk/brand-contrast';
import styles from './kiosk-theme-scope.module.css';

export default function KioskThemeScope({
  gym,
  theme = KIOSK_DEFAULT_THEME,
  children,
}: {
  gym: Pick<Gym, 'brandAccentColor' | 'brandPrimaryColor'>;
  theme?: KioskTheme;
  children: ReactNode;
}) {
  const palette = resolveKioskPalette(theme);
  const brand = resolveKioskBrand(gym, theme);
  const brandVariables = {
    colorScheme: theme,
    '--kiosk-surface': palette.surface,
    '--kiosk-surface-raised': palette.raised,
    '--kiosk-text': palette.text,
    '--kiosk-text-muted': palette.muted,
    '--kiosk-border': palette.border,
    '--kiosk-overlay': palette.overlay,
    '--kiosk-warning': palette.warning,
    '--kiosk-on-warning': palette.onWarning,
    '--kiosk-accent': brand.accent,
    '--kiosk-accent-text': brand.accentText,
    '--kiosk-on-accent': brand.onAccent,
  } as CSSProperties;

  return (
    <div className={styles.scope} data-kiosk-theme={theme} style={brandVariables}>
      {children}
    </div>
  );
}
