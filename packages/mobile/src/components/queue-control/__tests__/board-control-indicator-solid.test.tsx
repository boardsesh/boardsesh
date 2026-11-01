// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signals = vi.hoisted(() => ({ differentiateWithoutColor: 'off' as 'on' | 'off' | 'unknown' }));

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
  PressableSurface: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
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
vi.mock('../../../providers/ble-control-sheet-provider', () => ({ useBleControlSheet: () => ({ open: vi.fn() }) }));
vi.mock('../use-accessory-climb-tap', () => ({ useAccessoryClimbTap: () => ({ openPlay: vi.fn() }) }));
vi.mock('../../ble/use-lightbulb-control', () => ({ useLightbulbControl: () => ({ onPress: vi.fn() }) }));
vi.mock('../../ble/use-board-connection-state', () => ({
  useBoardConnectionState: () => ({
    bluetooth: {},
    localConnected: false,
    inAppBoardConnection: 'disconnected',
    ledless: false,
    holderDisplayName: null,
  }),
}));
vi.mock('../../../hooks/use-differentiate-without-color', () => ({
  useDifferentiateWithoutColor: () => signals.differentiateWithoutColor,
}));
vi.mock('../../../lib/haptics', () => ({ hapticMedium: vi.fn() }));

import { BoardControlIndicator } from '../BoardControlIndicator';

const iconName = (container: HTMLElement) => container.querySelector('[data-icon]')?.getAttribute('data-icon');

// The accessory platter draws the bulb solid, like Apple Music's controls. Off then
// differs from on by colour and halo, so the outline comes back for a climber who
// has asked iOS to differentiate without colour.
describe('BoardControlIndicator solid glyphs', () => {
  beforeEach(() => {
    signals.differentiateWithoutColor = 'off';
  });

  it('draws the off bulb solid on the platter', () => {
    const { container } = render(createElement(BoardControlIndicator, { solidGlyphs: true }));
    expect(iconName(container)).toBe('lightbulb.fill');
  });

  it('keeps the outline elsewhere', () => {
    const { container } = render(createElement(BoardControlIndicator));
    expect(iconName(container)).toBe('lightbulb');
  });

  it('brings the outline back under Differentiate Without Color', () => {
    signals.differentiateWithoutColor = 'on';
    const { container } = render(createElement(BoardControlIndicator, { solidGlyphs: true }));
    expect(iconName(container)).toBe('lightbulb');
  });
});
