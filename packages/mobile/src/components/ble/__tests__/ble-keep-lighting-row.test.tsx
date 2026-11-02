// @vitest-environment jsdom
// The board sheet's keep-lighting row (2.7, spec B4): the current choice in a
// native menu, ticked, and a pick writes the setting.
import { createElement, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const mockMenu = vi.hoisted(() => ({
  props: null as {
    label: string;
    accessibilityLabel?: string;
    actions: { label: string; selected?: boolean }[];
    onSelectIndex: (index: number) => void;
  } | null,
}));

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 4: 16 } }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../AppMenu', () => ({
  AppMenu: (props: NonNullable<typeof mockMenu.props>) => {
    mockMenu.props = props;
    return createElement('button', null, props.label);
  },
}));

import { BleKeepLightingRow } from '../BleKeepLightingRow';
import type { KeepLightingChoice } from '../../../lib/keep-lighting';

afterEach(() => {
  cleanup();
  mockMenu.props = null;
});

const OPTIONS: { key: KeepLightingChoice; label: string }[] = [
  { key: 'off', label: 'Off' },
  { key: '30', label: '30 seconds' },
  { key: '45', label: '45 seconds' },
  { key: '60', label: '1 minute' },
  { key: 'until_stopped', label: 'Until I stop' },
];

it('shows the label and the current choice, ticked, and a pick writes that choice', () => {
  const onChange = vi.fn();
  const { getByText } = render(
    <BleKeepLightingRow
      model={{ label: 'Keep lighting after Put on board', choice: '45', options: OPTIONS, onChange }}
    />,
  );
  getByText('Keep lighting after Put on board');
  expect(mockMenu.props?.label).toBe('45 seconds');
  expect(mockMenu.props?.accessibilityLabel).toBe('Keep lighting after Put on board, 45 seconds');
  expect(mockMenu.props?.actions.filter((action) => action.selected).map((action) => action.label)).toEqual([
    '45 seconds',
  ]);
  mockMenu.props?.onSelectIndex(0);
  expect(onChange).toHaveBeenCalledWith('off');
});

it("delivers a pick queued before a re-render to the latest row's handler", () => {
  const first = vi.fn();
  const latest = vi.fn();
  const { rerender } = render(
    <BleKeepLightingRow model={{ label: 'Keep lighting', choice: '45', options: OPTIONS, onChange: first }} />,
  );
  const queued = mockMenu.props?.onSelectIndex;
  rerender(<BleKeepLightingRow model={{ label: 'Keep lighting', choice: '30', options: OPTIONS, onChange: latest }} />);
  queued?.(4);
  expect(latest).toHaveBeenCalledWith('until_stopped');
  expect(first).not.toHaveBeenCalled();
});
