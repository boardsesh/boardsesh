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

  it('renders the no-match glyph when isNoMatch is true', () => {
    const { container } = render(<ClimbAttributeIcons isNoMatch />);
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
    const { container } = render(<ClimbAttributeIcons isNoMatch benchmarkDifficulty="3" />);
    expect(icons(container)).toEqual(['benchmark', 'no.match']);
  });

  it('labels each glyph for screen readers', () => {
    const { container } = render(<ClimbAttributeIcons isNoMatch benchmarkDifficulty="3" />);
    const labels = Array.from(container.querySelectorAll('[data-a11y]')).map((node) => node.getAttribute('data-a11y'));
    expect(labels).toContain('mobile.climbRow.benchmark');
    expect(labels).toContain('mobile.climbRow.noMatch');
  });

  it('passes the size through to the glyphs', () => {
    const { container } = render(<ClimbAttributeIcons isNoMatch size={20} />);
    expect(container.querySelector('[data-icon]')?.getAttribute('data-size')).toBe('20');
  });
});
