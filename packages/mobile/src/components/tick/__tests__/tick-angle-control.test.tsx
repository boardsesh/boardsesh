// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// TickAngleControl picks between the native AngleSlider and the SegmentedControl
// and works out the stops it hands them. Both controls are native trees, so
// each stub records the props it was given as data attributes; what is pinned
// here is that wiring, not the controls themselves.

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { angle?: number }) => (options?.angle == null ? key : `${options.angle}°`),
  }),
}));
// AngleSlider.logic imports the haptics module, which pulls in native code.
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ spacing: { 2: 8, 3: 12 } }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, numeric }: { children?: ReactNode; numeric?: boolean }) =>
    createElement('span', { 'data-testid': 'angle-number', 'data-numeric': String(Boolean(numeric)) }, children),
}));
vi.mock('../AngleGlyph', () => ({
  AngleGlyph: ({ angle }: { angle: number }) =>
    createElement('i', { 'data-testid': 'angle-glyph', 'data-angle': angle }),
}));
vi.mock('../../play-drawer/AngleSlider', () => ({
  AngleSlider: ({
    angles,
    value,
    onChange,
    accessibilityLabel,
    showValue,
  }: {
    angles: number[];
    value: number;
    onChange: (angle: number) => void;
    accessibilityLabel?: string;
    showValue?: boolean;
  }) =>
    createElement('button', {
      'data-testid': 'angle-slider',
      'data-stops': angles.join(','),
      'data-value': String(value),
      'data-label': accessibilityLabel,
      'data-show-value': String(showValue),
      onClick: () => onChange(angles[angles.length - 1]),
    }),
}));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    selectedKey,
    onSelect,
    accessibilityLabel,
  }: {
    options: { key: string; label: string }[];
    selectedKey: string;
    onSelect: (key: string) => void;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'div',
      {
        'data-testid': 'angle-segments',
        'data-keys': options.map((option) => option.key).join(','),
        'data-labels': options.map((option) => option.label).join(','),
        'data-selected': selectedKey,
        'data-label': accessibilityLabel,
      },
      options.map((option) =>
        createElement('button', {
          key: option.key,
          'data-testid': `segment-${option.key}`,
          onClick: () => onSelect(option.key),
        }),
      ),
    ),
}));

import { TickAngleControl, shouldShowAngleRow } from '../TickAngleControl';

// A 15-stop table, 0° through 70° in 5° steps.
const KILTER = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70];
const MOONBOARD = [25, 40];

function renderControl(props: { angles: number[]; value: number; openingValue?: number }) {
  const onChange = vi.fn();
  const utils = render(createElement(TickAngleControl, { ...props, onChange, accessibilityLabel: 'Angle' }));
  return { onChange, ...utils };
}

describe('TickAngleControl with a slider', () => {
  it('hands the slider the stops, the label and no value text of its own', () => {
    const { getByTestId, queryByTestId } = renderControl({ angles: KILTER, value: 40 });

    const slider = getByTestId('angle-slider');
    expect(slider.getAttribute('data-stops')).toBe(KILTER.join(','));
    expect(slider.getAttribute('data-value')).toBe('40');
    expect(slider.getAttribute('data-label')).toBe('Angle');
    expect(slider.getAttribute('data-show-value')).toBe('false');
    expect(queryByTestId('angle-segments')).toBeNull();
  });

  it('prints the angle as a tabular number beside the glyph', () => {
    const { getByTestId } = renderControl({ angles: KILTER, value: 40 });

    expect(getByTestId('angle-number').textContent).toBe('40°');
    expect(getByTestId('angle-number').getAttribute('data-numeric')).toBe('true');
    expect(getByTestId('angle-glyph').getAttribute('data-angle')).toBe('40');
  });

  it('writes a slab angle with an ASCII minus', () => {
    const { getByTestId } = renderControl({ angles: [-5, ...KILTER], value: -5 });

    expect(getByTestId('angle-number').textContent).toBe('-5°');
  });

  it('gives an off-table angle its own stop instead of parking the thumb on the first one', () => {
    const { getByTestId } = renderControl({ angles: KILTER, value: 37 });

    expect(getByTestId('angle-number').textContent).toBe('37°');
    expect(getByTestId('angle-slider').getAttribute('data-stops')?.split(',')).toContain('37');
  });

  it('keeps the opening angle as a stop after the climber moves off it', () => {
    const { getByTestId } = renderControl({ angles: KILTER, value: 40, openingValue: 37 });

    expect(getByTestId('angle-slider').getAttribute('data-stops')).toBe(
      [0, 5, 10, 15, 20, 25, 30, 35, 37, 40, 45, 50, 55, 60, 65, 70].join(','),
    );
  });

  it('passes the slider pick straight through', () => {
    const { getByTestId, onChange } = renderControl({ angles: KILTER, value: 40 });

    fireEvent.click(getByTestId('angle-slider'));
    expect(onChange).toHaveBeenCalledWith(70);
  });
});

describe('TickAngleControl with two stops', () => {
  it('swaps the slider for segments and drops the number the segments already show', () => {
    const { getByTestId, queryByTestId } = renderControl({ angles: MOONBOARD, value: 40 });

    const segments = getByTestId('angle-segments');
    expect(segments.getAttribute('data-keys')).toBe('25,40');
    expect(segments.getAttribute('data-labels')).toBe('25°,40°');
    expect(segments.getAttribute('data-selected')).toBe('40');
    expect(segments.getAttribute('data-label')).toBe('Angle');
    expect(queryByTestId('angle-slider')).toBeNull();
    expect(queryByTestId('angle-number')).toBeNull();
    expect(getByTestId('angle-glyph')).toBeTruthy();
  });

  it('emits the picked segment as a number', () => {
    const { getByTestId, onChange } = renderControl({ angles: MOONBOARD, value: 40 });

    fireEvent.click(getByTestId('segment-25'));
    expect(onChange).toHaveBeenCalledWith(25);
  });

  it('counts stops after an off-table angle goes in, so three stops get the slider', () => {
    const { getByTestId, queryByTestId } = renderControl({ angles: MOONBOARD, value: 30 });

    expect(getByTestId('angle-slider').getAttribute('data-stops')).toBe('25,30,40');
    expect(queryByTestId('angle-segments')).toBeNull();
  });
});

describe('shouldShowAngleRow', () => {
  it('hides the row on a spray wall, whose angle the wall fixes', () => {
    expect(shouldShowAngleRow('spray', KILTER)).toBe(false);
  });

  it('hides the row when the board has fewer than two angles to pick from', () => {
    expect(shouldShowAngleRow('kilter', [])).toBe(false);
    expect(shouldShowAngleRow('kilter', [40])).toBe(false);
  });

  it('shows the row from two angles up', () => {
    expect(shouldShowAngleRow('moonboard', MOONBOARD)).toBe(true);
    expect(shouldShowAngleRow('kilter', KILTER)).toBe(true);
  });

  it('shows the row while the board is still unknown, as long as there are angles', () => {
    expect(shouldShowAngleRow(undefined, KILTER)).toBe(true);
  });
});
