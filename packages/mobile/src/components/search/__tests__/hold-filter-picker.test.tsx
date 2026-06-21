// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { HoldFilterMode, HoldFilterType } from '@boardsesh/shared-schema';

const haptics = vi.hoisted(() => ({ selection: vi.fn() }));

type PressableMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityState?: { selected?: boolean; disabled?: boolean };
};
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityState }: PressableMockProps) =>
    createElement(
      'button',
      {
        onClick: onPress,
        disabled: disabled ?? false,
        'data-label': accessibilityLabel ?? '',
        'data-selected': accessibilityState?.selected ? 'true' : 'false',
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

type SvgMockProps = {
  children?: ReactNode;
};

vi.mock('react-native-svg', () => ({
  default: ({ children }: SvgMockProps) => createElement('svg', { 'data-svg': 'true' }, children),
  Circle: () => createElement('circle', { 'data-svg-shape': 'circle' }),
  Polygon: () => createElement('polygon', { 'data-svg-shape': 'polygon' }),
  Rect: () => createElement('rect', { 'data-svg-shape': 'rect' }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));

type SegmentMockProps = {
  options: ReadonlyArray<{ key: string; label: string }>;
  selectedKey: string;
  onSelect: (key: string) => void;
};
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({ options, selectedKey, onSelect }: SegmentMockProps) =>
    createElement(
      'div',
      { 'data-segmented': 'true', 'data-selected-key': selectedKey },
      options.map((option) =>
        createElement(
          'button',
          { key: option.key, 'data-segment': option.key, onClick: () => onSelect(option.key) },
          option.label,
        ),
      ),
    ),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { fill: '#EEE', secondaryLabel: '#999' } }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: () => haptics.selection() }));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { md: 8 },
}));

vi.mock('react-i18next', () => ({
  // The swatch a11y label is `${type label}, ${state suffix}`. Returning the key
  // lets the test target a swatch by its stable label key.
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { HoldFilterPicker } from '../HoldFilterPicker';

type PickerOverrides = {
  selectedType?: HoldFilterType;
  applyMode?: HoldFilterMode;
  onSelectType?: (type: HoldFilterType) => void;
  onApplyModeChange?: (mode: HoldFilterMode) => void;
};

function renderPicker(overrides: PickerOverrides = {}) {
  const onSelectType = overrides.onSelectType ?? vi.fn();
  const onApplyModeChange = overrides.onApplyModeChange ?? vi.fn();
  const result = render(
    <HoldFilterPicker
      boardName="kilter"
      selectedType={overrides.selectedType ?? 'HAND'}
      onSelectType={onSelectType}
      applyMode={overrides.applyMode ?? 'include'}
      onApplyModeChange={onApplyModeChange}
    />,
  );
  return { ...result, onSelectType, onApplyModeChange };
}

// Chip buttons carry a `${typeLabel}` (or `${typeLabel}, ${suffix}` when they're
// the active brush) a11y label. With the i18n mock returning keys, an unselected
// HAND chip reads exactly `mobile.holdFilter.type.hand`.
function chip(container: HTMLElement, typeKey: string): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll('button'));
  return (buttons.find((button) => (button.getAttribute('data-label') ?? '').startsWith(typeKey)) ??
    null) as HTMLButtonElement | null;
}

describe('HoldFilterPicker', () => {
  beforeEach(() => {
    haptics.selection.mockClear();
  });

  it('renders one chip per board hold type plus ANY', () => {
    const { container } = renderPicker();
    // Kilter picker states + the trailing ANY chip.
    expect(chip(container, 'mobile.holdFilter.type.hand')).not.toBeNull();
    expect(chip(container, 'mobile.holdFilter.type.starting')).not.toBeNull();
    expect(chip(container, 'mobile.holdFilter.type.finish')).not.toBeNull();
    expect(chip(container, 'mobile.holdFilter.type.foot')).not.toBeNull();
    expect(chip(container, 'mobile.holdFilter.type.any')).not.toBeNull();
  });

  it('selecting a chip sets it as the active brush', () => {
    const { container, onSelectType } = renderPicker({ selectedType: 'HAND' });
    fireEvent.click(chip(container, 'mobile.holdFilter.type.foot')!);
    expect(onSelectType).toHaveBeenCalledTimes(1);
    expect(onSelectType).toHaveBeenCalledWith('FOOT');
    expect(haptics.selection).toHaveBeenCalledTimes(1);
  });

  it('marks the active brush chip as selected', () => {
    const { container } = renderPicker({ selectedType: 'HAND' });
    expect(chip(container, 'mobile.holdFilter.type.hand')!.getAttribute('data-selected')).toBe('true');
    expect(chip(container, 'mobile.holdFilter.type.foot')!.getAttribute('data-selected')).toBe('false');
  });

  it('switches the apply mode via the segmented control', () => {
    const { container, onApplyModeChange } = renderPicker({ applyMode: 'include' });
    const excludeSegment = container.querySelector('[data-segment="exclude"]') as HTMLButtonElement;
    fireEvent.click(excludeSegment);
    expect(onApplyModeChange).toHaveBeenCalledWith('exclude');
  });
});
