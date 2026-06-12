// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle, type MouseEvent, type ReactNode, type RefObject } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { SearchHeaderHandle } from '../../SearchHeader';

type BoardLabelFields = Pick<
  UserBoard,
  'name' | 'angle' | 'boardType' | 'sizeName' | 'layoutName' | 'layoutId' | 'isAngleAdjustable'
>;

type BluetoothCtx = {
  isConnected: boolean;
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
} | null;

const ctrl = vi.hoisted(() => ({
  board: null as BoardLabelFields | null,
  bluetooth: null as BluetoothCtx,
  setActiveBoard: vi.fn(),
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
}));
const haptics = vi.hoisted(() => ({ light: vi.fn(), selection: vi.fn() }));

type ViewMockProps = {
  children?: ReactNode;
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
};
vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn() },
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress, 'data-scrim': 'true' }, children),
  View: ({ children, onLayout }: ViewMockProps) =>
    createElement(
      'div',
      {
        'data-has-layout': onLayout ? 'true' : 'false',
        onClick: onLayout ? () => onLayout({ nativeEvent: { layout: { height: 88 } } }) : undefined,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));

vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children, pointerEvents }: { children?: ReactNode; pointerEvents?: string }) =>
      createElement('div', { 'data-pointer': pointerEvents ?? '' }, children),
  },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  Extrapolation: { CLAMP: 'clamp' },
  interpolate: () => 0,
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useAnimatedReaction: () => {},
  useAnimatedStyle: () => ({}),
  useDerivedValue: () => ({ value: 0 }),
}));

vi.mock('expo-router', () => ({ useFocusEffect: () => {} }));
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-gradient': 'true' }, children),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { count?: number }) => (params?.count != null ? `${key}:${params.count}` : key),
  }),
}));

vi.mock('react-native-paper', () => ({
  Appbar: {
    Header: ({ children }: { children?: ReactNode }) =>
      createElement('div', { 'data-appbar-header': 'true' }, children),
    Content: ({ title, subtitle, onPress }: { title?: ReactNode; subtitle?: ReactNode; onPress?: () => void }) =>
      createElement(
        'button',
        { onClick: onPress, 'data-appbar-content': 'true' },
        createElement('span', { 'data-appbar-title': 'true' }, title),
        subtitle ? createElement('span', { 'data-appbar-subtitle': 'true' }, subtitle) : null,
      ),
    Action: ({
      icon,
      onPress,
      accessibilityLabel,
    }: {
      icon?: ReactNode | ((props: { color: string; size: number }) => ReactNode);
      onPress?: () => void;
      accessibilityLabel?: string;
    }) =>
      createElement(
        'button',
        { onClick: onPress, 'data-appbar-action': accessibilityLabel ?? '' },
        typeof icon === 'function' ? icon({ color: '#000', size: 24 }) : icon,
      ),
  },
  Chip: ({
    children,
    onPress,
    onClose,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    onClose?: () => void;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'button',
      { onClick: onPress, 'data-chip': accessibilityLabel ?? '' },
      children,
      onClose
        ? createElement(
            'span',
            {
              'data-chip-close': accessibilityLabel ?? '',
              onClick: (event: MouseEvent<HTMLSpanElement>) => {
                event.stopPropagation();
                onClose();
              },
            },
            'close',
          )
        : null,
    ),
  IconButton: ({ onPress, accessibilityLabel }: { onPress?: () => void; accessibilityLabel?: string }) =>
    createElement('button', { onClick: onPress, 'data-paper-icon-button': accessibilityLabel ?? '' }),
  Badge: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-paper-badge': 'true' }, children),
}));

vi.mock('@boardsesh/board-config', () => ({
  formatBoardDisplayName: (boardType: string) => `Display:${boardType}`,
}));

vi.mock('@boardsesh/board-constants/grade-colors', () => ({
  getGradeColor: () => '#123456',
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: ctrl.variant,
    systemColors: {
      label: '#000',
      fill: '#eee',
      secondaryLabel: '#888',
      separator: '#ccc',
      elevatedSurface: '#fff',
      secondaryBackground: '#fff',
      tertiaryBackground: '#f5f5f5',
    },
    brandColors: { primary: '#6D28D9', warning: '#FF9500' },
  }),
}));

vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: ctrl.board }),
  useSetActiveBoard: () => ctrl.setActiveBoard,
}));

vi.mock('../../../providers/bluetooth-provider', () => ({
  useOptionalBluetoothContext: () => ctrl.bluetooth,
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  shadows: { sm: {} },
}));

vi.mock('../../../theme/layout', () => ({
  glassSize: { standard: 48, capsule: 44 },
}));

vi.mock('../../../theme/colors', () => ({
  withAlpha: (color: string, alpha: number) => `${color}@${alpha}`,
}));

vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { white: '#fff' } }));
vi.mock('../../../hooks/use-native-glass', () => ({ useNativeGlass: () => false }));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => true }));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade: string) => grade }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: haptics.light, hapticSelection: haptics.selection }));

type PressMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

type GlassIconButtonMockProps = {
  iconName?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  badgeCount?: number;
};

vi.mock('../../GlassIconButton', () => ({
  GlassIconButton: ({
    iconName,
    onPress,
    onLongPress,
    accessibilityLabel,
    accessibilityHint,
    badgeCount,
  }: GlassIconButtonMockProps) =>
    createElement('button', {
      onClick: onPress,
      onDoubleClick: onLongPress,
      'data-glass-icon': iconName ?? '',
      'data-label': accessibilityLabel ?? '',
      'data-hint': accessibilityHint ?? '',
      'data-badge': badgeCount == null ? '' : String(badgeCount),
    }),
}));

vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, onLongPress, accessibilityLabel, accessibilityHint }: PressMockProps) =>
    createElement(
      'button',
      {
        onClick: onPress,
        onDoubleClick: onLongPress,
        'data-pressable': accessibilityLabel ?? '',
        'data-hint': accessibilityHint ?? '',
        'data-capsule': accessibilityLabel?.includes('•') ? accessibilityLabel : '',
      },
      children,
    ),
}));

vi.mock('../../GlassSurface', () => ({
  GlassSurface: () => createElement('div', { 'data-glass': 'true' }),
}));

vi.mock('../../GlassCluster', () => ({
  GlassCluster: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-glass-cluster': 'true' }, children),
}));

vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-text': 'true' }, children),
}));

type SearchHeaderMockProps = {
  placeholder?: string;
  initialValue?: string;
  onChangeText?: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
};
vi.mock('../../SearchHeader', () => ({
  SearchHeader: forwardRef<SearchHeaderHandle, SearchHeaderMockProps>(function SearchHeaderMock(props, ref) {
    useImperativeHandle(ref, () => ({
      blur: () => props.onBlur?.(),
      focus: () => props.onFocus?.(),
      getText: () => props.initialValue ?? '',
      setText: (text: string) => props.onChangeText?.(text),
    }));
    return createElement('input', {
      'data-search-field': 'true',
      'data-placeholder': props.placeholder ?? '',
      onFocus: props.onFocus,
      onBlur: props.onBlur,
    });
  }),
}));

vi.mock('../../grade', () => ({ GradeRangeRail: () => createElement('div', { 'data-grade-rail': 'true' }) }));

type AngleSelectorMockProps = {
  visible: boolean;
  onClose: () => void;
  boardName: string;
  layoutId: number;
  currentAngle: number;
  onAngleChange: (angle: number) => void;
};
vi.mock('../../play-drawer/AngleSelectorSheet', () => ({
  AngleSelectorSheet: ({
    visible,
    onClose,
    boardName,
    layoutId,
    currentAngle,
    onAngleChange,
  }: AngleSelectorMockProps) =>
    visible
      ? createElement(
          'button',
          {
            onClick: () => {
              onAngleChange(45);
              onClose();
            },
            'data-angle-selector': `${boardName}:${layoutId}:${currentAngle}`,
          },
          'Angle selector',
        )
      : null,
}));

import { ClimbTopChrome } from '../ClimbTopChrome';

const scrollY = { value: 0 } as unknown as Parameters<typeof ClimbTopChrome>[0]['scrollY'];

function makeProps(over: Partial<Parameters<typeof ClimbTopChrome>[0]> = {}) {
  return {
    title: 'All climbs',
    canCreate: false,
    onCreate: vi.fn(),
    onOpenBoardDetail: vi.fn(),
    onHeightChange: vi.fn(),
    scrollY,
    onPressTitle: vi.fn(),
    searchFieldRef: { current: null } as RefObject<SearchHeaderHandle | null>,
    searchInitialValue: '',
    searchPlaceholder: 'Search climbs',
    onSearchChange: vi.fn(),
    onSearchFocus: vi.fn(),
    onSearchBlur: vi.fn(),
    onCloseGrade: vi.fn(),
    ...over,
  };
}

const createAction = (root: HTMLElement) =>
  root.querySelector('[data-pressable="mobile.create.fab.ariaLabel"]') as HTMLButtonElement | null;
const angleAction = (root: HTMLElement) =>
  root.querySelector('[data-pressable="mobile.angleSelector.title"]') as HTMLButtonElement | null;
const lightbulb = (root: HTMLElement) =>
  (root.querySelector('[data-pressable="ble.connectBoard"]') ??
    root.querySelector('[data-pressable="lightControl.disconnect"]')) as HTMLButtonElement | null;
const capsule = (root: HTMLElement) =>
  root.querySelector('[data-capsule]:not([data-capsule=""])') as HTMLButtonElement | null;

const typedBoard: BoardLabelFields = {
  name: '',
  angle: 40,
  boardType: 'kilter',
  sizeName: '12x12',
  layoutName: 'Kilter Layout',
  layoutId: 1,
  isAngleAdjustable: true,
};
const namedBoard: BoardLabelFields = {
  name: 'Garage Wall',
  angle: 25,
  boardType: 'tension',
  sizeName: '8x10',
  layoutName: 'Tension Layout',
  layoutId: 2,
  isAngleAdjustable: true,
};

describe('ClimbTopChrome', () => {
  beforeEach(() => {
    ctrl.board = null;
    ctrl.bluetooth = null;
    ctrl.variant = 'liquidGlass';
    ctrl.setActiveBoard.mockClear();
    haptics.light.mockClear();
    haptics.selection.mockClear();
  });

  it('renders no board capsule when there is no active board', () => {
    const { container } = render(<ClimbTopChrome {...makeProps()} />);
    expect(capsule(container)).toBeNull();
  });

  it('builds a typed-board label from display name, size, and angle', () => {
    ctrl.board = typedBoard;
    const { container } = render(<ClimbTopChrome {...makeProps()} />);
    expect(capsule(container)?.getAttribute('data-capsule')).toBe('Display:kilter • 12x12 • 40°');
  });

  it('leads with the custom board name when the board is named', () => {
    ctrl.board = namedBoard;
    const { container } = render(<ClimbTopChrome {...makeProps()} />);
    expect(capsule(container)?.getAttribute('data-capsule')).toBe('Garage Wall • 25°');
  });

  it('omits the angle segment when angle is absent', () => {
    ctrl.board = { ...typedBoard, angle: null as unknown as number };
    const { container } = render(<ClimbTopChrome {...makeProps()} />);
    expect(capsule(container)?.getAttribute('data-capsule')).toBe('Display:kilter • 12x12');
  });

  it('hides the create FAB unless canCreate is true', () => {
    ctrl.board = typedBoard;
    const { container, rerender } = render(<ClimbTopChrome {...makeProps({ canCreate: false })} />);
    expect(createAction(container)).toBeNull();
    rerender(<ClimbTopChrome {...makeProps({ canCreate: true })} />);
    expect(createAction(container)).not.toBeNull();
  });

  it('fires onCreate when the create FAB is pressed', () => {
    const onCreate = vi.fn();
    const { container } = render(<ClimbTopChrome {...makeProps({ canCreate: true, onCreate })} />);
    fireEvent.click(createAction(container)!);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('renders the angle selector as the second left toolbar button', () => {
    ctrl.board = typedBoard;
    const { container } = render(<ClimbTopChrome {...makeProps({ canCreate: true })} />);
    expect(angleAction(container)).not.toBeNull();
    expect(angleAction(container)?.textContent).toBe('40°');
  });

  it('hides the angle selector for fixed-angle boards', () => {
    ctrl.board = { ...typedBoard, isAngleAdjustable: false };
    const { container } = render(<ClimbTopChrome {...makeProps({ canCreate: true })} />);
    expect(angleAction(container)).toBeNull();
  });

  it('opens the angle sheet and persists the selected angle', () => {
    ctrl.board = typedBoard;
    const { container } = render(<ClimbTopChrome {...makeProps()} />);
    fireEvent.click(angleAction(container)!);
    expect(haptics.light).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-angle-selector]')?.getAttribute('data-angle-selector')).toBe('kilter:1:40');
    fireEvent.click(container.querySelector('[data-angle-selector]') as HTMLButtonElement);
    expect(ctrl.setActiveBoard).toHaveBeenCalledWith({ ...typedBoard, angle: 45 });
  });

  it('fires onOpenBoardDetail with haptic when the board capsule is pressed', () => {
    ctrl.board = typedBoard;
    const onOpenBoardDetail = vi.fn();
    const { container } = render(<ClimbTopChrome {...makeProps({ onOpenBoardDetail })} />);
    fireEvent.click(capsule(container)!);
    expect(onOpenBoardDetail).toHaveBeenCalledTimes(1);
    expect(haptics.light).toHaveBeenCalledTimes(1);
  });

  it('renders the custom search field without top-row filter chrome', () => {
    const { container } = render(<ClimbTopChrome {...makeProps()} />);
    expect(lightbulb(container)).toBeNull();
    expect(container.querySelector('[data-search-field]')).not.toBeNull();
    expect(container.querySelector('[data-pressable^="mobile.search.filters"]')).toBeNull();
  });

  it('renders the Material filter affordance next to the custom search field', () => {
    ctrl.variant = 'material';
    const { container } = render(<ClimbTopChrome {...makeProps({ onOpenFilters: vi.fn() })} />);
    expect(container.querySelector('[data-search-field]')).not.toBeNull();
    expect(container.querySelector('[data-glass-icon="filter"][data-label="mobile.search.filters"]')).not.toBeNull();
  });

  it('native search mode leaves text search in the stack header and does not render filter chrome', () => {
    const { container } = render(<ClimbTopChrome {...makeProps({ searchMode: 'native' })} />);
    expect(container.querySelector('[data-search-field]')).toBeNull();
    expect(container.querySelector('[data-gradepill]')).toBeNull();
    expect(container.querySelector('[data-pressable^="mobile.search.filters"]')).toBeNull();
  });

  it('shows a disconnected lightbulb when not connected', () => {
    ctrl.bluetooth = { isConnected: false, connect: vi.fn().mockResolvedValue(true), disconnect: vi.fn() };
    const { container } = render(<ClimbTopChrome {...makeProps()} />);
    expect(lightbulb(container)).not.toBeNull();
    expect(container.querySelector('[data-icon="lightbulb"]')).not.toBeNull();
  });

  it('shows a connected lightbulb when connected', () => {
    ctrl.bluetooth = { isConnected: true, connect: vi.fn(), disconnect: vi.fn().mockResolvedValue(undefined) };
    const { container } = render(<ClimbTopChrome {...makeProps()} />);
    expect(lightbulb(container)).not.toBeNull();
    expect(container.querySelector('[data-icon="lightbulb.fill"]')).not.toBeNull();
  });

  it('connects on lightbulb press when disconnected', () => {
    const connect = vi.fn().mockResolvedValue(true);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    ctrl.bluetooth = { isConnected: false, connect, disconnect };
    const { container } = render(<ClimbTopChrome {...makeProps()} />);
    fireEvent.click(lightbulb(container)!);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
    expect(haptics.light).toHaveBeenCalledTimes(1);
  });

  it('disconnects on lightbulb press when connected', () => {
    const connect = vi.fn().mockResolvedValue(true);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    ctrl.bluetooth = { isConnected: true, connect, disconnect };
    const { container } = render(<ClimbTopChrome {...makeProps()} />);
    fireEvent.click(lightbulb(container)!);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
  });

  it('reports its measured height through onHeightChange via onLayout', () => {
    const onHeightChange = vi.fn();
    const { container } = render(<ClimbTopChrome {...makeProps({ onHeightChange })} />);
    const layoutView = container.querySelector('[data-has-layout="true"]') as HTMLElement;
    expect(layoutView).not.toBeNull();
    fireEvent.click(layoutView);
    expect(onHeightChange).toHaveBeenCalledWith(88);
  });

  it('renders the Material branch with the board switcher, search, and grade controls', () => {
    ctrl.variant = 'material';
    ctrl.board = typedBoard;
    const onOpenBoardDetail = vi.fn();
    const { container } = render(
      <ClimbTopChrome
        {...makeProps({
          onOpenBoardDetail,
          onOpenFilters: vi.fn(),
          activeFilterCount: 0,
          gradeChip: { label: 'Grade range', active: false },
          gradeBound: { minGradeId: undefined, maxGradeId: undefined },
          onOpenGrade: vi.fn(),
          onGradeChange: vi.fn(),
        })}
      />,
    );

    expect(container.querySelector('[data-gradient]')).toBeNull();
    // The board switcher replaces the static Appbar.Content subtitle: the board
    // label shows as the title with a down-caret affordance. Assert the hint too
    // so this pins the BoardSwitcherButton specifically, not any [data-capsule].
    const switcher = capsule(container);
    expect(switcher?.getAttribute('data-capsule')).toBe('Display:kilter • 12x12 • 40°');
    expect(switcher?.getAttribute('data-hint')).toBe('mobile.search.boardSwitcherHint');
    expect(container.querySelector('[data-icon="chevron.down"]')).not.toBeNull();
    expect(container.querySelector('[data-search-field]')).not.toBeNull();
    expect(container.querySelector('[data-pressable="mobile.search.gradeAction"]')?.textContent).toContain(
      'Grade range',
    );

    fireEvent.click(capsule(container)!);
    expect(onOpenBoardDetail).toHaveBeenCalledTimes(1);
    expect(haptics.light).toHaveBeenCalledTimes(1);
  });

  it('excludes the dedicated grade chip from the Material filter badge count', () => {
    ctrl.variant = 'material';
    ctrl.board = typedBoard;
    const { container, rerender } = render(
      <ClimbTopChrome
        {...makeProps({
          onOpenFilters: vi.fn(),
          activeFilterCount: 2,
          gradeChip: { label: 'V6+', active: true, onClear: vi.fn() },
          gradeBound: { minGradeId: 20, maxGradeId: undefined },
          onOpenGrade: vi.fn(),
          onGradeChange: vi.fn(),
        })}
      />,
    );

    expect(container.querySelector('[data-glass-icon="filter"]')?.getAttribute('data-badge')).toBe('1');

    rerender(
      <ClimbTopChrome
        {...makeProps({
          onOpenFilters: vi.fn(),
          activeFilterCount: 1,
          gradeChip: { label: 'V6+', active: true, onClear: vi.fn() },
          gradeBound: { minGradeId: 20, maxGradeId: undefined },
          onOpenGrade: vi.fn(),
          onGradeChange: vi.fn(),
        })}
      />,
    );
    expect(container.querySelector('[data-glass-icon="filter"]')?.getAttribute('data-badge')).toBe('0');
  });

  it('omits Material filter token chips when only grade is active', () => {
    ctrl.variant = 'material';
    ctrl.board = typedBoard;
    const { container } = render(
      <ClimbTopChrome
        {...makeProps({
          onOpenFilters: vi.fn(),
          activeFilterCount: 1,
          filterTokens: [],
          gradeChip: { label: 'V6+', active: true, onClear: vi.fn() },
          gradeBound: { minGradeId: 20, maxGradeId: undefined },
          onOpenGrade: vi.fn(),
          onGradeChange: vi.fn(),
        })}
      />,
    );

    expect(container.querySelector('[data-chip="V6+"]')).toBeNull();
  });

  it('renders Material result count and clears individual non-grade filter chips', () => {
    ctrl.variant = 'material';
    ctrl.board = typedBoard;
    const onClearGrade = vi.fn();
    const onClearBenchmark = vi.fn();
    const onClearRoutes = vi.fn();
    const { container } = render(
      <ClimbTopChrome
        {...makeProps({
          onOpenFilters: vi.fn(),
          activeFilterCount: 3,
          totalCount: 42,
          filterTokens: [
            { key: 'benchmark', label: 'Benchmarks', clear: onClearBenchmark },
            { key: 'climbType', label: 'Routes', clear: onClearRoutes },
          ],
          gradeChip: { label: 'V6+', active: true, onClear: onClearGrade },
          gradeBound: { minGradeId: 20, maxGradeId: undefined },
          onOpenGrade: vi.fn(),
          onGradeChange: vi.fn(),
        })}
      />,
    );

    expect(container.querySelector('[data-chip="mobile.search.climbsCount:42"]')?.textContent).toContain(
      'mobile.search.climbsCount:42',
    );
    fireEvent.click(container.querySelector('[data-chip="Benchmarks"]') as HTMLButtonElement);
    expect(onClearBenchmark).toHaveBeenCalledTimes(1);
    expect(onClearRoutes).not.toHaveBeenCalled();
    expect(onClearGrade).not.toHaveBeenCalled();

    fireEvent.click(container.querySelector('[data-chip-close="Routes"]') as HTMLSpanElement);
    expect(onClearRoutes).toHaveBeenCalledTimes(1);
    expect(onClearBenchmark).toHaveBeenCalledTimes(1);
    expect(onClearGrade).not.toHaveBeenCalled();
  });

  it('opens the inline grade rail from the Material grade chip and clears the active grade', () => {
    ctrl.variant = 'material';
    ctrl.board = typedBoard;
    const onOpenGrade = vi.fn();
    const onCloseGrade = vi.fn();
    const onClearGrade = vi.fn();
    const { container, rerender } = render(
      <ClimbTopChrome
        {...makeProps({
          onOpenGrade,
          onCloseGrade,
          onOpenFilters: vi.fn(),
          activeFilterCount: 1,
          gradeChip: { label: 'V6+', active: true, onClear: onClearGrade },
          gradeBound: { minGradeId: 20, maxGradeId: undefined },
          onGradeChange: vi.fn(),
        })}
      />,
    );

    fireEvent.click(container.querySelector('[data-pressable="mobile.search.gradeAction"]') as HTMLButtonElement);
    expect(onOpenGrade).toHaveBeenCalledTimes(1);
    fireEvent.click(
      container.querySelector('[data-pressable="mobile.gradeRail.clearFilterAria"]') as HTMLButtonElement,
    );
    expect(onClearGrade).toHaveBeenCalledTimes(1);

    rerender(
      <ClimbTopChrome
        {...makeProps({
          onOpenGrade,
          onCloseGrade,
          onOpenFilters: vi.fn(),
          activeFilterCount: 1,
          gradeRailVisible: true,
          gradeChip: { label: 'V6+', active: true, onClear: onClearGrade },
          gradeBound: { minGradeId: 20, maxGradeId: undefined },
          onGradeChange: vi.fn(),
        })}
      />,
    );
    expect(container.querySelector('[data-grade-rail="true"]')).not.toBeNull();
    fireEvent.click(container.querySelector('[data-pressable="mobile.search.gradeAction"]') as HTMLButtonElement);
    expect(onCloseGrade).toHaveBeenCalledTimes(1);
    expect(onOpenGrade).toHaveBeenCalledTimes(1);
  });
});
