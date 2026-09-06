// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// View keeps its flattened style on the node so the scrim chip's colours and the
// absolute placement inside the thumbnail cell are assertable.
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
  // theme/tokens reaches theme/colors, which branches on `Platform.OS` and only
  // calls `PlatformColor` on iOS.
  Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.android ?? choices.default },
  PlatformColor: (name: string) => name,
  View: ({
    children,
    style,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityLabel?: string;
  }) => {
    const flattened = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : (style ?? {});
    return createElement('div', { 'data-style': JSON.stringify(flattened), 'data-a11y': accessibilityLabel }, children);
  },
}));

vi.mock('../Icon', () => ({
  Icon: ({ name, size, color }: { name: string; size?: number; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-size': String(size), 'data-color': color }),
}));

vi.mock('../Text', () => ({
  Text: ({ children, variant, color }: { children?: ReactNode; variant?: string; color?: string }) =>
    createElement('span', { 'data-variant': variant, 'data-color': color }, children),
}));

// t() returns "key:count" so the plural call is assertable without a real catalog.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { count?: number }) => `${key}:${options?.count}` }),
}));

import { ClimbFramesBadge, isMultiFrameClimb } from '../ClimbFramesBadge';

const chip = (container: HTMLElement) => container.querySelector('div[data-style]');
const chipStyle = (container: HTMLElement) =>
  JSON.parse(chip(container)?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;

describe('isMultiFrameClimb', () => {
  it('is true only for a frame count above one', () => {
    expect(isMultiFrameClimb(2)).toBe(true);
    expect(isMultiFrameClimb(12)).toBe(true);
  });

  it('is false for a single-frame boulder, a missing count, or a nonsense count', () => {
    expect(isMultiFrameClimb(1)).toBe(false);
    expect(isMultiFrameClimb(0)).toBe(false);
    expect(isMultiFrameClimb(null)).toBe(false);
    expect(isMultiFrameClimb(undefined)).toBe(false);
    expect(isMultiFrameClimb(Number.NaN)).toBe(false);
  });
});

describe('ClimbFramesBadge', () => {
  it('renders the stack glyph and the raw count for a multi-frame route', () => {
    const { container } = render(<ClimbFramesBadge framesCount={4} />);
    expect(container.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('frames');
    expect(container.querySelector('span')?.textContent).toBe('4');
  });

  it('renders nothing for a single-frame boulder even if it is mounted anyway', () => {
    const { container } = render(<ClimbFramesBadge framesCount={1} />);
    expect(container.innerHTML).toBe('');
  });

  it('labels itself with the pluralised frame count for screen readers', () => {
    const { container } = render(<ClimbFramesBadge framesCount={3} />);
    expect(chip(container)?.getAttribute('data-a11y')).toBe('mobile.climbRow.frameCount:3');
  });

  it('paints an opaque dark scrim with a light hairline edge, so it reads on both bright and near-black board art', () => {
    const { container } = render(<ClimbFramesBadge framesCount={3} />);
    const style = chipStyle(container);
    expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0.72)');
    expect(style.borderColor).toBe('rgba(255, 255, 255, 0.45)');
    expect(style.position).toBe('absolute');
  });

  it('inks the glyph and the count in the same fixed white — the chip is dark in both colour schemes', () => {
    const { container } = render(<ClimbFramesBadge framesCount={3} />);
    expect(container.querySelector('[data-icon]')?.getAttribute('data-color')).toBe('#FFFFFF');
    expect(container.querySelector('span')?.getAttribute('data-color')).toBe('#FFFFFF');
  });

  it('shrinks the glyph on the compact tier, whose cell is 56x72 rather than 76x96', () => {
    const standard = render(<ClimbFramesBadge framesCount={3} />).container;
    const compact = render(<ClimbFramesBadge framesCount={3} compact />).container;
    const standardSize = Number(standard.querySelector('[data-icon]')?.getAttribute('data-size'));
    const compactSize = Number(compact.querySelector('[data-icon]')?.getAttribute('data-size'));
    expect(compactSize).toBeLessThan(standardSize);
  });

  it('keeps the count on the shared caption type scale rather than a hardcoded size', () => {
    const { container } = render(<ClimbFramesBadge framesCount={3} />);
    expect(container.querySelector('span')?.getAttribute('data-variant')).toBe('caption2');
  });
});
