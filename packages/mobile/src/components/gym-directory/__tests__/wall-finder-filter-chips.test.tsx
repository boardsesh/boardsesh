// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type Children = { children?: ReactNode };
type PressProps = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string };

const hapticSelection = vi.fn();

vi.mock('@boardsesh/board-config', () => ({
  SUPPORTED_BOARDS: ['kilter', 'tension', 'moonboard', 'woods'],
  formatBoardDisplayName: (boardType: string) => boardType.charAt(0).toUpperCase() + boardType.slice(1),
}));

vi.mock('react-native', () => ({
  Pressable: ({ children, onPress, accessibilityLabel }: PressProps) =>
    createElement('button', { onClick: onPress, type: 'button', 'aria-label': accessibilityLabel }, children),
  ScrollView: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: (component: unknown) => component },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value }),
  withSpring: (value: number) => value,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12 } }));
vi.mock('../../../theme/animations', () => ({ springs: { snappy: {} } }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: () => hapticSelection() }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primary: '#6D28D9' }, systemColors: { separator: '#ccc' } }),
}));

import { WallFinderFilterChips, type WallFinderFilterChipsProps } from '../WallFinderFilterChips';

// Minimal props with everything off / empty; specs override what they exercise.
function baseProps(overrides: Partial<WallFinderFilterChipsProps> = {}): WallFinderFilterChipsProps {
  return {
    selected: [],
    onToggle: vi.fn(),
    multiBoardTypeOnly: false,
    onToggleMultiBoardType: vi.fn(),
    multiBoardLabel: '2+ board types',
    layoutOptions: [],
    selectedLayoutIds: [],
    onToggleLayout: vi.fn(),
    sizeOptions: [],
    selectedSizeIds: [],
    onToggleSize: vi.fn(),
    onClear: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => hapticSelection.mockClear());

describe('WallFinderFilterChips', () => {
  it('renders the multi-board chip and a chip per supported board', () => {
    const { getByText } = render(<WallFinderFilterChips {...baseProps()} />);
    expect(getByText('2+ board types')).toBeTruthy();
    expect(getByText('Kilter')).toBeTruthy();
    expect(getByText('Tension')).toBeTruthy();
    expect(getByText('Moonboard')).toBeTruthy();
  });

  // Woods rides the same generic chip row, but it's the board whose layout/size
  // tiers used to come up empty (#4751) — so pin the whole cascade end to end.
  it('renders the Woods chip and its layout + size chips', () => {
    const onToggle = vi.fn();
    const onToggleLayout = vi.fn();
    const onToggleSize = vi.fn();
    const { getByText, getByLabelText } = render(
      <WallFinderFilterChips
        {...baseProps({
          selected: ['woods'],
          onToggle,
          onToggleLayout,
          onToggleSize,
          layoutOptions: [{ id: 1, label: 'Original' }],
          sizeOptions: [
            { label: '8 x 10', sizeIds: [1] },
            { label: '12 x 12', sizeIds: [2] },
          ],
        })}
      />,
    );

    fireEvent.click(getByLabelText('Woods'));
    expect(onToggle).toHaveBeenCalledWith('woods');

    fireEvent.click(getByText('Original'));
    expect(onToggleLayout).toHaveBeenCalledWith(1);

    fireEvent.click(getByText('12 x 12'));
    expect(onToggleSize).toHaveBeenCalledWith([2]);
  });

  it('toggles a board type (with a haptic) when its chip is tapped', () => {
    const onToggle = vi.fn();
    const { getByLabelText } = render(<WallFinderFilterChips {...baseProps({ onToggle })} />);
    fireEvent.click(getByLabelText('Tension'));
    expect(onToggle).toHaveBeenCalledWith('tension');
    expect(hapticSelection).toHaveBeenCalledTimes(1);
  });

  it('toggles the multi-board filter when its chip is tapped', () => {
    const onToggleMultiBoardType = vi.fn();
    const { getByText } = render(<WallFinderFilterChips {...baseProps({ onToggleMultiBoardType })} />);
    fireEvent.click(getByText('2+ board types'));
    expect(onToggleMultiBoardType).toHaveBeenCalledTimes(1);
  });

  it('renders layout chips only when given options, and toggles them', () => {
    const onToggleLayout = vi.fn();
    const { queryByText, rerender, getByText } = render(<WallFinderFilterChips {...baseProps()} />);
    expect(queryByText('Kilter Board Original')).toBeNull();
    rerender(
      <WallFinderFilterChips
        {...baseProps({ layoutOptions: [{ id: 1, label: 'Kilter Board Original' }], onToggleLayout })}
      />,
    );
    fireEvent.click(getByText('Kilter Board Original'));
    expect(onToggleLayout).toHaveBeenCalledWith(1);
  });

  it('renders size chips and toggles the whole id group', () => {
    const onToggleSize = vi.fn();
    const { getByText } = render(
      <WallFinderFilterChips {...baseProps({ sizeOptions: [{ label: '16x10', sizeIds: [21, 22] }], onToggleSize })} />,
    );
    fireEvent.click(getByText('16x10'));
    expect(onToggleSize).toHaveBeenCalledWith([21, 22]);
  });

  it('hides Clear when nothing is active and shows it once any filter is set', () => {
    const { queryByText, rerender, getByText } = render(<WallFinderFilterChips {...baseProps()} />);
    expect(queryByText('actions.clear')).toBeNull();
    rerender(<WallFinderFilterChips {...baseProps({ multiBoardTypeOnly: true })} />);
    expect(getByText('actions.clear')).toBeTruthy();
  });

  it('calls onClear when Clear is tapped', () => {
    const onClear = vi.fn();
    const { getByText } = render(<WallFinderFilterChips {...baseProps({ selected: ['kilter'], onClear })} />);
    fireEvent.click(getByText('actions.clear'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
