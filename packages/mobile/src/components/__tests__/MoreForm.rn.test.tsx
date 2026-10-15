// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MoreFormModel } from '../MoreForm.types';

const controls = vi.hoisted(() => ({
  contentLayout: null as null | ((event: { nativeEvent: { layout: { height: number } } }) => void),
  slider: null as null | { accessibilityLabel: string; showLabel?: boolean },
}));
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  ActivityIndicator: () => null,
  View: ({ children, onLayout }: { children?: ReactNode; onLayout?: typeof controls.contentLayout }) => {
    if (onLayout) controls.contentLayout = onLayout;
    return createElement('div', null, children);
  },
  ScrollView: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'form-scroll' }, children),
}));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
  borderRadius: { lg: 12 },
}));
vi.mock('../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../PressableSurface', () => ({ PressableSurface: () => null }));
vi.mock('../Icon', () => ({ Icon: () => null }));
vi.mock('../ListRow', () => ({ ListRow: () => null }));
vi.mock('../SectionHeader', () => ({ SectionHeader: () => null }));
vi.mock('../SegmentedControl', () => ({ SegmentedControl: () => null }));
vi.mock('../SwitchRow', () => ({ SwitchRow: () => null }));
vi.mock('../settings/MarkerMultiplierSlider', () => ({
  MarkerMultiplierSlider: (props: NonNullable<typeof controls.slider>) => {
    controls.slider = props;
    return createElement('div', null, props.showLabel ? props.accessibilityLabel : null);
  },
}));
vi.mock('../MoreForm.logic', () => ({
  assertNeverRow: () => {
    throw new Error('Unexpected row');
  },
  disabledOptionKeys: () => new Set(),
  guardedButtonPress: () => undefined,
  isButtonRowPressable: () => false,
  selectedOptionLabel: () => '',
  useOpensOutsideAppHint: () => '',
}));

const { MoreFormRN } = await vi.importActual<typeof import('../MoreForm.rn')>('../MoreForm.rn');

const model: MoreFormModel = {
  sections: [
    {
      key: 'preview',
      footer: 'Previewed on your original photo.',
      rows: [{ kind: 'custom', key: 'preview', height: 320, fullBleed: true, content: 'Wall preview' }],
    },
    {
      key: 'dim',
      rows: [
        {
          kind: 'slider',
          key: 'dim',
          label: 'Dim the rest of the wall',
          value: 0.4,
          min: 0,
          max: 0.9,
          step: 0.05,
          format: String,
          onValueChange: () => {},
          onCommit: () => {},
        },
      ],
    },
  ],
};

afterEach(() => {
  cleanup();
  controls.contentLayout = null;
  controls.slider = null;
});

describe('MoreFormRN fitted preview', () => {
  it('keeps the preview outside vertical scrolling while reporting actual control and footer height', () => {
    const onReservedHeightChange = vi.fn();
    const view = render(
      <MoreFormRN model={model} fitted scrollable={false} onReservedHeightChange={onReservedHeightChange} />,
    );
    expect(view.queryByTestId('form-scroll')).toBeNull();
    expect(view.getByText('Wall preview')).toBeTruthy();
    expect(view.getByText('Dim the rest of the wall')).toBeTruthy();
    act(() => controls.contentLayout?.({ nativeEvent: { layout: { height: 500 } } }));
    expect(onReservedHeightChange).toHaveBeenLastCalledWith(180);
    // Footer wrapping changes the reservation without inventing a line count.
    act(() => controls.contentLayout?.({ nativeEvent: { layout: { height: 530 } } }));
    expect(onReservedHeightChange).toHaveBeenLastCalledWith(210);
    view.rerender(<MoreFormRN model={model} fitted scrollable onReservedHeightChange={onReservedHeightChange} />);
    expect(view.getByTestId('form-scroll')).toBeTruthy();
  });
});
