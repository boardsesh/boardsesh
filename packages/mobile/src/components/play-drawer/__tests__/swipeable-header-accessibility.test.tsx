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
// accessibility props and the animated styles for sampled pager frames.
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

import { SwipeableHeader } from '../SwipeableHeader';

const pager = {
  anchorPage: { value: 0 },
  translateX: { value: 0 },
  slideWidth: { value: 390 },
  stationaryMotion: { value: false },
} as unknown as SwipePager;

beforeEach(() => {
  pager.anchorPage.value = 0;
  pager.translateX.value = 0;
  pager.slideWidth.value = 390;
  pager.stationaryMotion.value = false;
  preferences.reduceMotion = false;
});

const header = (name: string) => createElement('span', { 'data-testid': `header-${name}` }, name);
const standIn = createElement('div', { 'data-testid': 'stand-in' });

function mountHeaderFrames() {
  const props = (centerPage: number) => ({
    pager,
    centerPage,
    viewportWidth: 390,
    current: header(String(centerPage)),
    previous: header(String(centerPage - 1)),
    next: header(String(centerPage + 1)),
    accessibilityStandIn: standIn,
  });
  const { getByTestId, rerender } = render(createElement(SwipeableHeader, props(0)));
  return {
    frame(anchor: number, offset: number, centerPage = 0) {
      pager.anchorPage.value = anchor;
      pager.translateX.value = offset;
      rerender(createElement(SwipeableHeader, props(centerPage)));
    },
    style(page: number) {
      return JSON.parse(getByTestId(`header-${page}`).parentElement!.dataset.style!)[1] as {
        opacity: number;
        transform: { translateX: number }[];
      };
    },
  };
}

const visibleAt = (translateX: number) => ({ opacity: 1, transform: [{ translateX }] });

describe('continuous title motion', () => {
  it.each([false, true])(
    'follows forward, backward, reversal and cancellation with stationary board %s',
    (stationary) => {
      pager.stationaryMotion.value = stationary;
      // The board fits inside a wider header; travel uses the same page progress.
      pager.slideWidth.value = 300;
      const { frame, style } = mountHeaderFrames();
      for (const offset of [-30, -75, -150, -225, -150, -75, 0, 75, 150, 75, 0]) {
        frame(0, offset);
        expect(style(0)).toEqual(visibleAt(offset * 1.3));
        if (offset < 0) {
          expect(style(1)).toEqual(visibleAt(390 + offset * 1.3));
          expect(style(-1).opacity).toBe(0);
        } else if (offset > 0) {
          expect(style(-1)).toEqual(visibleAt(-390 + offset * 1.3));
          expect(style(1).opacity).toBe(0);
        } else {
          expect(style(-1).opacity).toBe(0);
          expect(style(1).opacity).toBe(0);
        }
      }
    },
  );

  it.each([-1, 1])('keeps incoming title settled through fling overshoot and rebase in direction %s', (direction) => {
    pager.stationaryMotion.value = true;
    pager.slideWidth.value = 300;
    const { frame, style } = mountHeaderFrames();
    frame(0, -direction * 300);
    expect(style(direction)).toEqual(visibleAt(0));
    // The outgoing board clears the screen, beyond the narrower board width.
    // JS catches up before the UI anchor lands; neither event moves the title.
    frame(0, -direction * 360, direction);
    expect(style(direction)).toEqual(visibleAt(0));
    frame(0, -direction * 422, direction);
    expect(style(direction)).toEqual(visibleAt(0));
    frame(direction, 0, direction);
    expect(style(direction)).toEqual(visibleAt(0));
  });

  it.each([-1, 1])(
    'preserves both title positions when a new swipe takes over a fling in direction %s',
    (direction) => {
      pager.stationaryMotion.value = true;
      pager.slideWidth.value = 300;
      const { frame, style } = mountHeaderFrames();
      frame(0, -direction * 225);
      const outgoing = style(0);
      const incoming = style(direction);
      // landFling(true) carries the remaining board offset into the new anchor.
      frame(direction, direction * 75, direction);
      expect(style(0)).toEqual(outgoing);
      expect(style(direction)).toEqual(incoming);
    },
  );

  it('keeps the committed stationary-board title still under Reduce Motion', () => {
    pager.stationaryMotion.value = true;
    preferences.reduceMotion = true;
    const { frame, style } = mountHeaderFrames();
    frame(0, -290);
    expect(style(0)).toEqual(visibleAt(0));
    expect(style(1).opacity).toBe(0);
    frame(0, -422, 1);
    expect(style(0)).toEqual(visibleAt(0));
    expect(style(1).opacity).toBe(0);
    frame(1, 0, 1);
    expect(style(1)).toEqual(visibleAt(0));
    expect(style(0).opacity).toBe(0);
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
