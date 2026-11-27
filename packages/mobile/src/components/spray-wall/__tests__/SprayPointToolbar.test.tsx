// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-style': JSON.stringify(style) }, children),
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: { position: 'absolute' } },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryGroupedBackground: '#eee' },
    selection: { text: '#111', checkmark: '#0a5', fill: 'rgba(0, 170, 85, 0.18)' },
    spacing: [0, 4, 8],
  }),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
    disabled,
    style,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
    accessibilityState?: { selected?: boolean };
    disabled?: boolean;
    style?: unknown;
  }) =>
    createElement(
      'button',
      {
        onClick: onPress,
        'aria-label': accessibilityLabel,
        'aria-pressed': accessibilityState?.selected,
        disabled,
        'data-style': JSON.stringify(style),
      },
      children,
    ),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color: string }) =>
    createElement('span', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('../SprayLedToolIcon', () => ({
  SprayLedToolIcon: ({ name, color }: { name: string; color: string }) =>
    createElement('span', { 'data-led-icon': name, 'data-color': color }),
}));

import { SprayPhotoToolButton, SprayPointToolbar } from '../SprayPointToolbar';

afterEach(cleanup);

describe('spray editor selection controls', () => {
  it('keeps the custom LED glyph and selection wash together in the fullscreen rail', () => {
    const onPress = vi.fn();
    render(<SprayPhotoToolButton icon="select-two-leds" label="Select LEDs" selected onPress={onPress} />);
    const tool = screen.getByRole('button', { name: 'Select LEDs' });
    expect(tool.getAttribute('aria-pressed')).toBe('true');
    expect(tool.getAttribute('data-style')).toContain('"backgroundColor":"#eee"');
    expect(tool.getAttribute('data-style')).toContain('"borderColor":"#0a5"');
    expect(tool.querySelector('[data-style]')?.getAttribute('data-style')).toContain('rgba(0, 170, 85, 0.18)');
    expect(tool.querySelector('[data-led-icon]')?.getAttribute('data-color')).toBe('#111');
    fireEvent.click(tool);
    expect(onPress).toHaveBeenCalledOnce();
  });

  it.each([false, true])('toggles point modes and preserves disabled Undo (icons=%s)', (icons) => {
    const onModeChange = vi.fn();
    const onUndo = vi.fn();
    render(<SprayPointToolbar mode="add" onModeChange={onModeChange} onUndo={onUndo} canUndo={false} icons={icons} />);
    const add = screen.getByRole('button', { name: 'sprayLedSetup.add' });
    expect(add.getAttribute('aria-pressed')).toBe('true');
    expect(add.querySelector('[data-style]')?.getAttribute('data-style')).toContain('rgba(0, 170, 85, 0.18)');
    fireEvent.click(add);
    expect(onModeChange).toHaveBeenLastCalledWith(null);
    const move = screen.getByRole('button', { name: 'sprayLedSetup.movePoint' });
    expect(move.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(move);
    expect(onModeChange).toHaveBeenLastCalledWith('move');
    const undo = screen.getByRole('button', { name: 'sprayLedSetup.undo' });
    expect((undo as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(undo);
    expect(onUndo).not.toHaveBeenCalled();
  });
});
