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
vi.mock('../../DrawerHeader', async () => {
  const { View } = await import('react-native');
  return { DrawerHeaderPinnedLeading: View };
});

import { HEADER_SWAP_DRIFT, SwipeableHeader, headerSlotFrame } from '../SwipeableHeader';

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
    current: header(String(centerPage)),
    previous: header(String(centerPage - 1)),
    next: header(String(centerPage + 1)),
    accessibilityStandIn: standIn,
  });
  const { getByTestId, rerender } = render(createElement(SwipeableHeader, props(0)));
  return {
    frame: (anchor: number, offset: number, centerPage = 0) => {
      pager.anchorPage.value = anchor;
      pager.translateX.value = offset;
      rerender(createElement(SwipeableHeader, props(centerPage)));
    },
    style: (page: number) =>
      JSON.parse(getByTestId(`header-${page}`).parentElement!.dataset.style!)[1] as {
        opacity: number;
        transform: { translateX: number }[];
      },
  };
}

const visibleAt = (translateX: number) => ({ opacity: 1, transform: [{ translateX }] });
const close = (actual: { opacity: number; transform: { translateX: number }[] }, opacity: number, offset: number) => {
  expect(actual.opacity).toBeCloseTo(opacity, 6);
  expect(actual.transform[0].translateX).toBeCloseTo(offset, 6);
};

describe('headerSlotFrame', () => {
  it('rests in place at full strength', () => {
    expect(headerSlotFrame(0, HEADER_SWAP_DRIFT)).toEqual({ opacity: 1, offset: 0 });
  });

  it('fades the outgoing header out over the first half while it drifts away', () => {
    expect(headerSlotFrame(-0.25, 16)).toEqual({ opacity: 0.5, offset: -8 });
    expect(headerSlotFrame(-0.5, 16)).toEqual({ opacity: 0, offset: -16 });
    expect(headerSlotFrame(-0.9, 16)).toEqual({ opacity: 0, offset: -16 });
  });

  it('fades the incoming header in over the second half while it drifts into place', () => {
    expect(headerSlotFrame(0.5, 16)).toEqual({ opacity: 0, offset: 16 });
    expect(headerSlotFrame(0.25, 16)).toEqual({ opacity: 0.5, offset: 8 });
  });
});

describe('one header at a time', () => {
  it.each([-1, 1])(
    'never draws a name beside the other climb’s grade, at any point of a swipe in direction %s',
    (direction) => {
      // Each slot is one whole header (name, grade, stats). The old screen-wide
      // slide put the outgoing grade beside the incoming name for 2–3 frames.
      pager.slideWidth.value = 300;
      const { frame, style } = mountHeaderFrames();
      for (let step = 0; step <= 60; step += 1) {
        frame(0, -direction * step * 5);
        const outgoing = style(0).opacity;
        const incoming = style(direction).opacity;
        expect(outgoing === 0 || incoming === 0).toBe(true);
        expect(style(-direction).opacity).toBe(0);
      }
    },
  );
});

describe('continuous title motion', () => {
  it.each([false, true])(
    'follows forward, backward, reversal and cancellation with stationary board %s',
    (stationary) => {
      pager.stationaryMotion.value = stationary;
      pager.slideWidth.value = 300;
      const { frame, style } = mountHeaderFrames();
      for (const offset of [-30, -75, -150, -225, -150, -75, 0, 75, 150, 75, 0]) {
        frame(0, offset);
        const progress = offset / 300;
        close(
          style(0),
          Math.max(0, 1 - Math.abs(progress) * 2),
          Math.sign(progress) * 16 * Math.min(1, Math.abs(progress) * 2),
        );
        if (offset < 0) {
          const incoming = headerSlotFrame(1 + progress, 16);
          close(style(1), incoming.opacity, incoming.offset);
          expect(style(-1).opacity).toBe(0);
        } else if (offset > 0) {
          const incoming = headerSlotFrame(-1 + progress, 16);
          close(style(-1), incoming.opacity, incoming.offset);
          expect(style(1).opacity).toBe(0);
        } else {
          expect(style(-1).opacity).toBe(0);
          expect(style(1).opacity).toBe(0);
        }
      }
    },
  );

  it.each([-1, 1])(
    'lands the incoming title where it rests, and the landing moves nothing, in direction %s',
    (direction) => {
      pager.stationaryMotion.value = true;
      pager.slideWidth.value = 300;
      const { frame, style } = mountHeaderFrames();
      frame(0, -direction * 300);
      expect(style(direction)).toEqual(visibleAt(0));
      // JS catches up before the UI anchor lands; neither event moves the title.
      frame(0, -direction * 300, direction);
      expect(style(direction)).toEqual(visibleAt(0));
      frame(direction, 0, direction);
      expect(style(direction)).toEqual(visibleAt(0));
    },
  );

  it('never fades a third climb in when a drag runs past the board’s width', () => {
    pager.slideWidth.value = 300;
    const { frame, style } = mountHeaderFrames();
    frame(0, -360);
    expect(style(1)).toEqual(visibleAt(0));
    expect(style(0).opacity).toBe(0);
  });

  it.each([-1, 1])('preserves both title frames when a new swipe takes over a fling in direction %s', (direction) => {
    pager.stationaryMotion.value = true;
    pager.slideWidth.value = 300;
    const { frame, style } = mountHeaderFrames();
    frame(0, -direction * 225);
    const outgoing = style(0);
    const incoming = style(direction);
    // landFling(true) carries the remaining board offset into the new anchor.
    frame(direction, direction * 75, direction);
    close(style(0), outgoing.opacity, outgoing.transform[0].translateX);
    close(style(direction), incoming.opacity, incoming.transform[0].translateX);
  });

  it('keeps the committed stationary-board title still under Reduce Motion', () => {
    pager.stationaryMotion.value = true;
    preferences.reduceMotion = true;
    const { frame, style } = mountHeaderFrames();
    frame(0, -290);
    expect(style(0)).toEqual(visibleAt(0));
    expect(style(1).opacity).toBe(0);
    frame(0, -390, 1);
    expect(style(0)).toEqual(visibleAt(0));
    expect(style(1).opacity).toBe(0);
    frame(1, 0, 1);
    expect(style(1)).toEqual(visibleAt(0));
    expect(style(0).opacity).toBe(0);
  });

  it('dissolves in place under Reduce Motion beside a board that slides', () => {
    preferences.reduceMotion = true;
    const { frame, style } = mountHeaderFrames();
    frame(0, -97.5);
    close(style(0), 0.5, 0);
    frame(0, -292.5);
    close(style(1), 0.5, 0);
  });
});

describe('SwipeableHeader accessibility', () => {
  it('keeps one screen-reader element across a climb change and hides every drawn header', () => {
    const { getByTestId, rerender } = render(
      createElement(SwipeableHeader, {
        pager,
        centerPage: 0,
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

  it('pins the leading chip over the slots, under the stand-in, through a climb change', () => {
    const chip = createElement('div', { 'data-testid': 'chip' });
    const props = (centerPage: number) => ({
      pager,
      centerPage,
      previous: header(String(centerPage - 1)),
      current: header(String(centerPage)),
      next: header(String(centerPage + 1)),
      leading: chip,
      accessibilityStandIn: standIn,
    });
    const { getByTestId, rerender } = render(createElement(SwipeableHeader, props(0)));
    const pinned = getByTestId('chip');
    const layer = pinned.parentElement!;

    rerender(createElement(SwipeableHeader, props(1)));

    // Same node: the chip neither fades nor remounts when the climb changes.
    expect(getByTestId('chip')).toBe(pinned);
    // Not inside any slot, so it does not move or fade with one.
    for (const name of ['0', '1', '2']) {
      expect(getByTestId(`header-${name}`).parentElement!.contains(pinned)).toBe(false);
    }
    // Hidden like the slots; the stand-in, still last, carries its action.
    expect(layer.dataset.elementsHidden).toBe('true');
    expect(layer.parentElement!.lastElementChild).toBe(getByTestId('stand-in'));
  });
});
