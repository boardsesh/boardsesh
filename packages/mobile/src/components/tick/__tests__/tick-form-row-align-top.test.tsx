// @vitest-environment jsdom
//
// `alignTop` exists for exactly one row. The note field grows to 160pt while
// every other tick control sits on the 56pt beat, and the row's default
// `alignItems: 'center'` puts the label's baseline against the middle of that
// tall box — roughly 31pt below the first line of the climber's own text, which
// reads as a broken row (#4642). These tests pin that it is opt-in: the note
// row takes it, a plain row must not, and it stays out of the way of the
// large-text `stacked` layout, which already puts the label on its own line.
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ViewInstance } from 'react-native';
import { createElement, createRef, type ReactNode, type Ref } from 'react';
import { flattenStyle } from '../../../../test/flatten-style';

const windowMock = vi.hoisted(() => ({ fontScale: 1 }));

vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default },
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  View: ({
    children,
    style,
    testID,
    accessible,
    ref,
  }: {
    children?: ReactNode;
    style?: unknown;
    testID?: string;
    accessible?: boolean;
    ref?: Ref<HTMLDivElement>;
  }) =>
    createElement(
      'div',
      {
        ref,
        'data-style': JSON.stringify(style ?? null),
        'data-testid': testID,
        'data-accessible': accessible ? 'true' : undefined,
      },
      children,
    ),
  useWindowDimensions: () => ({ width: 405, height: 900, fontScale: windowMock.fontScale }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children, style, variant }: { children?: ReactNode; style?: unknown; variant?: string }) =>
    createElement('span', { 'data-style': JSON.stringify(style ?? null), 'data-variant': variant }, children),
}));

const themeState = vi.hoisted(() => ({ variant: 'material' as 'material' | 'liquidGlass' }));
vi.mock('../../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../../test/theme-mock');
  const themes = {
    material: makeThemeMock({ variant: 'material', colorScheme: 'dark' }),
    liquidGlass: makeThemeMock({ variant: 'liquidGlass', colorScheme: 'dark' }),
  };
  return { useTheme: () => themes[themeState.variant] };
});

import { TickFormRow } from '../TickFormRow';
import { spacing } from '../../../theme/tokens';

function renderRow(props: { alignTop?: boolean } = {}) {
  const { container } = render(
    createElement(TickFormRow, {
      label: 'Note',
      testID: 'row',
      children: createElement('input', { readOnly: true }),
      ...props,
    }),
  );
  // The row's own box is the first child of the testID'd wrapper; the label is
  // the only span.
  const row = container.querySelector('[data-testid="row"] > div');
  const label = container.querySelector('span');
  return {
    row: flattenStyle(JSON.parse(row?.getAttribute('data-style') ?? 'null')),
    label: flattenStyle(JSON.parse(label?.getAttribute('data-style') ?? 'null')),
  };
}

describe('TickFormRow labelFocusRef', () => {
  it('wraps the label in one focusable view only when asked', () => {
    windowMock.fontScale = 1;
    cleanup();
    render(createElement(TickFormRow, { label: 'Note', children: createElement('input', { readOnly: true }) }));
    expect(document.querySelector('[data-accessible]')).toBeNull();

    cleanup();
    const labelFocusRef = createRef<ViewInstance>();
    render(
      createElement(TickFormRow, {
        label: 'Angle',
        labelFocusRef,
        children: createElement('input', { readOnly: true }),
      }),
    );
    const focusable = document.querySelector('[data-accessible]');
    expect(focusable?.textContent).toBe('Angle');
    expect(labelFocusRef.current).toBe(focusable);
  });
});

describe('TickFormRow on Liquid Glass', () => {
  it('keeps the body label on the 56 floor and 12 gap', () => {
    windowMock.fontScale = 1;
    themeState.variant = 'liquidGlass';
    try {
      cleanup();
      const { row, label } = renderRow();

      expect(document.querySelector('span')?.getAttribute('data-variant')).toBe('body');
      expect(label.minWidth).toBe(56);
      expect(row.gap).toBe(spacing[3]);
    } finally {
      themeState.variant = 'material';
    }
  });
});

describe('TickFormRow on Material', () => {
  it('sets the label in subheadline on a 60 floor and an 8 gap, so the seam stays at 84', () => {
    windowMock.fontScale = 1;
    const { row, label } = renderRow();

    expect(document.querySelector('span')?.getAttribute('data-variant')).toBe('subheadline');
    expect(label.minWidth).toBe(60);
    expect(row.gap).toBe(spacing[2]);
    expect(row.paddingStart).toBe(16);
  });
});

describe('TickFormRow alignTop', () => {
  it('keeps the centred 56pt beat by default', () => {
    windowMock.fontScale = 1;
    const { row, label } = renderRow();

    expect(row.alignItems).toBe('center');
    expect(row.paddingTop).toBe(0);
    expect(label.paddingTop).toBe(0);
  });

  it('top-aligns the label when a row opts in', () => {
    windowMock.fontScale = 1;
    const { row, label } = renderRow({ alignTop: true });

    expect(row.alignItems).toBe('flex-start');
    expect(row.paddingTop).toBe(spacing[1]);
    expect(label.paddingTop).toBe(spacing[2]);
  });

  it('defers to the stacked layout at large text sizes', () => {
    // Stacked is a column with the label already above the control, so the
    // top-alignment insets would only double the gap.
    windowMock.fontScale = 1.5;
    const { row, label } = renderRow({ alignTop: true });

    expect(row.flexDirection).toBe('column');
    expect(row.paddingTop).toBe(0);
    expect(label.paddingTop).toBe(0);
  });
});
