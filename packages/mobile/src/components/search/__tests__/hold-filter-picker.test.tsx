// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode } from 'react';
import type { HoldFilterEntry, HoldFilterMode, HoldFilterType } from '@boardsesh/shared-schema';

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
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

// gorhom BottomSheet pulls in native modules; the picker only needs a ref with
// imperative snap/close, neither of which affects the tap behaviour under test.
vi.mock('@gorhom/bottom-sheet', () => ({ default: {} }));

// Sheet wraps gorhom; render children inline so the swatches are queryable.
vi.mock('../../Sheet', () => ({
  Sheet: forwardRef<unknown, { children?: ReactNode }>(function SheetMock({ children }, _ref) {
    return createElement('div', { 'data-sheet': 'true' }, children);
  }),
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
  spacing: { 2: 8, 3: 12, 4: 16 },
  borderRadius: { md: 8 },
}));

vi.mock('react-i18next', () => ({
  // The swatch a11y label is `${type label}, ${state suffix}`. Returning the key
  // lets the test target a swatch by its stable label key.
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { HoldFilterPicker } from '../HoldFilterPicker';

type PickerOverrides = {
  entry?: HoldFilterEntry;
  applyMode?: HoldFilterMode;
  onToggleType?: (type: HoldFilterType) => void;
  onApplyModeChange?: (mode: HoldFilterMode) => void;
  onClear?: () => void;
};

function renderPicker(overrides: PickerOverrides = {}) {
  const onToggleType = overrides.onToggleType ?? vi.fn();
  const onApplyModeChange = overrides.onApplyModeChange ?? vi.fn();
  const onClear = overrides.onClear ?? vi.fn();
  const result = render(
    <HoldFilterPicker
      holdId={42}
      boardName="kilter"
      entry={overrides.entry ?? {}}
      applyMode={overrides.applyMode ?? 'include'}
      onApplyModeChange={onApplyModeChange}
      onToggleType={onToggleType}
      onClear={onClear}
      onClose={vi.fn()}
    />,
  );
  return { ...result, onToggleType, onApplyModeChange, onClear };
}

// Swatch buttons carry a `${typeLabel}` (or `${typeLabel}, ${suffix}`) a11y
// label. With the i18n mock returning keys, an idle HAND swatch reads exactly
// `mobile.holdFilter.type.hand`.
function swatch(container: HTMLElement, typeKey: string): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll('button'));
  return (buttons.find((button) => (button.getAttribute('data-label') ?? '').startsWith(typeKey)) ??
    null) as HTMLButtonElement | null;
}

describe('HoldFilterPicker', () => {
  beforeEach(() => {
    haptics.selection.mockClear();
  });

  it('renders one swatch per board hold type plus ANY', () => {
    const { container } = renderPicker();
    // Kilter picker states + the trailing ANY swatch.
    expect(swatch(container, 'mobile.holdFilter.type.hand')).not.toBeNull();
    expect(swatch(container, 'mobile.holdFilter.type.starting')).not.toBeNull();
    expect(swatch(container, 'mobile.holdFilter.type.finish')).not.toBeNull();
    expect(swatch(container, 'mobile.holdFilter.type.foot')).not.toBeNull();
    expect(swatch(container, 'mobile.holdFilter.type.any')).not.toBeNull();
  });

  it('tapping a swatch toggles that hold type (direction owned by apply mode)', () => {
    const { container, onToggleType } = renderPicker({ applyMode: 'include' });
    fireEvent.click(swatch(container, 'mobile.holdFilter.type.hand')!);
    expect(onToggleType).toHaveBeenCalledTimes(1);
    expect(onToggleType).toHaveBeenCalledWith('HAND');
    expect(haptics.selection).toHaveBeenCalledTimes(1);
  });

  it('uses the exclude apply mode without changing the toggled type', () => {
    // In exclude mode the same swatch tap still reports its type; the parent
    // resolves include vs exclude from applyMode, so the picker only emits type.
    const { container, onToggleType } = renderPicker({ applyMode: 'exclude' });
    fireEvent.click(swatch(container, 'mobile.holdFilter.type.foot')!);
    expect(onToggleType).toHaveBeenCalledWith('FOOT');
  });

  it('marks a swatch selected when its type is in the entry', () => {
    const { container } = renderPicker({ entry: { HAND: 'include' } });
    expect(swatch(container, 'mobile.holdFilter.type.hand')!.getAttribute('data-selected')).toBe('true');
    expect(swatch(container, 'mobile.holdFilter.type.foot')!.getAttribute('data-selected')).toBe('false');
  });

  it('switches the apply mode via the segmented control', () => {
    const { container, onApplyModeChange } = renderPicker({ applyMode: 'include' });
    const excludeSegment = container.querySelector('[data-segment="exclude"]') as HTMLButtonElement;
    fireEvent.click(excludeSegment);
    expect(onApplyModeChange).toHaveBeenCalledWith('exclude');
  });

  it('clears the hold when the clear row is tapped and the entry is non-empty', () => {
    const { container, onClear } = renderPicker({ entry: { HAND: 'include' } });
    const clearButton = container.querySelector('[data-label="mobile.holdFilter.clearHold"]') as HTMLButtonElement;
    fireEvent.click(clearButton);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('disables clear and does not fire onClear when the entry is empty', () => {
    const { container, onClear } = renderPicker({ entry: {} });
    const clearButton = container.querySelector('[data-label="mobile.holdFilter.clearHold"]') as HTMLButtonElement;
    expect(clearButton.disabled).toBe(true);
    fireEvent.click(clearButton);
    expect(onClear).not.toHaveBeenCalled();
  });
});
