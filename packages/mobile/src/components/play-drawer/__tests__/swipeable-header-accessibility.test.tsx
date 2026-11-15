// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { SwipePager } from '../use-swipe-pager';

type ViewProps = {
  children?: ReactNode;
  testID?: string;
  accessibilityElementsHidden?: boolean;
  importantForAccessibility?: string;
  pointerEvents?: string;
  style?: unknown;
};

const preferences = vi.hoisted(() => ({ reduceMotion: false }));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => preferences.reduceMotion }));

// react-native isn't satisfiable under jsdom. Views become divs that surface the
// accessibility props, which is all this suite asserts on.
vi.mock('react-native', () => {
  const View = ({
    children,
    testID,
    accessibilityElementsHidden,
    importantForAccessibility,
    pointerEvents,
    style,
  }: ViewProps) =>
    createElement(
      'div',
      {
        'data-testid': testID,
        'data-elements-hidden': accessibilityElementsHidden === true ? 'true' : undefined,
        'data-important-for-accessibility': importantForAccessibility,
        'data-pointer-events': pointerEvents,
        'data-style': JSON.stringify(style),
      },
      children,
    );
  return { View, StyleSheet: { create: (styles: unknown) => styles } };
});
vi.mock('react-native-reanimated', async () => {
  const { View } = await import('react-native');
  return { default: { View }, useAnimatedStyle: (factory: () => unknown) => factory() };
});

import { SwipeableHeader, stationaryHeaderStyle } from '../SwipeableHeader';

const pager = {
  anchorPage: { value: 0 },
  translateX: { value: 0 },
  slideWidth: { value: 390 },
  stationaryMotion: { value: false },
} as unknown as SwipePager;

beforeEach(() => {
  pager.anchorPage.value = 0;
  pager.translateX.value = 0;
  pager.stationaryMotion.value = false;
  preferences.reduceMotion = false;
});

const header = (name: string) => createElement('span', { 'data-testid': `header-${name}` }, name);
const standIn = createElement('div', { 'data-testid': 'stand-in' });

describe('stationary title motion', () => {
  it('uses short reversible travel and never displays overlapping names', () => {
    expect(stationaryHeaderStyle(0, 0, 0, false)).toEqual({ opacity: 1, transform: [{ translateX: 0 }] });
    const forward = stationaryHeaderStyle(0, 0.25, 0, false);
    const backward = stationaryHeaderStyle(0, -0.25, 0, false);
    expect(forward.opacity).toBeCloseTo(0.5);
    expect(backward.opacity).toBe(forward.opacity);
    expect(forward.transform[0].translateX).toBe(-6);
    expect(backward.transform[0].translateX).toBe(6);
    for (const progress of [0, 0.25, 0.45, 0.5, 0.55, 0.75, 1]) {
      const outgoing = stationaryHeaderStyle(0, progress, 0, false);
      const incoming = stationaryHeaderStyle(1, progress, 0, false);
      expect(outgoing.opacity > 0 && incoming.opacity > 0).toBe(false);
    }
    // A fling rebase changes the anchor, not the absolute progress or appearance.
    expect(stationaryHeaderStyle(1, 1, 0, false)).toEqual(stationaryHeaderStyle(1, 1, 1, false));
    expect(stationaryHeaderStyle(0, 0, 0, false).opacity).toBe(1);
  });

  it('limits stationary travel while preserving the existing carousel slide', () => {
    pager.translateX.value = -97.5;
    const props = {
      pager,
      centerPage: 0,
      viewportWidth: 390,
      current: header('A'),
      previous: null,
      next: header('B'),
      accessibilityStandIn: standIn,
    };
    const { getByTestId, rerender } = render(createElement(SwipeableHeader, props));
    const style = () =>
      JSON.parse(getByTestId('header-A').parentElement!.dataset.style!)[1] as {
        opacity: number;
        transform: { translateX: number }[];
      };
    expect(style().transform[0].translateX).toBe(-97.5);
    pager.stationaryMotion.value = true;
    rerender(createElement(SwipeableHeader, { ...props, current: header('A') }));
    expect(style().transform[0].translateX).toBe(-6);
    expect(style().opacity).toBeCloseTo(0.5);
  });

  it('keeps the exact anchor title stationary under Reduce Motion', () => {
    expect(stationaryHeaderStyle(0, 0.75, 0, true)).toEqual({ opacity: 1, transform: [{ translateX: 0 }] });
    expect(stationaryHeaderStyle(1, 0.75, 0, true).opacity).toBe(0);
    expect(stationaryHeaderStyle(1, 1, 1, true)).toEqual({ opacity: 1, transform: [{ translateX: 0 }] });
  });
});

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
