// @vitest-environment jsdom
//
// The fold's summary is what a climber reads instead of the Angle and Date rows,
// so it has to say the true value: "Now" until the date is edited (an untouched
// tick saves at save time), the changed angle after a reopen, and nothing about
// an angle on a board that has none.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const windowMock = vi.hoisted(() => ({ fontScale: 1 }));
const language = vi.hoisted(() => ({ resolvedLanguage: 'en-GB', language: 'en-GB' }));

vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default },
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 405, height: 900, fontScale: windowMock.fontScale }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'mobile.tick.angleMeta') return `${values?.angle}°`;
      if (key === 'mobile.tick.detailsNow') return 'Now';
      if (key === 'mobile.tick.detailsToday') return `Today ${values?.time}`;
      return `${key}:${JSON.stringify(values ?? {})}`;
    },
    i18n: language,
  }),
}));

vi.mock('../../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../../test/theme-mock');
  const theme = makeThemeMock({ variant: 'material', colorScheme: 'dark' });
  return { useTheme: () => theme };
});

vi.mock('../../Text', () => ({
  Text: ({ children, color, style }: { children?: ReactNode; color?: string; style?: { fontWeight?: string } }) =>
    createElement('span', { 'data-color': color, 'data-weight': style?.fontWeight ?? '' }, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-testid': 'chevron', 'data-name': name }),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityRole,
    style,
    testID,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
    accessibilityRole: string;
    style?: unknown;
    testID: string;
  }) =>
    createElement(
      'button',
      {
        'data-testid': testID,
        'data-aria': accessibilityLabel,
        'data-role': accessibilityRole,
        'data-style': JSON.stringify(style ?? null),
        onClick: onPress,
      },
      children,
    ),
}));
vi.mock('../TickFormRow', () => ({
  TickFormRow: ({
    label,
    children,
    height,
    showSeparator,
  }: {
    label: string;
    children?: ReactNode;
    height?: number;
    showSeparator?: boolean;
  }) =>
    createElement(
      'div',
      {
        'data-testid': 'row',
        'data-label': label,
        'data-height': String(height),
        'data-separator': String(showSeparator),
      },
      children,
    ),
}));

import { TickDetailsRow } from '../TickDetailsRow';
import { makeThemeMock } from '../../../test/theme-mock';

const { systemColors } = makeThemeMock({ variant: 'material', colorScheme: 'dark' });
const NOW = new Date(2026, 10, 9, 19, 30);

function renderRow(overrides: Partial<Parameters<typeof TickDetailsRow>[0]> = {}) {
  // Several tests render more than once, and the queries below search the document.
  cleanup();
  const onPress = vi.fn();
  const utils = render(
    createElement(TickDetailsRow, {
      angle: 40,
      openingAngle: 40,
      climbedAt: NOW,
      now: NOW,
      dateEdited: false,
      onPress,
      ...overrides,
    }),
  );
  const pressable = utils.getByTestId('tick-details-row');
  return { ...utils, pressable, onPress, aria: pressable.getAttribute('data-aria') ?? '' };
}

function valueSpan(container: HTMLElement, text: string): Element | undefined {
  return Array.from(container.querySelectorAll('span span')).find((node) => node.textContent === text);
}

beforeEach(() => {
  windowMock.fontScale = 1;
});

describe('TickDetailsRow summary', () => {
  it('reads the angle and Now on an untouched tick', () => {
    const { pressable, container } = renderRow();

    expect(pressable.textContent).toBe('40° · Now');
    expect(valueSpan(container, '40°')?.getAttribute('data-color')).toBe(systemColors.secondaryLabel);
    expect(valueSpan(container, 'Now')?.getAttribute('data-weight')).toBe('');
  });

  it('says Today and the time for a date edited to today', () => {
    const { pressable } = renderRow({ climbedAt: new Date(2026, 10, 9, 9, 41), dateEdited: true });

    expect(pressable.textContent).toBe('40° · Today 09:41');
  });

  it('writes the time the way the date row does, on a 24-hour clock', () => {
    const { pressable } = renderRow({ climbedAt: new Date(2026, 10, 9, 14, 30), dateEdited: true });

    expect(pressable.textContent).toBe('40° · Today 14:30');
  });

  it('gives another day a short localized date and time, never ISO', () => {
    const { pressable } = renderRow({ climbedAt: new Date(2026, 10, 2, 18, 20), dateEdited: true });

    expect(pressable.textContent).toContain('2 Nov');
    expect(pressable.textContent).toContain('18:20');
    expect(pressable.textContent).not.toContain('2026');
  });

  it('adds the year when the tick is from another one', () => {
    const { pressable } = renderRow({ climbedAt: new Date(2025, 10, 2, 18, 20), dateEdited: true });

    expect(pressable.textContent).toContain('2025');
  });

  it('shows only the date part on a board with no angle row', () => {
    const { pressable, aria } = renderRow({ angle: null });

    expect(pressable.textContent).toBe('Now');
    expect(aria).toContain('mobile.tick.detailsAriaNoAngle');
    expect(aria).not.toContain('mobile.tick.detailsAngleAria');
  });
});

describe('TickDetailsRow changed values', () => {
  it('lifts a changed angle to the label colour and medium weight, the date stays quiet', () => {
    const { container } = renderRow({ angle: 45 });

    expect(valueSpan(container, '45°')?.getAttribute('data-color')).toBe(systemColors.label);
    expect(valueSpan(container, '45°')?.getAttribute('data-weight')).toBe('500');
    expect(valueSpan(container, 'Now')?.getAttribute('data-color')).toBe(systemColors.secondaryLabel);
  });

  it('lifts an edited date the same way', () => {
    const { container } = renderRow({ climbedAt: new Date(2026, 10, 9, 9, 41), dateEdited: true });

    expect(valueSpan(container, 'Today 09:41')?.getAttribute('data-weight')).toBe('500');
    expect(valueSpan(container, '40°')?.getAttribute('data-weight')).toBe('');
  });

  it('tells the screen reader which values changed', () => {
    expect(renderRow().aria).toContain('mobile.tick.detailsAngleAria');
    expect(renderRow({ angle: 45 }).aria).toContain('mobile.tick.detailsAngleChangedAria');
    expect(renderRow({ dateEdited: true }).aria).toContain('mobile.tick.detailsDateChangedAria');
    expect(renderRow().aria).not.toContain('mobile.tick.detailsDateChangedAria');
  });
});

describe('TickDetailsRow row', () => {
  it('is a 48dp button with no divider and a trailing chevron', () => {
    const { getByTestId, pressable } = renderRow();

    expect(pressable.getAttribute('data-role')).toBe('button');
    expect(getByTestId('row').getAttribute('data-height')).toBe('48');
    expect(getByTestId('row').getAttribute('data-separator')).toBe('false');
    expect(getByTestId('chevron').getAttribute('data-name')).toBe('chevron.down');
  });

  it('reports the tap', () => {
    const { pressable, onPress } = renderRow();

    fireEvent.click(pressable);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('pads the stacked large-text layout so the two lines clear the row edges', () => {
    expect(renderRow().pressable.getAttribute('data-style')).toBe('null');

    windowMock.fontScale = 1.5;
    expect(JSON.parse(renderRow().pressable.getAttribute('data-style') ?? 'null')).toEqual({ paddingVertical: 8 });
  });
});
