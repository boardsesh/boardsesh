// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, useLayoutEffect, useRef, useEffect, useState, type ReactNode } from 'react';

// #7253: the player's climb name flickered and never scrolled. The marquee picks
// how to show a name from how wide its clip is, so the clip's width must not
// depend on the copy it picked. This file lays the clip out the way Yoga does
// in the play-drawer header, where the name row hugs its content: the clip is as
// wide as its widest in-flow child, bounded by the room the header has. And it
// reports a new width the way onLayout does: only when the width changes.
const model = vi.hoisted(() => ({
  /** The room the header gives the name. */
  room: 0,
  /** The name's full single-line width, as the off-screen measurer reports it. */
  contentWidth: 0,
  /**
   * The shrunk copy's own width. iOS and Android fit `adjustsFontSizeToFit`
   * text a little inside the room it was measured against (iOS within 1%,
   * Android to a whole pixel font size), never exactly to it.
   */
  fittedWidth: 0,
  /** Every width the clip reported, in order. */
  clipReports: [] as number[],
}));
const reanim = vi.hoisted(() => ({ withRepeat: vi.fn() }));

// A layout loop reports forever. Stop feeding it well before React's own
// nested-update limit, so the test fails on its assertion, not on React.
const MAX_CLIP_REPORTS = 12;

function flattenStyle(style: unknown): Record<string, unknown> {
  return Object.assign({}, ...[style].flat(10).filter(Boolean));
}

/** How wide a laid-out node wants to be, as its hugging parent sees it. */
function intrinsicWidth(node: Element): number {
  const { dataset } = node as HTMLElement;
  if (dataset.absolute) return 0; // out of flow: the measurer
  if (dataset.width) return Number(dataset.width);
  if (dataset.shrink) return model.fittedWidth;
  if (dataset.text) return model.contentWidth;
  return Math.max(0, ...Array.from(node.children).map(intrinsicWidth));
}

vi.mock('react-native', () => ({
  View: function View({
    children,
    onLayout,
    style,
  }: {
    children?: ReactNode;
    onLayout?: (event: unknown) => void;
    style?: unknown;
  }) {
    const ref = useRef<HTMLDivElement>(null);
    const lastWidth = useRef<number | null>(null);
    // After every commit, like the native layout pass: the clip takes its
    // widest in-flow child's width, bounded by the room.
    useLayoutEffect(() => {
      if (!onLayout || !ref.current) return;
      const width = Math.min(model.room, intrinsicWidth(ref.current));
      if (width === lastWidth.current) return;
      lastWidth.current = width;
      model.clipReports.push(width);
      if (model.clipReports.length > MAX_CLIP_REPORTS) return;
      onLayout({ nativeEvent: { layout: { width, height: 20 } } });
    });
    const flat = flattenStyle(style);
    return createElement(
      'div',
      {
        ref,
        'data-width': typeof flat.width === 'number' ? String(flat.width) : undefined,
        'data-absolute': flat.position === 'absolute' ? 'true' : undefined,
      },
      children,
    );
  },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-animated': 'true' }, children),
  },
  Easing: { inOut: () => () => 0, ease: () => 0 },
  cancelAnimation: () => {},
  useAnimatedStyle: (fn: () => unknown) => fn(),
  useSharedValue: (value: unknown) => ({ value }),
  withRepeat: (...args: unknown[]) => reanim.withRepeat(...args),
  withSequence: (...values: unknown[]) => values,
  withTiming: (value: unknown) => value,
}));

vi.mock('@boardsesh/play-view', () => ({ computeMarqueeDurationS: () => 10 }));

// The measurer is the only Text with onLayout: it reports the full name's width.
vi.mock('../Text', () => ({
  Text: ({
    children,
    adjustsFontSizeToFit,
    onLayout,
    style,
  }: {
    children?: ReactNode;
    adjustsFontSizeToFit?: boolean;
    onLayout?: (event: unknown) => void;
    style?: unknown;
  }) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: model.contentWidth, height: 16 } } });
    }, [onLayout]);
    const flat = flattenStyle(style);
    return createElement(
      'span',
      {
        'data-text': 'true',
        'data-width': typeof flat.width === 'number' ? String(flat.width) : undefined,
        'data-shrink': adjustsFontSizeToFit ? 'true' : undefined,
      },
      children,
    );
  },
}));

const reduceMotion = vi.hoisted(() => ({ value: false }));
vi.mock('../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => reduceMotion.value }));

import { MarqueeText } from '../MarqueeText';

const NAME = 'The Brain from the Other Side';

describe('MarqueeText settles on one copy (#7253)', () => {
  beforeEach(() => {
    reduceMotion.value = false;
    model.room = 0;
    model.contentWidth = 0;
    model.fittedWidth = 0;
    model.clipReports = [];
    reanim.withRepeat.mockClear();
  });

  // A name 10.7% too long: at 90% it fits, so it shrinks into place. The shrunk
  // copy alone is 3pt narrower than the room, which is under 90% of the name.
  // If the clip hugs that copy, the name reads as too long to shrink, scrolls,
  // the clip widens back to the room, it shrinks again: the flicker, every frame.
  it.each([
    ['with motion', false],
    ['under Reduce Motion', true],
  ])('keeps the shrunk name and the clip still %s', (_label, reduce) => {
    reduceMotion.value = reduce;
    model.room = 271;
    model.contentWidth = 300;
    model.fittedWidth = 268;

    const { container } = render(
      <MarqueeText active shrinkToFitScale={0.9}>
        {NAME}
      </MarqueeText>,
    );

    expect(model.clipReports).toEqual([271]);
    expect(container.querySelector('[data-shrink]')?.textContent).toBe(NAME);
    expect(container.querySelector('[data-animated]')).toBeNull();
    expect(reanim.withRepeat).not.toHaveBeenCalled();
  });

  // A name that fits, whose width is not a whole point. The clip's width is
  // rounded and the measurer's ceiled, so a width ending in .333 (a 3x screen)
  // reads as 1pt of overflow and picks the shrunk copy. If only that copy claims
  // the measured width, the clip widens by that 1pt, the overflow is gone, the
  // plain copy shows, the clip narrows back: a loop again, now on short names.
  it.each([
    ['ending in .333', 200 + 1 / 3],
    ['ending in .667', 200 + 2 / 3],
    ['of whole points', 200],
  ])('keeps a name that fits, %s, still', (_label, width) => {
    model.room = 271;
    model.contentWidth = width;
    model.fittedWidth = width;

    const { container } = render(
      <MarqueeText active shrinkToFitScale={0.9}>
        {NAME}
      </MarqueeText>,
    );

    expect(model.clipReports.length).toBeLessThanOrEqual(2);
    expect(container.textContent).toContain(NAME);
    expect(container.querySelector('[data-animated]')).toBeNull();
    expect(reanim.withRepeat).not.toHaveBeenCalled();
  });

  // The header re-renders on every player update (the wall chip, the top bar's
  // signposts, the rest timer). None of that may restart or remount the scroll.
  it('starts the scroll once and keeps it through unrelated parent updates', () => {
    model.room = 200;
    model.contentWidth = 320;

    // Builds the marquee in its own render, as the header does, so each update
    // hands it a fresh element with equal props.
    let bump: () => void = () => {};
    function Header() {
      const [tick, setTick] = useState(0);
      bump = () => setTick((value) => value + 1);
      return createElement(
        'section',
        { 'data-tick': tick },
        <MarqueeText active shrinkToFitScale={0.9}>
          {NAME}
        </MarqueeText>,
      );
    }

    const { container } = render(<Header />);
    const scroller = container.querySelector('[data-animated]');
    expect(scroller).not.toBeNull();

    act(() => bump());
    act(() => bump());

    expect(container.querySelector('[data-animated]')).toBe(scroller);
    expect(reanim.withRepeat).toHaveBeenCalledTimes(1);
    expect(model.clipReports).toEqual([200]);
  });
});
