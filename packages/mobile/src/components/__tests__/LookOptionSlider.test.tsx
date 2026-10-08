// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement, useState, type ReactNode } from 'react';

const slider = vi.hoisted(() => ({
  props: null as null | {
    value: number;
    min: number;
    max: number;
    format: (index: number) => string;
    adjust: (index: number, direction: 1 | -1) => number;
    onLiveChange: (index: number) => void;
    onCommit: (index: number) => void;
    onCancel: () => void;
  },
}));
vi.mock('react-native', () => ({
  View: ({
    children,
    testID,
    accessibilityState,
    pointerEvents,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityState?: { disabled: boolean };
    pointerEvents?: string;
  }) =>
    createElement(
      'div',
      { 'data-testid': testID, 'data-disabled': accessibilityState?.disabled, 'data-pointer': pointerEvents },
      children,
    ),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  PlatformColor: (color: string) => color,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
}));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => true }));
vi.mock('../ValueSlider', () => ({
  ValueSlider: (props: NonNullable<typeof slider.props>) => {
    slider.props = props;
    return createElement('div', { 'data-testid': 'real-track' });
  },
}));
const { LookOptionSlider } = await import('../LookOptionSlider');
const OPTIONS = [
  { id: 'outline', label: 'Outline' },
  { id: 'soft', label: 'Soft glow' },
  { id: 'classic', label: 'Classic' },
];
function Controlled({ onChange, disabled = false }: { onChange: (id: string) => void; disabled?: boolean }) {
  const [value, setValue] = useState('outline');
  return (
    <LookOptionSlider
      options={OPTIONS}
      value={value}
      onChange={(id) => {
        onChange(id);
        setValue(id);
      }}
      accessibilityLabel="Board look"
      disabled={disabled}
      testID="look"
    />
  );
}
beforeEach(() => {
  slider.props = null;
});
afterEach(cleanup);
describe('LookOptionSlider', () => {
  it('maps named options to discrete accessible steps and clamps both ends', () => {
    render(<Controlled onChange={vi.fn()} />);
    expect(slider.props?.format(1)).toBe('Soft glow');
    expect(slider.props?.adjust(0, -1)).toBe(0);
    expect(slider.props?.adjust(2, 1)).toBe(2);
    expect(slider.props?.adjust(0, 1)).toBe(1);
  });
  it('updates the live label once per option and deduplicates release', () => {
    const onChange = vi.fn();
    const { getByText } = render(<Controlled onChange={onChange} />);
    act(() => slider.props?.onLiveChange(1));
    expect(getByText('Soft glow')).toBeTruthy();
    act(() => {
      slider.props?.onLiveChange(1);
      slider.props?.onCommit(1);
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('soft');
  });
  it('restores the committed look after a cancelled drag, then commits accessibility adjustment', () => {
    const onChange = vi.fn();
    const { getByText } = render(<Controlled onChange={onChange} />);
    act(() => slider.props?.onLiveChange(2));
    expect(getByText('Classic')).toBeTruthy();
    act(() => slider.props?.onCancel());
    expect(getByText('Outline')).toBeTruthy();
    act(() => slider.props?.onCommit(1));
    expect(getByText('Soft glow')).toBeTruthy();
    expect(slider.props?.value).toBe(1);
  });
  it('blocks disabled gestures and queued callbacks while publishing one disabled node', () => {
    const onChange = vi.fn();
    const { rerender, getByTestId, getByText } = render(<Controlled onChange={onChange} />);
    const queued = slider.props?.onLiveChange;
    rerender(<Controlled onChange={onChange} disabled />);
    act(() => {
      queued?.(2);
      slider.props?.onCommit(2);
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(getByText('Outline')).toBeTruthy();
    expect(getByTestId('look').getAttribute('data-disabled')).toBe('true');
    expect(getByTestId('look').getAttribute('data-pointer')).toBe('none');
  });
  it('keeps the frozen live choice aligned when saving fails and controls re-enable', () => {
    const { rerender, getByText } = render(<Controlled onChange={vi.fn()} />);
    act(() => slider.props?.onLiveChange(2));
    rerender(<Controlled onChange={vi.fn()} disabled />);
    rerender(<Controlled onChange={vi.fn()} />);
    expect(getByText('Classic')).toBeTruthy();
    expect(slider.props?.value).toBe(2);
  });
  it('does not mount a degenerate track for zero or one option', () => {
    const { queryByTestId, rerender } = render(
      <LookOptionSlider options={[]} value="" onChange={vi.fn()} accessibilityLabel="Look" />,
    );
    expect(queryByTestId('real-track')).toBeNull();
    rerender(<LookOptionSlider options={[OPTIONS[0]]} value="outline" onChange={vi.fn()} accessibilityLabel="Look" />);
    expect(queryByTestId('real-track')).toBeNull();
  });
  it('moves to externally reset options without treating them as live-preview echoes', () => {
    const { rerender } = render(
      <LookOptionSlider options={OPTIONS} value="outline" onChange={vi.fn()} accessibilityLabel="Look" />,
    );
    rerender(<LookOptionSlider options={OPTIONS} value="classic" onChange={vi.fn()} accessibilityLabel="Look" />);
    expect(slider.props?.value).toBe(2);
  });
});
