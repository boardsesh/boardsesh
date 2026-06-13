// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';

const cfg = vi.hoisted(() => ({
  lastSavedTickAt: '2026-06-12T07:15:00.000Z' as string | null,
  targetSeconds: 180 as number | null,
}));

function styleValue(style: unknown, key: string): unknown {
  const styles = Array.isArray(style) ? style : [style];
  for (const styleEntry of styles) {
    if (styleEntry != null && typeof styleEntry === 'object' && key in styleEntry) {
      return (styleEntry as Record<string, unknown>)[key];
    }
  }
  return undefined;
}

function dataValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function advanceTimers(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

vi.mock('react-native', () => ({
  Pressable: ({
    accessibilityLabel,
    accessibilityRole,
    children,
    onPress,
    onPressIn,
    style,
  }: {
    accessibilityLabel?: string;
    accessibilityRole?: string;
    children?: ReactNode;
    onPress?: () => void;
    onPressIn?: () => void;
    style?: unknown;
  }) =>
    createElement(
      'button',
      {
        'aria-label': accessibilityLabel,
        'data-height': dataValue(styleValue(style, 'height')),
        onClick: onPress,
        onMouseDown: onPressIn,
        role: accessibilityRole,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Text: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('span', { 'data-color': dataValue(styleValue(style, 'color')) }, children),
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      if (key === 'mobile.queue.repTimerLabel') return `Rest · ${values?.target}`;
      if (key === 'mobile.queue.repTimerAccessibility') return `${values?.time} / ${values?.target}`;
      if (key === 'mobile.queue.repTimerNoTickAccessibility') return `No tick / ${values?.target}`;
      return key;
    },
  }),
}));

vi.mock('@boardsesh/board-react', () => ({
  useOptionalBoardProvider: () => ({ lastSavedTickAt: cfg.lastSavedTickAt }),
}));

vi.mock('../../../lib/rep-timer-preference', () => ({
  useRepTimerPreference: () => ({ loaded: true, targetSeconds: cfg.targetSeconds, setTargetSeconds: vi.fn() }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { error: '#C81E1E' },
    systemColors: { label: '#111111', secondaryLabel: '#666666' },
  }),
  useOptionalTheme: () => ({
    textStyles: {
      caption2: {},
      headline: {},
    },
    systemColors: { label: '#111111' },
  }),
}));

vi.mock('../../../theme/layout', () => ({ TOOLBAR_CAPSULE_HEIGHT: 44 }));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2, textStyles: {} }));
vi.mock('../AccessoryBarSurface', () => ({
  AccessoryBarSurface: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-surface-max-width': dataValue(styleValue(style, 'maxWidth')) }, children),
}));

import { RepTimerCapsule } from '../RepTimerCapsule';

function press(element: HTMLElement): void {
  fireEvent.mouseDown(element);
  fireEvent.click(element);
}

describe('RepTimerCapsule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T07:15:30.000Z'));
    cfg.lastSavedTickAt = '2026-06-12T07:15:00.000Z';
    cfg.targetSeconds = 180;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a narrower floating max width than the climb capsule', () => {
    const { container } = render(<RepTimerCapsule />);
    expect(container.querySelector('[data-surface-max-width]')?.getAttribute('data-surface-max-width')).toBe('220');
  });

  it('puts the timer state label on the pressable control', () => {
    const { getByRole } = render(<RepTimerCapsule />);
    expect(getByRole('button').getAttribute('aria-label')).toBe('0:30 / 3m');
  });

  it('pauses and resumes from the capsule press target', () => {
    const { getByRole, getByText } = render(<RepTimerCapsule />);
    const button = getByRole('button');
    expect(getByText('0:30')).not.toBeNull();

    press(button);
    advanceTimers(240);
    advanceTimers(10_000);
    expect(getByText('0:30')).not.toBeNull();

    press(button);
    advanceTimers(240);
    advanceTimers(10_000);
    expect(getByText('0:40')).not.toBeNull();
  });

  it('resets to zero on double tap without applying the pending pause toggle', () => {
    const { getByRole, getByText } = render(<RepTimerCapsule />);
    const button = getByRole('button');
    expect(getByText('0:30')).not.toBeNull();

    press(button);
    advanceTimers(100);
    fireEvent.mouseDown(button);

    expect(getByText('0:00')).not.toBeNull();
    advanceTimers(200);
    fireEvent.click(button);
    advanceTimers(6_000);
    expect(getByText('0:05')).not.toBeNull();
  });

  it('can start from zero when no tick has been logged yet', () => {
    cfg.lastSavedTickAt = null;
    vi.setSystemTime(new Date('2026-06-12T07:15:00.000Z'));
    const { getByRole, getByText } = render(<RepTimerCapsule />);
    const button = getByRole('button');
    expect(getByText('0:00')).not.toBeNull();

    press(button);
    advanceTimers(240);
    advanceTimers(5_000);

    expect(getByText('0:05')).not.toBeNull();
  });

  it('turns the timer value red only after the configured target is exceeded', () => {
    cfg.targetSeconds = 180;
    vi.setSystemTime(new Date('2026-06-12T07:18:00.000Z'));
    const { getByText } = render(<RepTimerCapsule />);

    expect(getByText('3:00').getAttribute('data-color')).toBe('#111111');

    advanceTimers(1000);

    expect(getByText('3:01').getAttribute('data-color')).toBe('#C81E1E');
  });
});
