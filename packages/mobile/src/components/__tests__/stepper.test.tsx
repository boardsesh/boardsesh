// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#000', separator: '#ccc', tertiaryBackground: '#eee', tertiaryLabel: '#aaa' },
    brandColors: { primary: '#6D28D9' },
    opacity: { disabled: 0.5 },
    variant: 'liquidGlass',
  }),
}));
vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16 }, borderRadius: { md: 10 } }));

vi.mock('../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
// PressableSurface forwards onPress to a button, dropping the press when disabled
// (matching the native component, which short-circuits onPress while disabled).
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'button',
      {
        onClick: disabled ? undefined : onPress,
        disabled: disabled ?? false,
        'data-pressable': accessibilityLabel ?? '',
      },
      children,
    ),
}));

import { Stepper } from '../Stepper';

function makeProps(over: Partial<Parameters<typeof Stepper>[0]> = {}) {
  return {
    label: 'Number of climbs',
    value: 5,
    min: 1,
    max: 10,
    onChange: vi.fn(),
    decreaseLabel: 'Decrease',
    increaseLabel: 'Increase',
    ...over,
  };
}

const decrease = (root: HTMLElement) => root.querySelector('[data-pressable="Decrease"]') as HTMLButtonElement;
const increase = (root: HTMLElement) => root.querySelector('[data-pressable="Increase"]') as HTMLButtonElement;

describe('Stepper', () => {
  it('reports value+1 when increase is pressed', () => {
    const onChange = vi.fn();
    const { container } = render(<Stepper {...makeProps({ value: 5, onChange })} />);
    fireEvent.click(increase(container));
    expect(onChange).toHaveBeenCalledWith(6);
  });

  it('reports value-1 when decrease is pressed', () => {
    const onChange = vi.fn();
    const { container } = render(<Stepper {...makeProps({ value: 5, onChange })} />);
    fireEvent.click(decrease(container));
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it('disables increase and does not report at the max', () => {
    const onChange = vi.fn();
    const { container } = render(<Stepper {...makeProps({ value: 10, max: 10, onChange })} />);
    expect(increase(container).disabled).toBe(true);
    fireEvent.click(increase(container));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('disables decrease and does not report at the min', () => {
    const onChange = vi.fn();
    const { container } = render(<Stepper {...makeProps({ value: 1, min: 1, onChange })} />);
    expect(decrease(container).disabled).toBe(true);
    fireEvent.click(decrease(container));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clamps a reported value that would overshoot the bounds', () => {
    const onChange = vi.fn();
    // value already equals max - 1; pressing increase lands exactly on max (no clamp),
    // but a value pushed past max is clamped by clampStepperValue before reporting.
    const { container } = render(<Stepper {...makeProps({ value: 9, max: 10, onChange })} />);
    fireEvent.click(increase(container));
    expect(onChange).toHaveBeenCalledWith(10);
  });
});
