// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
const native = vi.hoisted(() => ({
  props: null as null | { onValueChange: (value: number) => void; onValueChangeEnd: () => void },
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12 } }));
vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  View: ({
    children,
    accessibilityLabel,
    onAccessibilityAction,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    onAccessibilityAction?: unknown;
  }) =>
    createElement(
      'div',
      { 'data-label': accessibilityLabel, 'data-actions': onAccessibilityAction ? 'yes' : undefined },
      children,
    ),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primaryFill: '#6D28D9' }, systemColors: { secondaryLabel: '#555' } }),
}));
vi.mock('../NativeMarkerSlider', () => ({
  NativeMarkerSlider: (props: NonNullable<typeof native.props>) => {
    native.props = props;
    return createElement('div');
  },
}));
import { MarkerMultiplierSlider } from '../MarkerMultiplierSlider';
beforeEach(() => {
  native.props = null;
});
const format = (value: number) => String(value);
describe('native linear slider persistence contract', () => {
  it('updates the draft throughout a drag and commits once on release', () => {
    const change = vi.fn();
    const commit = vi.fn();
    render(
      <MarkerMultiplierSlider
        accessibilityLabel="Marker size"
        value={1}
        min={0}
        max={2}
        step={0.1}
        format={format}
        onChange={change}
        onChangeEnd={commit}
      />,
    );
    act(() => {
      native.props?.onValueChange(1.23);
      native.props?.onValueChange(1.48);
    });
    expect(change.mock.calls).toEqual([[1.2], [1.5]]);
    expect(commit).not.toHaveBeenCalled();
    act(() => native.props?.onValueChangeEnd());
    expect(commit.mock.calls).toEqual([[1.5]]);
  });
  it('uses the current preset when release occurs without a value-change event', () => {
    const commit = vi.fn();
    const change = vi.fn();
    const props = {
      accessibilityLabel: 'Marker size',
      min: 0,
      max: 2,
      step: 0.1,
      format,
      onChange: change,
      onChangeEnd: commit,
    };
    const view = render(<MarkerMultiplierSlider {...props} value={1} />);
    view.rerender(<MarkerMultiplierSlider {...props} value={1.8} />);
    act(() => native.props?.onValueChangeEnd());
    expect(commit).toHaveBeenCalledWith(1.8);
  });
});
