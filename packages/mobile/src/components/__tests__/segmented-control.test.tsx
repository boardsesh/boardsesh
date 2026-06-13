// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Controls the resolved UI variant the SegmentedControl branches on.
const ctrl = vi.hoisted(() => ({ variant: 'material' as 'material' | 'liquidGlass' }));
const hapticSelectionMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-view': 'true' }, children),
}));

// Paper SegmentedButtons → <div> exposing the props the test asserts on.
type PaperButton = {
  value: string;
  label?: string;
  disabled?: boolean;
  checkedColor?: string;
  style?: unknown;
};
vi.mock('react-native-paper', () => ({
  SegmentedButtons: ({
    value,
    onValueChange,
    buttons,
  }: {
    value: string;
    onValueChange: (next: string) => void;
    buttons: PaperButton[];
  }) =>
    createElement(
      'div',
      { 'data-paper-segmented': 'true', 'data-value': value },
      buttons.map((button) =>
        createElement('button', {
          key: button.value,
          'data-segment-value': button.value,
          'data-disabled': button.disabled ? 'true' : 'false',
          'data-checked-color': button.checkedColor ?? '',
          'data-style': JSON.stringify(button.style ?? null),
          // Real Paper never fires onValueChange for a disabled button.
          onClick: button.disabled ? undefined : () => onValueChange(button.value),
        }),
      ),
    ),
}));

// Glass-path deps — the PressableSurface fallback renders a plain div.
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-pressable': 'true', 'data-style': JSON.stringify(style ?? null) }, children),
}));
vi.mock('../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: string }) =>
    createElement('span', { 'data-color': color ?? '' }, children),
}));
vi.mock('../../lib/haptics', () => ({ hapticSelection: hapticSelectionMock }));
vi.mock('../../theme/colors', () => ({ brandColors: { primary: '#6D28D9' } }));
vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8 } }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: ctrl.variant,
    colorScheme: 'light',
    systemColors: { elevatedSurface: '#fff', label: '#000' },
    opacity: { disabled: 0.4 },
    brandColors: { primary: '#6D28D9' },
  }),
}));

import { SegmentedControl } from '../SegmentedControl';

const options = [
  { key: 'a', label: 'Alpha' },
  { key: 'b', label: 'Beta' },
] as const;

describe('SegmentedControl', () => {
  it('renders Paper SegmentedButtons on the Material variant', () => {
    ctrl.variant = 'material';
    const { container } = render(
      <SegmentedControl
        options={[...options]}
        selectedKey="a"
        onSelect={() => {}}
        trackColor="#eee"
        accessibilityLabel="Appearance"
      />,
    );
    const paper = container.querySelector('[data-paper-segmented]');
    expect(paper).not.toBeNull();
    expect(paper?.getAttribute('data-value')).toBe('a');
    expect(container.querySelector('[data-pressable]')).toBeNull();
  });

  it('fires haptics and onSelect on the Material variant', () => {
    ctrl.variant = 'material';
    hapticSelectionMock.mockClear();
    const onSelect = vi.fn();
    const { container } = render(
      <SegmentedControl options={[...options]} selectedKey="a" onSelect={onSelect} trackColor="#eee" />,
    );
    container.querySelector<HTMLButtonElement>('[data-segment-value="b"]')?.click();
    expect(hapticSelectionMock).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('does not select a disabled key on the Material variant', () => {
    ctrl.variant = 'material';
    hapticSelectionMock.mockClear();
    const onSelect = vi.fn();
    const { container } = render(
      <SegmentedControl
        options={[...options]}
        selectedKey="a"
        onSelect={onSelect}
        trackColor="#eee"
        disabledKeys={new Set(['b'])}
      />,
    );
    const disabled = container.querySelector('[data-segment-value="b"]');
    expect(disabled?.getAttribute('data-disabled')).toBe('true');
    disabled?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(hapticSelectionMock).not.toHaveBeenCalled();
  });

  it('passes custom selected colors to the Material selected segment', () => {
    ctrl.variant = 'material';
    const { container } = render(
      <SegmentedControl
        options={[...options]}
        selectedKey="a"
        onSelect={() => {}}
        trackColor="#eee"
        selectedTrackColor="#123456"
        selectedTextColor="#ffffff"
      />,
    );

    const selected = container.querySelector('[data-segment-value="a"]');
    const unselected = container.querySelector('[data-segment-value="b"]');
    expect(selected?.getAttribute('data-style')).toContain('#123456');
    expect(selected?.getAttribute('data-checked-color')).toBe('#ffffff');
    expect(unselected?.getAttribute('data-style')).toBe('null');
  });

  it('supports rendering without a selected segment on the Material variant', () => {
    ctrl.variant = 'material';
    const { container } = render(
      <SegmentedControl
        options={[...options]}
        selectedKey={null}
        onSelect={() => {}}
        trackColor="#eee"
        selectedTrackColor="#123456"
        selectedTextColor="#ffffff"
      />,
    );

    expect(container.querySelector('[data-paper-segmented]')?.getAttribute('data-value')).toBe('');
    expect(container.querySelector('[data-segment-value="a"]')?.getAttribute('data-style')).toBe('null');
  });

  it('supports rendering without a selected segment on the Liquid Glass variant', () => {
    ctrl.variant = 'liquidGlass';
    const { container } = render(
      <SegmentedControl
        options={[...options]}
        selectedKey={null}
        onSelect={() => {}}
        trackColor="#eee"
        selectedTrackColor="#123456"
        selectedTextColor="#ffffff"
      />,
    );

    const firstSegment = container.querySelector('[data-pressable]');
    expect(firstSegment?.getAttribute('data-style')).not.toContain('#123456');
    expect(firstSegment?.querySelector('span')?.getAttribute('data-color')).toBe('');
  });

  it('renders the Liquid Glass (PressableSurface) control on the Liquid Glass variant', () => {
    ctrl.variant = 'liquidGlass';
    const { container } = render(
      <SegmentedControl options={[...options]} selectedKey="a" onSelect={() => {}} trackColor="#eee" />,
    );
    expect(container.querySelector('[data-pressable]')).not.toBeNull();
    expect(container.querySelector('[data-paper-segmented]')).toBeNull();
  });

  it('uses custom selected colors on the Liquid Glass selected segment', () => {
    ctrl.variant = 'liquidGlass';
    const { container } = render(
      <SegmentedControl
        options={[...options]}
        selectedKey="a"
        onSelect={() => {}}
        trackColor="#eee"
        selectedTrackColor="#123456"
        selectedTextColor="#ffffff"
      />,
    );

    const selected = container.querySelector('[data-pressable]');
    expect(selected?.getAttribute('data-style')).toContain('#123456');
    expect(selected?.querySelector('span')?.getAttribute('data-color')).toBe('#ffffff');
  });
});
