// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// colors.ts touches Platform/PlatformColor at import; Android skips the iOS branch.
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, PlatformColor: (name: string) => name }));
// react-native-paper imports react-native at load; stub the MD3 base themes.
vi.mock('react-native-paper', () => ({
  MD3LightTheme: { dark: false, colors: { primary: 'base', elevation: {} } },
  MD3DarkTheme: { dark: true, colors: { primary: 'base', elevation: {} } },
}));

import { buildPaperTheme } from '../paper-theme';

describe('buildPaperTheme', () => {
  it('maps the brand + material surfaces onto MD3 roles (light)', () => {
    const theme = buildPaperTheme('light');
    expect(theme.colors.primary).toBe('#6D28D9');
    expect(theme.colors.onPrimary).toBe('#FFFFFF');
    expect(theme.colors.background).toBe('#F3EFFA'); // materialSurfaces.light.background
    expect(theme.colors.surface).toBe('#FFFFFF'); // secondaryBackground
    expect(theme.colors.error).toBe('#C81E1E');
    // The five elevation levels are now DISTINCT, monotonic surface-tint tones
    // (not all collapsed onto one `elevatedSurface`), so Paper's elevated
    // components tier instead of looking identical.
    const { level0, level1, level2, level3, level4, level5 } = theme.colors.elevation;
    expect(level0).toBe('transparent');
    expect(new Set([level1, level2, level3, level4, level5]).size).toBe(5);
    // The two grade stat tiles use the brand-violet primary/secondary containers
    // (not the vestigial amber tertiary), so they read as one tonal family.
    expect(theme.colors.primaryContainer).toContain('109, 40, 217'); // brand violet #6D28D9
    expect(theme.colors.secondaryContainer).toContain('109, 40, 217');
    // Container ink is an explicit dark violet — not the near-white `onSurface`,
    // which was illegible on the (dark-scheme) container.
    expect(theme.colors.onPrimaryContainer).toBe('#21005D');
    expect(theme.colors.onSecondaryContainer).toBe('#21005D');
    // `surfaceVariant` is a real toned container (filled text fields were
    // invisible when it aliased `#FFFFFF`).
    expect(theme.colors.surfaceVariant).not.toBe('#FFFFFF');
    // `outline` (form border) is distinct from `outlineVariant` (faint divider).
    expect(theme.colors.outline).not.toBe(theme.colors.outlineVariant);
  });

  it('uses the dark tonal surfaces for the dark scheme', () => {
    const theme = buildPaperTheme('dark');
    expect(theme.colors.background).toBe('#15101E');
    expect(theme.colors.surface).toBe('#221A33');
  });

  it('passes a provided dynamic palette straight through (Material You hook)', () => {
    const dynamic = { primary: '#123456' } as unknown as Parameters<typeof buildPaperTheme>[1];
    const theme = buildPaperTheme('light', dynamic);
    expect(theme.colors.primary).toBe('#123456');
  });
});
