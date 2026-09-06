// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// react-native View → a div that surfaces the a11y label; Text → a plain span
// (the method / extra-characteristic text badges); StyleSheet passthrough.
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
    createElement('div', { 'data-a11y': accessibilityLabel }, children),
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
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

  it('coexists with no-match and benchmark when all three apply at once', () => {
    const { container } = render(
      <ClimbAttributeIcons characteristics={['no_match', 'no_kickboard', 'campus']} benchmarkDifficulty="5" />,
    );
    expect(icons(container)).toEqual(['benchmark', 'no.match']);
    expect(badgeTexts(container)).toEqual(['mobile.climbRow.campus · mobile.climbRow.noKickboard']);
  });
});

describe('ClimbAttributeIcons no-kickboard duplication', () => {
  const textOf = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('span'))
      .map((node) => node.textContent ?? '')
      .filter((text) => text.length > 0);

  // `no_kickboard` and `method_no_kickboard` are independent tokens and a climb
  // can carry both. In en-US and fr the two strings are word-for-word identical,
  // so the row read "No KB  No KB" / "Sans KB  Sans KB"; es and de word them
  // differently ("Sin repisa" vs "Sin KB", "Ohne FL" vs "Ohne KB") but it is
  // the same rule stated twice either way.
  it('names the no-kickboard rule once when a climb carries both tokens', () => {
    const { container } = render(<ClimbAttributeIcons characteristics={['method_no_kickboard', 'no_kickboard']} />);

    const labels = textOf(container).filter((text) => text.includes('noKickboard'));
    expect(labels).toHaveLength(1);
  });

  it('still shows the standalone no-kickboard badge without the method token', () => {
    const { container } = render(<ClimbAttributeIcons characteristics={['no_kickboard']} />);

    expect(textOf(container).some((text) => text.includes('mobile.climbRow.noKickboard'))).toBe(true);
  });

  it('keeps a different method badge alongside the no-kickboard badge', () => {
    const { container } = render(
      <ClimbAttributeIcons characteristics={['method_footless_kickboard', 'no_kickboard']} />,
    );
    const labels = textOf(container);

    expect(labels.some((text) => text.includes('method.footlessKickboard'))).toBe(true);
    expect(labels.some((text) => text.includes('mobile.climbRow.noKickboard'))).toBe(true);
  });
});
