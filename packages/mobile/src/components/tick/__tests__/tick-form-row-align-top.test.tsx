// @vitest-environment jsdom
//
// `alignTop` exists for exactly one row. The note field grows to 180pt while
// every other tick control sits on the 56pt beat, and the row's default
// `alignItems: 'center'` puts the label's baseline against the middle of that
// tall box — roughly 31pt below the first line of the climber's own text, which
// reads as a broken row (#4642). These tests pin that it is opt-in: the note
// row takes it, a plain row must not, and it stays out of the way of the
// large-text `stacked` layout, which already puts the label on its own line.
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { flattenStyle } from '../../../../test/flatten-style';

const windowMock = vi.hoisted(() => ({ fontScale: 1 }));

vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default },
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  View: ({ children, style, testID }: { children?: ReactNode; style?: unknown; testID?: string }) =>
    createElement('div', { 'data-style': JSON.stringify(style ?? null), 'data-testid': testID }, children),
  useWindowDimensions: () => ({ width: 405, height: 900, fontScale: windowMock.fontScale }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('span', { 'data-style': JSON.stringify(style ?? null) }, children),
}));

vi.mock('../../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../../test/theme-mock');
  const theme = makeThemeMock({ variant: 'material', colorScheme: 'dark' });
  return { useTheme: () => theme };
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
