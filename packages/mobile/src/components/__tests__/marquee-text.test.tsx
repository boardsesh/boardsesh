// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';

// Controllable layout so a test can simulate an overflowing name (jsdom never
// lays out on its own).
const layout = vi.hoisted(() => ({ clipWidth: 0, contentWidth: 0 }));
const reanim = vi.hoisted(() => ({ withRepeat: vi.fn() }));

// The clip View fires onLayout with the configured clip width.
vi.mock('react-native', () => ({
  View: ({ children, onLayout }: { children?: ReactNode; onLayout?: (event: unknown) => void }) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: layout.clipWidth, height: 20 } } });
    }, [onLayout]);
    return createElement('div', {}, children);
  },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

// Reanimated: spy on the repeat loop and tag the animated wrapper so we can tell
// the scrolling branch apart from the static one.
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

// Text → span. The measurer is the only Text with onLayout, so it reports the
// content width; the data-* attrs let us read numberOfLines / ellipsizeMode.
vi.mock('../Text', () => ({
  Text: ({
    children,
    numberOfLines,
    ellipsizeMode,
    adjustsFontSizeToFit,
    minimumFontScale,
    onLayout,
  }: {
    children?: ReactNode;
    numberOfLines?: number;
    ellipsizeMode?: string;
    adjustsFontSizeToFit?: boolean;
    minimumFontScale?: number;
    onLayout?: (event: unknown) => void;
  }) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: layout.contentWidth, height: 16 } } });
    }, [onLayout]);
    return createElement(
      'span',
      {
        'data-text': 'true',
        'data-lines': String(numberOfLines ?? ''),
        'data-ellipsize': ellipsizeMode ?? '',
        'data-shrink': adjustsFontSizeToFit ? String(minimumFontScale) : undefined,
      },
      children,
    );
  },
}));

const reduceMotion = vi.hoisted(() => ({ value: true }));
vi.mock('../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => reduceMotion.value }));

import { MarqueeText } from '../MarqueeText';

describe('MarqueeText', () => {
  beforeEach(() => {
    reduceMotion.value = true;
    layout.clipWidth = 0;
    layout.contentWidth = 0;
    reanim.withRepeat.mockClear();
  });

  it('renders a single-line tail-ellipsized label when Reduce Motion is on', () => {
    reduceMotion.value = true;
    const { container } = render(<MarqueeText active>Super Long Boulder Name That Overflows</MarqueeText>);

    const tail = container.querySelector('[data-ellipsize="tail"]');
    expect(tail).not.toBeNull();
    expect(tail?.getAttribute('data-lines')).toBe('1');
    expect(tail?.textContent).toContain('Super Long Boulder Name');
    // No scrolling animation kicked off.
    expect(container.querySelector('[data-animated]')).toBeNull();
    expect(reanim.withRepeat).not.toHaveBeenCalled();
  });

  it('renders the static label (no scroll) when not the active item', () => {
    reduceMotion.value = false;
    layout.clipWidth = 100;
    layout.contentWidth = 320;
    const { container } = render(<MarqueeText active={false}>Another Very Long Climb Name Here</MarqueeText>);

    const tail = container.querySelector('[data-ellipsize="tail"]');
    expect(tail).not.toBeNull();
    expect(container.querySelector('[data-animated]')).toBeNull();
    expect(reanim.withRepeat).not.toHaveBeenCalled();
  });

  it('scrolls (starts the loop) when active, overflowing, and Reduce Motion is off', () => {
    reduceMotion.value = false;
    layout.clipWidth = 100;
    layout.contentWidth = 320;
    const { container } = render(<MarqueeText active>Some Really Long Climb Name That Overflows The Bar</MarqueeText>);

    // The scrolling copy lives in an Animated.View, and the back-and-forth loop ran.
    expect(container.querySelector('[data-animated]')).not.toBeNull();
    expect(reanim.withRepeat).toHaveBeenCalled();
  });

  it('stays static when the name fits the clip', () => {
    reduceMotion.value = false;
    layout.clipWidth = 320;
    layout.contentWidth = 100;
    const { container } = render(<MarqueeText active>Short Name</MarqueeText>);

    expect(container.querySelector('[data-ellipsize="tail"]')).not.toBeNull();
    expect(container.querySelector('[data-animated]')).toBeNull();
    expect(reanim.withRepeat).not.toHaveBeenCalled();
  });

  it('stays static at exactly the overflow threshold (2px)', () => {
    reduceMotion.value = false;
    layout.clipWidth = 100;
    layout.contentWidth = 102; // overflow === MIN_OVERFLOW_PX → no scroll
    const { container } = render(<MarqueeText active>Name Right At The Threshold</MarqueeText>);

    expect(container.querySelector('[data-animated]')).toBeNull();
    expect(reanim.withRepeat).not.toHaveBeenCalled();
  });

  it('scrolls one pixel past the threshold (3px)', () => {
    reduceMotion.value = false;
    layout.clipWidth = 100;
    layout.contentWidth = 103; // overflow > MIN_OVERFLOW_PX → scroll
    const { container } = render(<MarqueeText active>Name Just Over The Threshold</MarqueeText>);

    expect(container.querySelector('[data-animated]')).not.toBeNull();
    expect(reanim.withRepeat).toHaveBeenCalled();
  });

  it('wraps the fallback to fallbackLines under Reduce Motion (full name, no scroll)', () => {
    reduceMotion.value = true;
    layout.clipWidth = 100;
    layout.contentWidth = 320;
    const { container } = render(
      <MarqueeText active fallbackLines={2}>
        A Long Name A Reduce Motion User Should Still Read In Full
      </MarqueeText>,
    );

    const fallback = container.querySelector('[data-ellipsize="tail"]');
    expect(fallback?.getAttribute('data-lines')).toBe('2');
    expect(container.querySelector('[data-animated]')).toBeNull();
    expect(reanim.withRepeat).not.toHaveBeenCalled();
  });

  // #7017: a name a few points too long scrolled by those points, and at rest at
  // the far end its first glyph sat clipped ("ɹrain from the Brain").
  it('shrinks a name that fits at the shrink scale instead of scrolling it, first glyph and all', () => {
    reduceMotion.value = false;
    layout.clipWidth = 190;
    layout.contentWidth = 200; // 95% fits a 0.9 floor
    const { container } = render(
      <MarqueeText active shrinkToFitScale={0.9}>
        Drain from the Brain
      </MarqueeText>,
    );

    expect(container.querySelector('[data-animated]')).toBeNull();
    expect(reanim.withRepeat).not.toHaveBeenCalled();
    const fitted = container.querySelector('[data-shrink]');
    expect(fitted?.getAttribute('data-shrink')).toBe('0.9');
    expect(fitted?.getAttribute('data-lines')).toBe('1');
  });

  it('still scrolls a name too long to shrink into place', () => {
    reduceMotion.value = false;
    layout.clipWidth = 100;
    layout.contentWidth = 320;
    const { container } = render(
      <MarqueeText active shrinkToFitScale={0.9}>
        Some Really Long Climb Name That Overflows The Bar
      </MarqueeText>,
    );

    expect(container.querySelector('[data-animated]')).not.toBeNull();
    expect(container.querySelector('[data-shrink]')).toBeNull();
  });

  it('never shrinks without the option: the bars keep their scroll', () => {
    reduceMotion.value = false;
    layout.clipWidth = 190;
    layout.contentWidth = 200;
    const { container } = render(<MarqueeText active>Drain from the Brain</MarqueeText>);

    expect(container.querySelector('[data-animated]')).not.toBeNull();
    expect(container.querySelector('[data-shrink]')).toBeNull();
  });
});
