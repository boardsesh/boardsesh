// @vitest-environment jsdom
import { createElement, StrictMode, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MoreFormModel, MoreSelectRow } from '../MoreForm.types';
import type { AppMenuProps } from '../AppMenu.types';
import { AUTO_DISCONNECT_TIMEOUT_OPTIONS } from '../../lib/ble/auto-disconnect-controller';

const controls = vi.hoisted(() => ({
  contentLayout: null as null | ((event: { nativeEvent: { layout: { height: number } } }) => void),
  slider: null as null | { accessibilityLabel: string; showLabel?: boolean },
  menu: null as AppMenuProps | null,
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
vi.mock('../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-testid': `icon-${name}` }),
}));
vi.mock('../ListRow', () => ({
  ListRow: ({ leading }: { leading?: ReactNode }) => createElement('div', null, leading),
}));
vi.mock('../AppMenu', () => ({
  AppMenu: (props: AppMenuProps) => {
    controls.menu = props;
    return createElement('button', null, props.label);
  },
}));
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
  selectedOptionLabel: (options: { key: string; label: string }[], selectedKey: string) =>
    options.find((option) => option.key === selectedKey)?.label ?? '',
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
  controls.menu = null;
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

describe('MoreFormRN menu selects', () => {
  function selectModel(row: MoreSelectRow): MoreFormModel {
    return { sections: [{ key: 'settings', rows: [row] }] };
  }
  function timeoutRow(): MoreSelectRow {
    return {
      kind: 'select',
      key: 'timeout',
      label: 'Disconnect timeout',
      options: AUTO_DISCONNECT_TIMEOUT_OPTIONS.map((seconds) => ({
        key: String(seconds),
        label: `${seconds} seconds`,
      })),
      selectedKey: '30',
      onSelect: vi.fn(),
    };
  }

  it('keeps all eight timeout choices in a menu and selects their exact keys', () => {
    const row = timeoutRow();
    const view = render(<MoreFormRN model={selectModel(row)} />);
    expect(view.getByRole('button').textContent).toBe('30 seconds');
    expect(controls.menu?.actions).toHaveLength(8);
    expect(controls.menu?.actions[2].selected).toBe(true);
    for (let index = 0; index < row.options.length; index++) {
      act(() => controls.menu?.onSelectIndex(index));
      expect(row.onSelect).toHaveBeenLastCalledWith(row.options[index].key);
    }
    act(() => controls.menu?.onSelectIndex(-1));
    act(() => controls.menu?.onSelectIndex(99));
    expect(row.onSelect).toHaveBeenCalledTimes(8);
  });

  it('keeps selections enabled after StrictMode replays the mount effect', () => {
    const row = timeoutRow();
    render(
      <StrictMode>
        <MoreFormRN model={selectModel(row)} />
      </StrictMode>,
    );
    act(() => controls.menu?.onSelectIndex(2));
    expect(row.onSelect).toHaveBeenCalledWith('30');
  });

  it('renders disabled selects as noninteractive values and guards a disabled callback', () => {
    const row = timeoutRow();
    const view = render(<MoreFormRN model={selectModel(row)} />);
    const previousMenu = controls.menu;
    view.rerender(<MoreFormRN model={selectModel({ ...row, disabled: true })} />);
    expect(view.queryByRole('button')).toBeNull();
    expect(view.getByText('30 seconds')).toBeTruthy();
    act(() => previousMenu?.onSelectIndex(1));
    expect(row.onSelect).not.toHaveBeenCalled();
  });

  it('rejects queued menu selections after option replacement or unmount', () => {
    const row = timeoutRow();
    const view = render(<MoreFormRN model={selectModel(row)} />);
    const previousMenu = controls.menu;
    view.rerender(<MoreFormRN model={selectModel({ ...row, options: [...row.options].reverse() })} />);
    act(() => previousMenu?.onSelectIndex(0));
    expect(row.onSelect).not.toHaveBeenCalled();
    const currentMenu = controls.menu;
    view.unmount();
    act(() => currentMenu?.onSelectIndex(0));
    expect(row.onSelect).not.toHaveBeenCalled();
  });

  it('retains the Board look and Accessibility navigation icons', () => {
    const view = render(
      <MoreFormRN
        model={{
          sections: [
            {
              key: 'destinations',
              rows: [
                { kind: 'nav', key: 'custom', label: 'Custom look', icon: 'boardLook', onPress: vi.fn() },
                { kind: 'nav', key: 'accessibility', label: 'Accessibility', icon: 'accessibility', onPress: vi.fn() },
              ],
            },
          ],
        }}
      />,
    );
    expect(view.getByTestId('icon-view.options')).toBeTruthy();
    expect(view.getByTestId('icon-accessibility')).toBeTruthy();
  });
});
