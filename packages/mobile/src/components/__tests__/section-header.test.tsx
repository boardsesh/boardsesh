// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// The resolved variant SectionHeader's caption treatment keys on. Both variants
// are sentence case now: Liquid Glass is footnote semibold in secondaryLabel (the
// native SwiftUI Form header, HIG Lists and tables), Material is titleSmall in
// onSurfaceVariant. The old Liquid Glass caption uppercased with a locale-blind
// `toUpperCase()`, dimmed to 0.6 and tracked out.
const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));

// react-native isn't satisfiable under jsdom; stub the surface SectionHeader and
// the colour modules touch. Platform.OS is deliberately 'android' to prove the
// casing no longer depends on the platform.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'android' },
  PlatformColor: (name: string) => name,
}));
type StubTextProps = { children?: ReactNode; color?: string; variant?: string; style?: unknown };
// Flattens the style array so the test can read the resolved weight/opacity.
function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}
vi.mock('../Text', () => ({
  Text: ({ children, color, variant, style }: StubTextProps) => {
    const flat = flatten(style);
    return createElement(
      'span',
      {
        'data-color': color,
        'data-variant': variant,
        'data-weight': String(flat.fontWeight),
        'data-opacity': String(flat.opacity),
        'data-tracking': String(flat.letterSpacing),
      },
      children,
    );
  },
}));
vi.mock('../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
// Stubbed so this file doesn't drag in react-native-reanimated (its ESM entry
// isn't resolvable under vitest). The chevron's own behaviour is covered in
// `section-header-disclosure.test.tsx`.
vi.mock('../SectionDisclosureChevron', () => ({ SectionDisclosureChevron: () => createElement('i', null) }));
vi.mock('../../providers/theme-provider', async () => {
  const { sectionCaptionByVariant } = await import('../../theme/variants/variant-tokens');
  return {
    useTheme: () => ({
      variant: ctrl.variant,
      brandColors: { primary: '#6D28D9' },
      systemColors: { secondaryLabel: 'secondaryLabel' },
      m3: { onSurfaceVariant: '#49454F' },
      sectionCaption: sectionCaptionByVariant[ctrl.variant],
    }),
  };
});

import { SectionHeader } from '../SectionHeader';

describe('SectionHeader caption', () => {
  it('is sentence-case footnote semibold in secondaryLabel on Liquid Glass, even on Android', () => {
    ctrl.variant = 'liquidGlass';
    const { getByText, queryByText } = render(createElement(SectionHeader, { title: 'Stats summary' }));
    const header = getByText('Stats summary');
    expect(queryByText('STATS SUMMARY')).toBeNull();
    expect(header.getAttribute('data-variant')).toBe('footnote');
    expect(header.getAttribute('data-weight')).toBe('600');
    expect(header.getAttribute('data-color')).toBe('secondaryLabel');
    // Hierarchy comes from the colour: no dimming, no tracking.
    expect(header.getAttribute('data-opacity')).toBe('1');
    expect(header.getAttribute('data-tracking')).toBe('0');
  });

  it('keeps a locale-specific title untouched (no locale-blind uppercasing)', () => {
    ctrl.variant = 'liquidGlass';
    const { getByText } = render(createElement(SectionHeader, { title: 'Straße istatistikleri' }));
    expect(getByText('Straße istatistikleri')).toBeTruthy();
  });

  it('is sentence-case titleSmall in onSurfaceVariant on Material', () => {
    ctrl.variant = 'material';
    const { getByText } = render(createElement(SectionHeader, { title: 'Stats summary' }));
    const header = getByText('Stats summary');
    expect(header.getAttribute('data-weight')).toBe('500');
    expect(header.getAttribute('data-color')).toBe('#49454F');
  });
});
