// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { SwipePager } from '../use-swipe-pager';

type ViewProps = {
  children?: ReactNode;
  testID?: string;
  accessibilityElementsHidden?: boolean;
  importantForAccessibility?: string;
  pointerEvents?: string;
};

// react-native isn't satisfiable under jsdom. Views become divs that surface the
// accessibility props, which is all this suite asserts on.
vi.mock('react-native', () => {
  const View = ({
    children,
    testID,
    accessibilityElementsHidden,
    importantForAccessibility,
    pointerEvents,
  }: ViewProps) =>
    createElement(
      'div',
      {
        'data-testid': testID,
        'data-elements-hidden': accessibilityElementsHidden === true ? 'true' : undefined,
        'data-important-for-accessibility': importantForAccessibility,
        'data-pointer-events': pointerEvents,
      },
      children,
    );
  return { View, StyleSheet: { create: (styles: unknown) => styles } };
});
vi.mock('react-native-reanimated', async () => {
  const { View } = await import('react-native');
  return { default: { View }, useAnimatedStyle: () => ({}) };
});

import { SwipeableHeader } from '../SwipeableHeader';

const pager = {
  anchorPage: { value: 0 },
  translateX: { value: 0 },
  slideWidth: { value: 390 },
} as unknown as SwipePager;

const header = (name: string) => createElement('span', { 'data-testid': `header-${name}` }, name);
const standIn = createElement('div', { 'data-testid': 'stand-in' });

describe('SwipeableHeader accessibility', () => {
  it('keeps one screen-reader element across a climb change and hides every drawn header', () => {
    const { getByTestId, rerender } = render(
      createElement(SwipeableHeader, {
        pager,
        centerPage: 0,
        viewportWidth: 390,
        previous: null,
        current: header('A'),
        next: header('B'),
        accessibilityStandIn: standIn,
      }),
    );
    const firstStandIn = getByTestId('stand-in');

    // Swipe to the next climb: B becomes current, C slides in as the next one.
    rerender(
      createElement(SwipeableHeader, {
        pager,
        centerPage: 1,
        viewportWidth: 390,
        previous: header('A'),
        current: header('B'),
        next: header('C'),
        accessibilityStandIn: standIn,
      }),
    );

    // Same node, so focus that sat on it before the climb changed stays on it.
    expect(getByTestId('stand-in')).toBe(firstStandIn);
    // After every slot: on top, where Android's explore-by-touch reaches it
    // before the hidden current header, and never reordered against a slot.
    expect(firstStandIn.parentElement?.lastElementChild).toBe(firstStandIn);

    for (const name of ['A', 'B', 'C']) {
      const slot = getByTestId(`header-${name}`).parentElement!;
      expect(slot.dataset.elementsHidden).toBe('true');
      expect(slot.dataset.importantForAccessibility).toBe('no-hide-descendants');
    }
  });

  it('still lets sighted taps reach the current header only', () => {
    const { getByTestId } = render(
      createElement(SwipeableHeader, {
        pager,
        centerPage: 0,
        viewportWidth: 390,
        previous: header('A'),
        current: header('B'),
        next: header('C'),
        accessibilityStandIn: standIn,
      }),
    );
    expect(getByTestId('header-B').parentElement!.dataset.pointerEvents).toBe('auto');
    expect(getByTestId('header-A').parentElement!.dataset.pointerEvents).toBe('none');
    expect(getByTestId('header-C').parentElement!.dataset.pointerEvents).toBe('none');
  });
});
