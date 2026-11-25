// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A missing/rejected icon font must not prevent Android icons from rendering.
vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => {
  throw new Error('Icon font unavailable');
});
const native = vi.hoisted(() => ({ fontScale: 1 }));
vi.mock('react-native', () => ({
  useWindowDimensions: () => native,
  StyleSheet: { flatten: (style: unknown) => style },
}));
vi.mock('react-native-svg', () => ({
  default: ({
    accessible,
    focusable,
    style,
    testID,
    pointerEvents,
    importantForAccessibility,
    ...props
  }: Record<string, unknown>) =>
    createElement('svg', {
      ...props,
      'data-accessible': accessible,
      'data-focusable': focusable,
      'data-native-style': JSON.stringify(style),
      'data-testid': testID,
      'data-pointer-events': pointerEvents,
      'data-important-for-accessibility': importantForAccessibility,
    }),
  Path: (props: Record<string, unknown>) => createElement('path', props),
}));

import MaterialCommunityIcon from '../MaterialCommunityIcon.android';
import { iconMap } from '../icon-map';
import { materialIconPaths, materialIconViewBox } from '../material-icon-paths';

afterEach(() => {
  cleanup();
  native.fontScale = 1;
});

describe('Android Material icons without a font', () => {
  it('draws a bundled path at the requested size and colour', () => {
    const { container } = render(<MaterialCommunityIcon name="magnify" size={28} color="#123456" />);
    const icon = container.querySelector('svg');
    expect(icon?.getAttribute('viewBox')).toBe(materialIconViewBox);
    expect(icon?.getAttribute('width')).toBe('28');
    expect(icon?.getAttribute('height')).toBe('28');
    expect(icon?.getAttribute('data-accessible')).toBe('false');
    expect(icon?.getAttribute('data-focusable')).toBe('false');
    expect(container.querySelector('path')?.getAttribute('d')).toBe(materialIconPaths.magnify);
    expect(container.querySelector('path')?.getAttribute('fill')).toBe('#123456');
  });

  it('preserves Paper RTL styling and its control identifiers without font metrics', () => {
    const { container } = render(
      <MaterialCommunityIcon
        name="arrow-left"
        size={24}
        style={{ transform: [{ scaleX: -1 }], lineHeight: 24, backgroundColor: 'transparent' }}
        testID="paper-back"
        pointerEvents="none"
      />,
    );
    const icon = container.querySelector('svg');
    expect(icon?.getAttribute('data-testid')).toBe('paper-back');
    expect(icon?.getAttribute('data-pointer-events')).toBe('none');
    expect(JSON.parse(icon?.getAttribute('data-native-style') ?? '{}')).toEqual({
      transform: [{ scaleX: -1 }],
      backgroundColor: 'transparent',
    });
  });

  it('keeps icons fixed by default and caps opt-in font scaling', () => {
    native.fontScale = 3;
    const { container, rerender } = render(<MaterialCommunityIcon name="magnify" size={20} />);
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('20');
    rerender(<MaterialCommunityIcon name="magnify" size={20} allowFontScaling maxFontSizeMultiplier={1.5} />);
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('30');
    rerender(<MaterialCommunityIcon name="magnify" size={20} allowFontScaling maxFontSizeMultiplier={0} />);
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('60');
  });

  it('includes every semantic icon, so buttons never depend on font loading', () => {
    for (const { android } of Object.values(iconMap)) {
      expect(materialIconPaths, android).toHaveProperty(android);
      expect(materialIconPaths[android as keyof typeof materialIconPaths], android).toMatch(/^M/);
    }
  });

  it.each([
    'home',
    'home-outline',
    'record-circle',
    'record-circle-outline',
    'bookmark-multiple',
    'bookmark-multiple-outline',
    'account-circle',
    'account-circle-outline',
    'magnify',
    'checkbox-blank-outline',
    'checkbox-marked',
    'radiobox-blank',
    'radiobox-marked',
    'menu-down',
  ] as const)('draws the %s navigation or Paper icon without loading a font', (name) => {
    const { container } = render(<MaterialCommunityIcon name={name} size={24} color="purple" />);
    expect(container.querySelector('path')?.getAttribute('d')).toMatch(/^M/);
  });
});
