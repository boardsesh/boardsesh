// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({
      children,
      accessibilityElementsHidden,
      importantForAccessibility,
    }: {
      children?: ReactNode;
      accessibilityElementsHidden?: boolean;
      importantForAccessibility?: string;
    }) =>
      createElement(
        'div',
        {
          'data-accessibility-hidden':
            accessibilityElementsHidden === undefined ? undefined : String(accessibilityElementsHidden),
          'data-important-for-accessibility': importantForAccessibility,
        },
        children,
      ),
  },
  useAnimatedStyle: (factory: () => unknown) => factory(),
}));

import { SwipeableHeader } from '../SwipeableHeader';

describe('SwipeableHeader accessibility', () => {
  it('hides the mounted offscreen peek subtree from assistive technology', () => {
    const { getByText } = render(
      createElement(SwipeableHeader, {
        swipeTranslateX: { value: 0 } as never,
        viewportWidth: 390,
        current: createElement('span', null, 'Current header'),
        peek: createElement('span', null, 'Peek header'),
      }),
    );

    const peekLayer = getByText('Peek header').parentElement;
    expect(peekLayer?.getAttribute('data-accessibility-hidden')).toBe('true');
    expect(peekLayer?.getAttribute('data-important-for-accessibility')).toBe('no-hide-descendants');
    expect(getByText('Current header').parentElement?.hasAttribute('data-accessibility-hidden')).toBe(false);
  });
});
