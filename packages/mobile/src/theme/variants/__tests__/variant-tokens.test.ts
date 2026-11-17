// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// variant-tokens pulls in the theme colour modules (colors.ts / ios-colors.ts),
// which read Platform/PlatformColor at import. jsdom can't satisfy react-native,
// so stub the surface they touch — Platform.OS='android' takes colors.ts down its
// non-PlatformColor fallback path. Mirrors theme-provider.test.tsx.
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  PlatformColor: (name: string) => name,
}));

import { withAlpha } from '@boardsesh/velvet-tokens';
import { selectByVariant } from '../select-by-variant';
import {
  SELECTION_WASH_ALPHA,
  resolveActionColors,
  resolveChartColors,
  resolveSelectionColors,
  resolveStatusColors,
  resolveSurfaces,
  sectionCaptionByVariant,
  applySectionCaption,
} from '../variant-tokens';
import { makeThemeMock } from '../../../test/theme-mock';
import { selectedRowColors } from '../../../components/climb-list-row-colors';

describe('selectByVariant', () => {
  it('returns the value for the active variant', () => {
    expect(selectByVariant('liquidGlass', { liquidGlass: 'a', material: 'b' })).toBe('a');
    expect(selectByVariant('material', { liquidGlass: 'a', material: 'b' })).toBe('b');
  });
});

describe('resolveActionColors', () => {
  const inputs = {
    label: '#LABEL',
    accent: '#ACCENT',
    brandSuccess: '#SUCCESS',
    brandPrimary: '#PRIMARY',
    error: '#ERROR',
  };

  it('renders every role monochrome (label) on Liquid Glass', () => {
    const colors = resolveActionColors('liquidGlass', inputs);
    expect([colors.neutral, colors.success, colors.favorite, colors.accent, colors.pin]).toEqual([
      '#LABEL',
      '#LABEL',
      '#LABEL',
      '#LABEL',
      '#LABEL',
    ]);
  });

  it('tints each role by semantic meaning on Material', () => {
    const colors = resolveActionColors('material', inputs);
    expect(colors.neutral).toBe('#LABEL');
    expect(colors.success).toBe('#SUCCESS');
    expect(colors.accent).toBe('#ACCENT');
    expect(colors.pin).toBe('#PRIMARY');
    expect(colors.favorite).toBe('#ERROR');
  });

  it('uses the one adaptive error red for a favourited heart on both variants', () => {
    expect(resolveActionColors('liquidGlass', inputs).favoriteSelected).toBe('#ERROR');
    expect(resolveActionColors('material', inputs).favoriteSelected).toBe('#ERROR');
  });
});

describe('resolveChartColors', () => {
  it('returns plain-string palettes for every variant + scheme', () => {
    expect(typeof resolveChartColors('material', 'light').separator).toBe('string');
    expect(typeof resolveChartColors('material', 'dark').secondaryLabel).toBe('string');
    expect(typeof resolveChartColors('liquidGlass', 'light').tertiaryLabel).toBe('string');
    expect(typeof resolveChartColors('liquidGlass', 'dark').separator).toBe('string');
  });
});

describe('sectionCaptionByVariant / applySectionCaption', () => {
  it('keeps sentence case on both variants (HIG Lists and tables; M3 lists)', () => {
    expect(applySectionCaption('Today', sectionCaptionByVariant.liquidGlass).text).toBe('Today');
    expect(applySectionCaption('Today', sectionCaptionByVariant.material).text).toBe('Today');
  });

  it('neither dims nor tracks: secondaryLabel carries the hierarchy', () => {
    expect(applySectionCaption('x', sectionCaptionByVariant.liquidGlass).style).toEqual({
      opacity: 1,
      letterSpacing: 0,
    });
    expect(applySectionCaption('x', sectionCaptionByVariant.material).style).toEqual({ opacity: 1, letterSpacing: 0 });
  });

  it('still uppercases when a caption asks for it', () => {
    expect(applySectionCaption('Today', { uppercase: true, opacity: 1, letterSpacing: 0 }).text).toBe('TODAY');
  });

  it('declares every variant (exhaustive map)', () => {
    expect(Object.keys(sectionCaptionByVariant).sort()).toEqual(['liquidGlass', 'material']);
  });
});

describe('Velvet Send v2 roles', () => {
  const inputs = {
    background: '#PAGE',
    secondaryBackground: '#CARD',
    tertiaryBackground: '#TILE',
    groupedBackground: '#GROUPED_PAGE',
    secondaryGroupedBackground: '#GROUPED_CARD',
    tertiaryGroupedBackground: '#GROUPED_TILE',
    label: '#LABEL',
    secondaryLabel: '#SECONDARY_LABEL',
    accent: '#ACCENT',
    tertiaryFill: '#TERTIARY_FILL',
  };

  it('builds a plain and a grouped page ladder from the system backgrounds', () => {
    expect(resolveSurfaces(inputs)).toEqual({
      plain: { page: '#PAGE', card: '#CARD', tile: '#TILE' },
      grouped: { page: '#GROUPED_PAGE', card: '#GROUPED_CARD', tile: '#GROUPED_TILE' },
    });
  });

  it('keeps selection off violet text: label text, accent checkmark, a brand wash behind the row', () => {
    expect(resolveSelectionColors(inputs, '#5B22F2', 'light')).toEqual({
      text: '#LABEL',
      checkmark: '#ACCENT',
      fill: 'rgba(91, 34, 242, 0.13)',
    });
    expect(resolveSelectionColors(inputs, '#7855FF', 'dark').fill).toBe('rgba(120, 85, 255, 0.2)');
  });

  it.each(['light', 'dark'] as const)(
    'mixes the %s selection wash from the brand fill, never the tint',
    (colorScheme) => {
      const theme = makeThemeMock({ colorScheme });
      expect(theme.selection.fill).toBe(withAlpha(theme.brandColors.primaryFill, SELECTION_WASH_ALPHA[colorScheme]));
      expect(SELECTION_WASH_ALPHA).toEqual({ light: 0.13, dark: 0.2 });
    },
  );

  it('draws a status as a quiet tertiary fill with secondary text', () => {
    expect(resolveStatusColors(inputs)).toEqual({ fill: '#TERTIARY_FILL', label: '#SECONDARY_LABEL' });
  });

  it.each([
    ['liquidGlass', 'light'],
    ['liquidGlass', 'dark'],
    ['material', 'light'],
    ['material', 'dark'],
  ] as const)('resolves the roles from the %s %s ladder in the theme mock', (variant, colorScheme) => {
    const theme = makeThemeMock({ variant, colorScheme });
    expect(theme.surfaces.plain.page).toBe(theme.systemColors.background);
    expect(theme.surfaces.grouped.card).toBe(theme.systemColors.secondaryGroupedBackground);
    expect(theme.surfaces.grouped.tile).toBe(theme.systemColors.tertiaryGroupedBackground);
    expect(theme.selection.checkmark).toBe(theme.systemColors.accent);
    expect(theme.status.label).toBe(theme.systemColors.secondaryLabel);
  });

  it.each([
    ['liquidGlass', 'light'],
    ['liquidGlass', 'dark'],
    ['material', 'light'],
    ['material', 'dark'],
  ] as const)(
    'matches the current-climb wash in the Climbs list on %s %s, so moving the row onto the role changes nothing',
    (variant, colorScheme) => {
      const theme = makeThemeMock({ variant, colorScheme });
      expect(theme.selection.fill).toBe(selectedRowColors(theme.brandColors, colorScheme).fill);
    },
  );
});
