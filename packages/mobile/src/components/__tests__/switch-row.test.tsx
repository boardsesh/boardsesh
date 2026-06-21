// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Controls the resolved UI variant the SwitchRow branches on for its toggle.
const ctrl = vi.hoisted(() => ({ variant: 'material' as 'material' | 'liquidGlass' }));
const hapticSelectionMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-view': 'true' }, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('div', { 'data-pressable': 'true', onClick: onPress }, children),
  // The RN Switch (Liquid Glass path) renders a distinct element.
  Switch: (props: { value?: boolean; onValueChange?: (next: boolean) => void }) =>
    createElement('input', {
      'data-rn-switch': 'true',
      type: 'checkbox',
      checked: !!props.value,
      onChange: () => props.onValueChange?.(!props.value),
      readOnly: true,
    }),
}));

// Paper Switch → <input> exposing the props the test asserts on.
vi.mock('react-native-paper', () => ({
  Switch: (props: { value?: boolean; onValueChange?: (next: boolean) => void; disabled?: boolean }) =>
    createElement('input', {
      'data-paper-switch': 'true',
      type: 'checkbox',
      checked: !!props.value,
      disabled: props.disabled,
      onChange: () => props.onValueChange?.(!props.value),
      readOnly: true,
    }),
}));

vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../../lib/haptics', () => ({ hapticSelection: hapticSelectionMock }));
vi.mock('../../theme/ios-colors', () => ({ iosSystemColors: { systemGray4: '#ccc' } }));
vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ variant: ctrl.variant, brandColors: { primaryFill: '#7C3AED' } }),
}));

import { SwitchRow } from '../SwitchRow';

describe('SwitchRow', () => {
  it('renders the Paper Switch on the Material variant', () => {
    ctrl.variant = 'material';
    const { container } = render(<SwitchRow label="Sound" value={false} onValueChange={() => {}} />);
    expect(container.querySelector('[data-paper-switch]')).not.toBeNull();
    expect(container.querySelector('[data-rn-switch]')).toBeNull();
  });

  it('renders the RN Switch on the Liquid Glass variant', () => {
    ctrl.variant = 'liquidGlass';
    const { container } = render(<SwitchRow label="Sound" value={false} onValueChange={() => {}} />);
    expect(container.querySelector('[data-rn-switch]')).not.toBeNull();
    expect(container.querySelector('[data-paper-switch]')).toBeNull();
  });

  it('toggles exactly once from the row press on Material (no double-fire)', () => {
    ctrl.variant = 'material';
    hapticSelectionMock.mockClear();
    const onValueChange = vi.fn();
    const { container } = render(<SwitchRow label="Sound" value={false} onValueChange={onValueChange} />);
    // The row Pressable is the sole toggle target; the Paper Switch is a
    // non-interactive indicator, so a single press fires the toggle once.
    const row = container.querySelector('[data-pressable]');
    expect(row).not.toBeNull();
    fireEvent.click(row as Element);
    expect(hapticSelectionMock).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(true);
  });

  it('does not toggle from the Paper Switch itself (it is non-interactive)', () => {
    ctrl.variant = 'material';
    hapticSelectionMock.mockClear();
    const onValueChange = vi.fn();
    const { container } = render(<SwitchRow label="Sound" value={false} onValueChange={onValueChange} />);
    const toggle = container.querySelector('[data-paper-switch]') as Element;
    // SwitchRow no longer wires onValueChange to the Paper Switch, so firing its
    // change directly is a no-op (the row owns the toggle).
    fireEvent.change(toggle, { target: { checked: true } });
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
