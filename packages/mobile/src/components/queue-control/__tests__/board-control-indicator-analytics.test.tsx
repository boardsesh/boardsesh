// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signals = vi.hoisted(() => ({
  differentiateWithoutColor: 'off' as 'on' | 'off' | 'unknown',
  openControls: vi.fn(),
  lightbulbOptions: [] as unknown[],
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
  },
}));
vi.mock('../../AccessibleTextInput', () => ({ AccessibleTextInput: () => null }));
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onLongPress }: { children?: ReactNode; onLongPress?: () => void }) =>
    createElement('button', { 'data-long-press': 'true', onContextMenu: onLongPress }, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { secondaryLabel: '#8e8e93' },
    brandColors: { warning: '#ffcc00', primary: '#7c5cff' },
  }),
}));
vi.mock('../../../providers/ble-control-sheet-provider', () => ({
  useBleControlSheet: () => ({ open: signals.openControls }),
}));
vi.mock('../use-accessory-climb-tap', () => ({ useAccessoryClimbTap: () => ({ openPlay: vi.fn() }) }));
vi.mock('../../ble/use-lightbulb-control', () => ({
  useLightbulbControl: (options: unknown) => {
    signals.lightbulbOptions.push(options);
    return { onPress: vi.fn() };
  },
}));
vi.mock('../../ble/use-board-connection-state', () => ({
  useBoardConnectionState: () => ({
    bluetooth: {},
    localConnected: true,
    inAppBoardConnection: 'connectedByMe',
    ledless: false,
    holderDisplayName: null,
  }),
}));
vi.mock('../../../hooks/use-differentiate-without-color', () => ({
  useDifferentiateWithoutColor: () => signals.differentiateWithoutColor,
}));
vi.mock('../../../lib/haptics', () => ({ hapticMedium: vi.fn() }));

import { BoardControlIndicator } from '../BoardControlIndicator';

// Which bulb did what: the platter's bulb says which placement it sat in, so its
// taps and long-presses can be told apart from the floating capsule's.
describe('BoardControlIndicator analytics source', () => {
  beforeEach(() => {
    signals.openControls.mockClear();
    signals.lightbulbOptions.length = 0;
  });

  it('passes the platter placement to the connect path', () => {
    render(createElement(BoardControlIndicator, { placement: 'inline' }));
    expect(signals.lightbulbOptions.at(-1)).toEqual({ surface: 'board_control_indicator', placement: 'inline' });
  });

  it('opens the controls sheet from a long-press, saying where it came from', () => {
    const { container } = render(createElement(BoardControlIndicator, { enableLongPress: true, placement: 'regular' }));
    fireEvent.contextMenu(container.querySelector('[data-long-press]')!);
    expect(signals.openControls).toHaveBeenCalledWith({ surface: 'board_control_indicator', placement: 'regular' });
  });

  it("leaves placement off for the floating capsule's bulb", () => {
    const { container } = render(createElement(BoardControlIndicator, { enableLongPress: true }));
    fireEvent.contextMenu(container.querySelector('[data-long-press]')!);
    expect(signals.openControls).toHaveBeenCalledWith({ surface: 'board_control_indicator', placement: undefined });
  });
});
