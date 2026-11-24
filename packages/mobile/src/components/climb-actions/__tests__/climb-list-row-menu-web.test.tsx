// @vitest-environment jsdom
import { createElement, useImperativeHandle, type ReactNode, type Ref, type RefObject } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppMenuHandle } from '../../AppMenu.types';
import type { ClimbListRowMenuProps } from '../ClimbListRowMenu.types';

type MeasureCallback = (left: number, top: number, width: number, height: number) => void;
const menu = vi.hoisted(() => ({
  platform: 'web',
  open: vi.fn(),
  measurements: [] as MeasureCallback[],
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return menu.platform;
    },
  },
  StyleSheet: { create: <Styles,>(styles: Styles) => styles },
  View: ({
    children,
    ref,
    testID,
  }: {
    children?: ReactNode;
    ref?: Ref<{ measureInWindow: (callback: MeasureCallback) => void }>;
    testID?: string;
  }) => {
    useImperativeHandle(ref, () => ({
      measureInWindow: (callback: MeasureCallback) => menu.measurements.push(callback),
    }));
    return createElement('div', { 'data-testid': testID }, children);
  },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#888888' } }),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../PressableSurface', () => ({
  StaticPressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('../ClimbMenu', () => ({
  ClimbMenu: ({ children, menuRef }: { children: ReactNode; menuRef: RefObject<AppMenuHandle | null> }) => {
    useImperativeHandle(menuRef, () => ({ open: menu.open }));
    return children;
  },
}));

import { FallbackClimbListRowMenu } from '../ClimbListRowMenu.fallback';

function rowProps(menuKey = 'row-a'): ClimbListRowMenuProps {
  return {
    enabled: true,
    rows: [{ id: 'share', label: 'Share', run: vi.fn() }],
    menuKey,
    title: 'Pebble',
    accessibilityLabel: 'More actions',
    children: createElement('span', null, 'Pebble'),
    preview: createElement('span', null, 'Preview'),
    focusRef: { current: null },
    bodyStyle: { flex: 1 },
    moreButtonStyle: { width: 44 },
    showMoreButton: true,
  };
}

beforeEach(() => {
  menu.platform = 'web';
  menu.open.mockReset();
  menu.measurements = [];
});

describe('browser climb-row overflow anchor', () => {
  it('opens from the measured button bottom, rather than the row origin', () => {
    const { getByRole } = render(createElement(FallbackClimbListRowMenu, rowProps()));
    fireEvent.click(getByRole('button', { name: 'More actions' }));
    expect(menu.open).not.toHaveBeenCalled();
    act(() => menu.measurements[0](680, 240, 44, 44));
    expect(menu.open).toHaveBeenCalledWith({ x: 680, y: 284 });
  });

  it('does not open another climb after its cell is recycled during measurement', () => {
    const { getByRole, rerender } = render(createElement(FallbackClimbListRowMenu, rowProps()));
    fireEvent.click(getByRole('button', { name: 'More actions' }));
    rerender(createElement(FallbackClimbListRowMenu, rowProps('row-b')));
    act(() => menu.measurements[0](680, 240, 44, 44));
    expect(menu.open).not.toHaveBeenCalled();
    fireEvent.click(getByRole('button', { name: 'More actions' }));
    act(() => menu.measurements[1](680, 352, 44, 44));
    expect(menu.open).toHaveBeenCalledWith({ x: 680, y: 396 });
  });

  it('keeps the Android menu opener unchanged', () => {
    menu.platform = 'android';
    const { getByRole } = render(createElement(FallbackClimbListRowMenu, rowProps()));
    fireEvent.click(getByRole('button', { name: 'More actions' }));
    expect(menu.open).toHaveBeenCalledExactlyOnceWith();
    expect(menu.measurements).toHaveLength(0);
  });
});
