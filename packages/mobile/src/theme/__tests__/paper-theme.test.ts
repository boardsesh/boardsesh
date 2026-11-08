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

/** WCAG 2 contrast ratio between two `#RRGGBB` colours. */
function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const [red, green, blue] = [1, 3, 5].map((offset) => {
      const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((first, second) => second - first);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('buildPaperTheme', () => {
  it('maps the brand + Graphite surfaces onto MD3 roles (light)', () => {
    const theme = buildPaperTheme('light');
    expect(theme.colors.primary).toBe('#6D28D9');
    expect(theme.colors.onPrimary).toBe('#FFFFFF');
    expect(theme.colors.background).toBe('#F2F2F2'); // materialSurfaces.light.background
    expect(theme.colors.surface).toBe('#FFFFFF'); // secondaryBackground
    expect(theme.colors.error).toBe('#C81E1E');
    expect(theme.colors.onError).toBe('#FFFFFF');
    // Elevation levels 1–5 are the container steps low → highest, distinct and
    // falling in light.
    expect(theme.colors.elevation).toEqual({
      level0: 'transparent',
      level1: '#EAEAEA',
      level2: '#E4E4E4',
      level3: '#DFDFDF',
      level4: '#DCDCDC',
      level5: '#D9D9D9',
    });
    // Opaque violet tonal containers: the selected/current state keeps the brand.
    expect(theme.colors.primaryContainer).toBe('#EADDFF');
    expect(theme.colors.secondaryContainer).toBe('#E6DAF8');
    // Container ink is an explicit dark violet, not the grey `onSurface`.
    expect(theme.colors.onPrimaryContainer).toBe('#21005D');
    expect(theme.colors.onSecondaryContainer).toBe('#21005D');
    // `surfaceVariant` is a real toned container (filled text fields were
    // invisible when it aliased `#FFFFFF`).
    expect(theme.colors.surfaceVariant).toBe('#E4E4E4');
    // `outline` (form border) is a fixed grey, distinct from the faint divider.
    expect(theme.colors.outline).toBe('#7A7A7A');
    expect(theme.colors.outlineVariant).toBe('rgba(0, 0, 0, 0.12)');
    // The amber tertiary keeps its dark ink in both schemes.
    expect(theme.colors.onTertiary).toBe('#16111F');
  });

  it('uses the dark Graphite surfaces for the dark scheme', () => {
    const theme = buildPaperTheme('dark');
    expect(theme.colors.background).toBe('#0E0E0E');
    expect(theme.colors.surface).toBe('#1E1E1E');
    expect(theme.colors.surfaceVariant).toBe('#1A1A1A');
    expect(theme.colors.outline).toBe('#8A8A8A');
    expect(theme.colors.outlineVariant).toBe('rgba(255, 255, 255, 0.12)');
    expect(theme.colors.elevation).toEqual({
      level0: 'transparent',
      level1: '#161616',
      level2: '#1A1A1A',
      level3: '#262626',
      level4: '#2A2A2A',
      level5: '#2E2E2E',
    });
    expect(theme.colors.onTertiary).toBe('#16111F');
  });

  it('gives the dark error fill a dark ink, since white on #F87171 is 2.77:1', () => {
    const theme = buildPaperTheme('dark');
    expect(theme.colors.error).toBe('#F87171');
    expect(theme.colors.onError).toBe('#1B1B1B');
  });

  it('uses the foreground tint for dark primary, with dark ink on top', () => {
    const theme = buildPaperTheme('dark');
    // Not the fill-only #7C3AED: primary colours text (tab labels, text buttons).
    expect(theme.colors.primary).toBe('#A78BFA');
    expect(theme.colors.onPrimary).toBe('#2E1065');
    // `secondary` stays violet: it is the active nav label.
    expect(theme.colors.secondary).toBe('#A78BFA');
    expect(theme.colors.onSecondary).toBe('#2E1065');
    // Opaque tonal containers with a light violet ink.
    expect(theme.colors.primaryContainer).toBe('#4F378B');
    expect(theme.colors.secondaryContainer).toBe('#3C2467');
    expect(theme.colors.onPrimaryContainer).toBe('#EADDFF');
    expect(theme.colors.onSecondaryContainer).toBe('#EADDFF');
  });

  // The Climbs bar's wall pill fills with tertiaryContainer, so it must be the
  // amber accent's container (not Paper's baseline pink) with AA-legible ink.
  it.each([
    ['light', '#FFDBCA', '#341100'],
    ['dark', '#773300', '#FFDBCA'],
  ] as const)('gives the amber tertiary a legible tonal container (%s)', (scheme, container, ink) => {
    const theme = buildPaperTheme(scheme);
    expect(theme.colors.tertiary).toBe('#FF8A3D');
    expect(theme.colors.tertiaryContainer).toBe(container);
    expect(theme.colors.onTertiaryContainer).toBe(ink);
    expect(contrastRatio(theme.colors.onTertiaryContainer, theme.colors.tertiaryContainer)).toBeGreaterThanOrEqual(4.5);
  });

  it('passes a provided dynamic palette straight through (Material You hook)', () => {
    const dynamic = { primary: '#123456' } as unknown as Parameters<typeof buildPaperTheme>[1];
    const theme = buildPaperTheme('light', dynamic);
    expect(theme.colors.primary).toBe('#123456');
  });
});
