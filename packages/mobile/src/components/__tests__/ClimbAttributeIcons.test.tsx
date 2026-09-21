// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// react-native View → a div that surfaces the a11y label; StyleSheet passthrough.
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
    createElement('div', { 'data-a11y': accessibilityLabel }, children),
}));

// The shared Text primitive (the method / extra-characteristic badges) → a span
// carrying its variant and flattened style, so the type scale it rides and the
// absence of the old shouty uppercase transform are both assertable.
vi.mock('../Text', () => ({
  Text: ({
    children,
    variant,
    color,
    style,
  }: {
    children?: ReactNode;
    variant?: string;
    color?: string;
    style?: unknown;
  }) => {
    const flattened = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : (style ?? {});
    return createElement(
      'span',
      { 'data-variant': variant, 'data-color': color, 'data-style': JSON.stringify(flattened) },
      children,
    );
  },
}));

// Icon → a span exposing the glyph name + size + colour so we can assert which
// glyphs render, in what order, at what size.
vi.mock('../Icon', () => ({
  Icon: ({ name, size, color }: { name: string; size?: number; color?: string }) =>
    createElement('span', { 'data-icon': name, 'data-size': String(size), 'data-color': color }),
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#8E8E93' } }),
}));

// t() returns the key, so a11y labels are assertable.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ClimbAttributeIcons } from '../ClimbAttributeIcons';

const icons = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-icon]')).map((node) => node.getAttribute('data-icon'));

describe('ClimbAttributeIcons', () => {
  it('renders nothing when neither attribute applies', () => {
    const { container } = render(<ClimbAttributeIcons />);
    expect(container.querySelector('[data-icon]')).toBeNull();
  });

  it('renders the no-match glyph when characteristics includes no_match', () => {
    const { container } = render(<ClimbAttributeIcons characteristics={['no_match']} />);
    expect(icons(container)).toEqual(['no.match']);
  });

  it('renders the benchmark glyph when benchmarkDifficulty > 0 (string)', () => {
    const { container } = render(<ClimbAttributeIcons benchmarkDifficulty="5" />);
    expect(icons(container)).toEqual(['benchmark']);
  });

  it('renders the benchmark glyph for a numeric benchmarkDifficulty', () => {
    const { container } = render(<ClimbAttributeIcons benchmarkDifficulty={7} />);
    expect(icons(container)).toEqual(['benchmark']);
  });

  it('does not render benchmark when benchmarkDifficulty is "0", null, or undefined', () => {
    expect(icons(render(<ClimbAttributeIcons benchmarkDifficulty="0" />).container)).toEqual([]);
    expect(icons(render(<ClimbAttributeIcons benchmarkDifficulty={null} />).container)).toEqual([]);
    expect(icons(render(<ClimbAttributeIcons />).container)).toEqual([]);
  });

  it('does not render benchmark for a non-numeric (NaN) benchmarkDifficulty', () => {
    const { container } = render(<ClimbAttributeIcons benchmarkDifficulty="classic" />);
    expect(icons(container)).toEqual([]);
  });

  it('renders benchmark before no-match when both apply (web order)', () => {
    const { container } = render(<ClimbAttributeIcons characteristics={['no_match']} benchmarkDifficulty="3" />);
    expect(icons(container)).toEqual(['benchmark', 'no.match']);
  });

  it('labels each glyph for screen readers', () => {
    const { container } = render(<ClimbAttributeIcons characteristics={['no_match']} benchmarkDifficulty="3" />);
    const labels = Array.from(container.querySelectorAll('[data-a11y]')).map((node) => node.getAttribute('data-a11y'));
    expect(labels).toContain('mobile.climbRow.benchmark');
    expect(labels).toContain('mobile.climbRow.noMatch');
  });

  it('passes the size through to the glyphs', () => {
    const { container } = render(<ClimbAttributeIcons characteristics={['no_match']} size={20} />);
    expect(container.querySelector('[data-icon]')?.getAttribute('data-size')).toBe('20');
  });

  it('does not render no-match when characteristics is empty or null', () => {
    expect(icons(render(<ClimbAttributeIcons characteristics={[]} />).container)).toEqual([]);
    expect(icons(render(<ClimbAttributeIcons characteristics={null} />).container)).toEqual([]);
    expect(icons(render(<ClimbAttributeIcons />).container)).toEqual([]);
  });

  it('falls back to isNoMatch bool when characteristics is absent (tick-sourced rows)', () => {
    const { container } = render(<ClimbAttributeIcons isNoMatch />);
    expect(icons(container)).toEqual(['no.match']);
  });

  it('prefers characteristics over isNoMatch bool (characteristics wins)', () => {
    // characteristics=[] (no no_match token) takes precedence over isNoMatch=true
    const { container } = render(<ClimbAttributeIcons characteristics={[]} isNoMatch />);
    expect(icons(container)).toEqual([]);
  });

  const badgeTexts = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('span:not([data-icon])'))
      .map((node) => node.textContent)
      .filter((text): text is string => !!text);

  it('renders a "Campus" text badge when characteristics includes campus', () => {
    const { container } = render(<ClimbAttributeIcons characteristics={['campus']} />);
    expect(badgeTexts(container)).toEqual(['mobile.climbRow.campus']);
  });

  it('renders a "No KB" text badge when characteristics includes no_kickboard', () => {
    const { container } = render(<ClimbAttributeIcons characteristics={['no_kickboard']} />);
    expect(badgeTexts(container)).toEqual(['mobile.climbRow.noKickboard']);
  });

  it('joins both badges with " · " when both characteristics are present', () => {
    const { container } = render(<ClimbAttributeIcons characteristics={['no_kickboard', 'campus']} />);
    expect(badgeTexts(container)).toEqual(['mobile.climbRow.campus · mobile.climbRow.noKickboard']);
  });

  it('renders the badges on the shared caption1 scale, not a hardcoded font size', () => {
    const { container } = render(<ClimbAttributeIcons characteristics={['campus']} />);
    const badge = container.querySelector('span:not([data-icon])');
    expect(badge?.getAttribute('data-variant')).toBe('caption1');
    const style = JSON.parse(badge?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
    expect(style.fontSize).toBeUndefined();
  });

  it('no longer shouts the badges in uppercase with extra tracking (#4883)', () => {
    const { container } = render(<ClimbAttributeIcons characteristics={['campus', 'no_kickboard']} />);
    const style = JSON.parse(
      container.querySelector('span:not([data-icon])')?.getAttribute('data-style') ?? '{}',
    ) as Record<string, unknown>;
    expect(style.textTransform).toBeUndefined();
    expect(style.letterSpacing).toBeUndefined();
  });

  it('keeps the badges monochrome — colour in a climb row means grade and nothing else', () => {
    const { container } = render(<ClimbAttributeIcons characteristics={['campus']} />);
    expect(container.querySelector('span:not([data-icon])')?.getAttribute('data-color')).toBe('#8E8E93');
  });

  it('does not resize the badge text when a caller changes the glyph size', () => {
    const small = render(<ClimbAttributeIcons characteristics={['campus']} size={10} />).container;
    const large = render(<ClimbAttributeIcons characteristics={['campus']} size={20} />).container;
    const variantOf = (container: HTMLElement) =>
      container.querySelector('span:not([data-icon])')?.getAttribute('data-variant');
    expect(variantOf(small)).toBe(variantOf(large));
  });

  it('coexists with no-match and benchmark when all three apply at once', () => {
    const { container } = render(
      <ClimbAttributeIcons characteristics={['no_match', 'no_kickboard', 'campus']} benchmarkDifficulty="5" />,
    );
    expect(icons(container)).toEqual(['benchmark', 'no.match']);
    expect(badgeTexts(container)).toEqual(['mobile.climbRow.campus · mobile.climbRow.noKickboard']);
  });
});
