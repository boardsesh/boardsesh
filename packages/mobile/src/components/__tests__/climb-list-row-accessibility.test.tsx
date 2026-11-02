// @vitest-environment jsdom
vi.mock('../climb-actions/ClimbActionsMenu', () => import('../../../test/climb-menu-stub'));
vi.mock('../PressableSurface', () => {
  const surface =
    (feedback: string) =>
    ({
      children,
      onPress,
      disabled,
      accessibilityLabel,
      style,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      accessibilityLabel?: string;
      style?: unknown;
    }) =>
      createElement(
        'button',
        {
          disabled,
          onClick: disabled ? undefined : onPress,
          'aria-label': accessibilityLabel,
          'data-feedback': feedback,
          'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        },
        children,
      );
  return { PressableSurface: surface('animated'), StaticPressableSurface: surface('static') };
});
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import { climbMenuTestState } from '../../../test/climb-menu-stub';

// The RNGH row tap needs an explicit screen-reader activation bridge. Native
// menu commands remain directly available when the ellipsis is hidden; the
// ellipsis itself is a sibling native button outside the row's accessible leaf.
type AccessibilityCapture = {
  onAccessibilityTap?: () => void;
  accessibilityLabel?: string;
  accessibilityElementsHidden?: boolean;
  accessibilityActions?: { name: string; label?: string }[];
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
};

const a11y = vi.hoisted(() => ({
  row: null as null | AccessibilityCapture,
  moreButton: null as null | AccessibilityCapture,
}));

// Mutable so the Android-gate test can flip the platform, reset the module registry
// and re-import the component — the `activate` action list is decided at
// module-evaluation time.
const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));
const panels = vi.hoisted(() => ({ enabled: false, props: null as Record<string, unknown> | null, language: '' }));

vi.mock('react-native', () => {
  const capture = (props: AccessibilityCapture): AccessibilityCapture => ({
    onAccessibilityTap: props.onAccessibilityTap,
    accessibilityLabel: props.accessibilityLabel,
    accessibilityElementsHidden: props.accessibilityElementsHidden,
    accessibilityActions: props.accessibilityActions,
    onAccessibilityAction: props.onAccessibilityAction,
  });
  return {
    Platform: platform,
    DynamicColorIOS: (appearances: { light: string }) => appearances.light,
    PlatformColor: (name: string) => name,
    View: ({ children, testID, ...rest }: { children?: ReactNode; testID?: string } & AccessibilityCapture) => {
      if (testID === 'climb-row') a11y.row = capture(rest);
      if (testID === 'climb-row-more-button') a11y.moreButton = capture(rest);
      return createElement('div', { 'data-testid': testID }, children);
    },
    StyleSheet: {
      create: (styles: Record<string, unknown>) => styles,
      hairlineWidth: 1,
    },
  };
});

vi.mock('react-native-reanimated', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    default: { View: passthrough },
    useAnimatedStyle: (fn: () => unknown) => fn(),
    useAnimatedReaction: () => undefined,
    useSharedValue: (value: string) => ({ value }),
    interpolate: () => 0,
    Extrapolation: { CLAMP: 'clamp' },
    runOnJS:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  };
});

type GestureCapture = {
  kind: 'tap' | 'longPress' | 'pan' | 'manual';
  maxDuration?: number;
  minDuration?: number;
  enabled?: boolean;
  onStart?: () => void;
  reference?: unknown;
  blockedReferences?: unknown[];
};
const rowGestures = vi.hoisted(() => ({
  captures: new Map<unknown, GestureCapture>(),
  exclusive: [] as GestureCapture[],
  compositions: new Map<unknown, { kind: 'exclusive' | 'simultaneous'; gestures: unknown[] }>(),
  mounted: [] as unknown[],
}));

vi.mock('react-native-gesture-handler', () => {
  // Capture the rendered native configuration, without simulating recognition.
  const makeBuilder = (kind: GestureCapture['kind']) => {
    const capture: GestureCapture = { kind };
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    const proxy: typeof builder = new Proxy(builder, {
      get:
        (_target, property) =>
        (...args: unknown[]) => {
          if (property === 'maxDuration') capture.maxDuration = args[0] as number;
          if (property === 'minDuration') capture.minDuration = args[0] as number;
          if (property === 'onStart') capture.onStart = args[0] as () => void;
          if (property === 'withRef') capture.reference = args[0];
          if (property === 'blocksExternalGesture') capture.blockedReferences = args;
          return proxy;
        },
    });
    rowGestures.captures.set(proxy, capture);
    return proxy;
  };
  return {
    GestureDetector: ({ children, gesture }: { children?: ReactNode; gesture: unknown }) => {
      rowGestures.mounted.push(gesture);
      return createElement('div', null, children);
    },
    usePanGesture: () => makeBuilder('pan'),
    useManualGesture: () => makeBuilder('manual'),
    GestureStateManager: { fail: () => {}, deactivate: () => {} },
    useTapGesture: (config: { maxDuration?: number; onActivate?: () => void; block?: unknown[] }) => {
      const gesture = makeBuilder('tap');
      const capture = rowGestures.captures.get(gesture)!;
      capture.maxDuration = config.maxDuration;
      capture.onStart = config.onActivate;
      capture.reference = gesture;
      capture.blockedReferences = config.block;
      return gesture;
    },
    useLongPressGesture: (config: { enabled?: boolean; minDuration?: number; onActivate?: () => void }) => {
      const gesture = makeBuilder('longPress');
      const capture = rowGestures.captures.get(gesture)!;
      capture.minDuration = config.minDuration;
      capture.enabled = config.enabled;
      capture.onStart = config.onActivate;
      capture.reference = gesture;
      return gesture;
    },
    useExclusiveGestures: (...gestures: unknown[]) => {
      const captures = gestures.flatMap((gesture) => {
        const capture = rowGestures.captures.get(gesture);
        return capture ? [capture] : [];
      });
      if (captures.some((capture) => capture.kind === 'longPress')) rowGestures.exclusive = captures;
      const composition = {};
      rowGestures.compositions.set(composition, { kind: 'exclusive', gestures });
      return composition;
    },
    useSimultaneousGestures: (...gestures: unknown[]) => {
      const composition = {};
      rowGestures.compositions.set(composition, { kind: 'simultaneous', gestures });
      return composition;
    },

    Gesture: {
      Pan: () => makeBuilder('pan'),
      Manual: () => makeBuilder('manual'),
      Simultaneous: (...gestures: unknown[]) => {
        const composition = {};
        rowGestures.compositions.set(composition, { kind: 'simultaneous', gestures });
        return composition;
      },
      Tap: () => makeBuilder('tap'),
      LongPress: () => makeBuilder('longPress'),
      Exclusive: (...gestures: unknown[]) => {
        const captures = gestures.flatMap((gesture) => {
          const capture = rowGestures.captures.get(gesture);
          return capture ? [capture] : [];
        });
        if (captures.some((capture) => capture.kind === 'longPress')) rowGestures.exclusive = captures;
        const composition = {};
        rowGestures.compositions.set(composition, { kind: 'exclusive', gestures });
        return composition;
      },
    },
  };
});

vi.mock('react-native-gesture-handler/ReanimatedSwipeable', () => ({
  default: (props: { children?: ReactNode } & Record<string, unknown>) => {
    panels.props = props;
    const renderAction = (callback: unknown) =>
      typeof callback === 'function' ? callback({ value: 0 }, { value: 0 }) : null;
    return createElement(
      'div',
      null,
      props.children,
      panels.enabled ? renderAction(props.renderLeftActions) : null,
      panels.enabled ? renderAction(props.renderRightActions) : null,
    );
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => `${key}${panels.language}` }),
}));

vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

const haptics = vi.hoisted(() => ({ medium: vi.fn() }));
vi.mock('../../lib/haptics', () => ({
  hapticLight: vi.fn(),
  hapticMedium: haptics.medium,
  hapticSuccess: vi.fn(),
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { background: '#fff', separator: '#ccc', secondaryLabel: '#888' },
    brandColors: { primary: '#6D28D9', success: '#0a0' },
  }),
}));

vi.mock('../Icon', () => ({ Icon: () => createElement('span', { 'data-icon': 'true' }) }));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));

vi.mock('../ClimbListItemContent', () => ({
  ClimbListItemContent: ({ climb }: { climb?: { name?: string } }) =>
    createElement('span', { 'data-climb-name': climb?.name ?? '' }),
}));

vi.mock('../climb-list-row-styles', () => ({
  CLIMB_ROW_GUTTER: 16,
  climbListRowStyles: { contentRow: {}, separator: {} },
  climbRowSeparatorInsetStyle: () => ({}),
}));

vi.mock('../climb-list-row-colors', () => ({
  selectedRowColors: () => ({ fill: '#eee', accent: '#6D28D9' }),
}));

import { ClimbListRow } from '../ClimbListRow';
import { resetClimbRowDisplayForTests, setClimbRowField } from '../../lib/climb-row-display-preference';

const climb = { uuid: 'climb-1', name: 'Crimp Master' } as Climb;

const boardProps = {
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 40,
};

const resolveClimbActions = (selectedClimb: Climb) => ({ climb: selectedClimb, boardConfig: boardProps });

describe('ClimbListRow swipe feedback lifetime', () => {
  beforeEach(() => {
    panels.enabled = true;
    panels.language = '';
    platform.OS = 'ios';
    rowGestures.compositions.clear();
    rowGestures.mounted = [];
  });

  it('keeps identical labelled panels through first drag, close and recycling', () => {
    const onPlayNext = vi.fn();
    const onOpenPlaylist = vi.fn();
    const props = { ...boardProps, onPlayNext, onOpenPlaylist };
    const screen = render(<ClimbListRow climb={climb} {...props} />);
    const readPanels = () =>
      ['mobile.climbActions.playNext', 'actions.playlist.popover.title'].map((label) => {
        const button = screen.getByRole('button', { name: label });
        return { label, style: button.getAttribute('data-style'), feedback: button.getAttribute('data-feedback') };
      });
    const idlePanels = readPanels();
    expect(idlePanels.map((panel) => panel.feedback)).toEqual(['static', 'static']);
    const startDrag = panels.props?.onSwipeableOpenStartDrag as () => void;
    const closeSwipe = panels.props?.onSwipeableClose as () => void;
    expect(startDrag).toBeTypeOf('function');
    expect(closeSwipe).toBeTypeOf('function');
    act(startDrag);
    expect(readPanels()).toEqual(idlePanels.map((panel) => ({ ...panel, feedback: 'animated' })));
    expect(onPlayNext).not.toHaveBeenCalled();
    expect(onOpenPlaylist).not.toHaveBeenCalled();
    act(closeSwipe);
    expect(readPanels()).toEqual(idlePanels);
    act(startDrag);
    screen.rerender(<ClimbListRow climb={{ ...climb, uuid: 'climb-2' }} {...props} />);
    expect(readPanels()).toEqual(idlePanels);
    fireEvent.click(screen.getByRole('button', { name: 'mobile.climbActions.playNext' }));
    expect(onPlayNext).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'climb-2' }));
  });

  it('keeps render callbacks for unchanged labels and refreshes translated panels', () => {
    const props = { ...boardProps, onPlayNext: vi.fn(), onOpenPlaylist: vi.fn() };
    const screen = render(<ClimbListRow climb={climb} {...props} />);
    const left = panels.props?.renderLeftActions;
    const right = panels.props?.renderRightActions;
    screen.rerender(<ClimbListRow climb={{ ...climb }} {...props} />);
    expect(panels.props?.renderLeftActions).toBe(left);
    expect(panels.props?.renderRightActions).toBe(right);
    panels.language = ':es';
    screen.rerender(<ClimbListRow climb={{ ...climb }} {...props} />);
    expect(panels.props?.renderLeftActions).not.toBe(left);
    expect(panels.props?.renderRightActions).not.toBe(right);
    expect(screen.getByRole('button', { name: 'mobile.climbActions.playNext:es' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'actions.playlist.popover.title:es' })).toBeTruthy();
  });

  it('mounts the swipe lock ahead of the full-swipe tracker in the row detector', () => {
    render(<ClimbListRow climb={climb} {...boardProps} onPlayNext={vi.fn()} onOpenPlaylist={vi.fn()} />);
    const lock = panels.props?.requireToFail;
    const fullSwipe = panels.props?.simultaneousWith;
    expect(rowGestures.captures.get(lock)?.kind).toBe('manual');
    expect(rowGestures.captures.get(fullSwipe)?.kind).toBe('pan');
    const mountedRow = rowGestures.mounted.find(
      (gesture) => rowGestures.compositions.get(gesture)?.kind === 'simultaneous',
    );
    const rowComposition = rowGestures.compositions.get(mountedRow);
    expect(rowComposition?.gestures).toHaveLength(2);
    const guardedSwipe = rowGestures.compositions.get(rowComposition?.gestures[1]);
    expect(guardedSwipe?.kind).toBe('exclusive');
    expect(guardedSwipe?.gestures).toHaveLength(2);
    expect(guardedSwipe?.gestures[0]).toBe(lock);
    expect(guardedSwipe?.gestures[1]).toBe(fullSwipe);
  });

  it('waits for a deliberate sideways drag so a vertical scroll never slides the row', () => {
    render(<ClimbListRow climb={climb} {...boardProps} onPlayNext={vi.fn()} onOpenPlaylist={vi.fn()} />);
    expect(panels.props?.dragOffsetFromLeft).toBe(30);
    expect(panels.props?.dragOffsetFromRight).toBe(-30);
    expect(panels.props?.requireToFail).toBeTruthy();
  });
});

describe('ClimbListRow screen-reader activation', () => {
  beforeEach(() => {
    a11y.row = null;
    a11y.moreButton = null;
    rowGestures.captures.clear();
    rowGestures.exclusive = [];
    panels.enabled = false;
    panels.language = '';
    climbMenuTestState.commands = [];
    climbMenuTestState.openedRows = null;
    vi.clearAllMocks();
    resetClimbRowDisplayForTests();
  });

  it('keeps bounded row taps while native long press opens the climb descriptors', () => {
    const onPress = vi.fn();
    const onOpenActions = vi.fn(resolveClimbActions);
    const { container } = render(
      <ClimbListRow climb={climb} {...boardProps} onPress={onPress} onOpenActions={onOpenActions} />,
    );
    const tap = [...rowGestures.captures.values()].find((gesture) => gesture.kind === 'tap');
    expect(tap?.maxDuration).toBe(400);
    expect([...rowGestures.captures.values()].find((gesture) => gesture.kind === 'longPress')?.enabled).toBe(false);
    expect(onOpenActions).toHaveBeenCalledExactlyOnceWith(climb);
    expect(onPress).not.toHaveBeenCalled();
    act(() => tap?.onStart?.());
    expect(onPress).toHaveBeenCalledExactlyOnceWith(climb);
    onPress.mockClear();
    fireEvent.contextMenu(container.querySelector('[data-native-climb-menu="longPress"]')!);
    expect(climbMenuTestState.openedRows?.map((row) => row.id)).toEqual(['share']);
    expect(onOpenActions).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('makes the main-list hold exclusive with opening the player, even when its ellipsis is hidden', () => {
    const onPress = vi.fn();
    setClimbRowField('quickActions', false);
    render(
      <ClimbListRow
        climb={climb}
        {...boardProps}
        onPress={onPress}
        onOpenActions={resolveClimbActions}
        showMoreButton
      />,
    );
    expect(rowGestures.exclusive.map((gesture) => gesture.kind)).toEqual(['longPress', 'tap']);
    const hold = rowGestures.exclusive[0];
    expect(hold.enabled).toBe(true);
    expect(hold.minDuration).toBe(400);
    act(() => hold.onStart?.());
    expect(onPress).not.toHaveBeenCalled();
    expect(a11y.moreButton).toBeNull();
  });

  it('keeps the ellipsis outside the row trigger and opens the same hold menu', () => {
    const onPress = vi.fn();
    const { container, getByRole } = render(
      <ClimbListRow
        climb={climb}
        {...boardProps}
        onPress={onPress}
        onOpenActions={vi.fn(resolveClimbActions)}
        showMoreButton
      />,
    );
    const icon = getByRole('button', { name: 'mobile.climbRow.moreActions' });
    expect(icon.closest('[data-native-climb-menu="longPress"]')).toBeNull();
    // One menu per row: the ⋮ is a plain button that opens the row's own.
    expect(container.querySelector('[data-native-climb-menu="icon"]')).toBeNull();
    climbMenuTestState.openedRows = null;
    fireEvent.click(icon);
    const iconRows = climbMenuTestState.openedRows;
    expect(iconRows).not.toBeNull();
    fireEvent.contextMenu(container.querySelector('[data-native-climb-menu="longPress"]')!);
    expect(climbMenuTestState.openedRows).toBe(iconRows);
    expect(climbMenuTestState.commands).toEqual([]);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('opens the climb from a screen-reader tap and from the activate action', () => {
    const onPress = vi.fn();
    render(<ClimbListRow climb={climb} {...boardProps} onPress={onPress} />);
    expect(a11y.row?.onAccessibilityTap).toBeTypeOf('function');
    expect(a11y.row?.onAccessibilityAction).toBeTypeOf('function');
    expect(a11y.row?.accessibilityActions ?? []).toEqual([]);
    a11y.row?.onAccessibilityTap?.();
    expect(onPress).toHaveBeenCalledWith(climb);
    a11y.row?.onAccessibilityAction?.({ nativeEvent: { actionName: 'activate' } });
    expect(onPress).toHaveBeenCalledTimes(2);
    a11y.row?.onAccessibilityAction?.({ nativeEvent: { actionName: 'magicTap' } });
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it('leaves an unsupported row inert under screen-reader activation', () => {
    const onPress = vi.fn();
    const onOpenActions = vi.fn(resolveClimbActions);
    render(<ClimbListRow climb={climb} {...boardProps} onPress={onPress} onOpenActions={onOpenActions} unsupported />);
    expect(a11y.row?.onAccessibilityTap).toBeTypeOf('function');
    a11y.row?.onAccessibilityTap?.();
    a11y.row?.onAccessibilityAction?.({ nativeEvent: { actionName: 'activate' } });
    a11y.row?.onAccessibilityAction?.({ nativeEvent: { actionName: 'share' } });
    expect(a11y.row?.accessibilityActions ?? []).toEqual([]);
    expect(onPress).not.toHaveBeenCalled();
    expect(onOpenActions).not.toHaveBeenCalled();
    expect(climbMenuTestState.commands).toEqual([]);
  });

  it.each([true, false])('publishes direct climb commands with showMoreButton=%s', (showMoreButton) => {
    const onPress = vi.fn();
    const onOpenActions = vi.fn(resolveClimbActions);
    render(
      <ClimbListRow
        climb={climb}
        {...boardProps}
        onPress={onPress}
        onOpenActions={onOpenActions}
        showMoreButton={showMoreButton}
      />,
    );
    expect(a11y.row?.accessibilityActions).toEqual([{ name: 'share', label: 'Share' }]);
    expect(Boolean(a11y.moreButton)).toBe(showMoreButton);
    a11y.row?.onAccessibilityAction?.({ nativeEvent: { actionName: 'share' } });
    expect(climbMenuTestState.commands).toEqual([{ id: 'share', target: resolveClimbActions(climb) }]);
    expect(onOpenActions).toHaveBeenCalledExactlyOnceWith(climb);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('retains commands when the quick-actions preference hides the native ellipsis', () => {
    render(
      <ClimbListRow
        climb={climb}
        {...boardProps}
        onPress={vi.fn()}
        onOpenActions={vi.fn(resolveClimbActions)}
        showMoreButton
      />,
    );
    expect(a11y.moreButton).not.toBeNull();
    a11y.moreButton = null;
    act(() => setClimbRowField('quickActions', false));
    expect(a11y.moreButton).toBeNull();
    expect(a11y.row?.accessibilityActions).toEqual([{ name: 'share', label: 'Share' }]);
    a11y.row?.onAccessibilityAction?.({ nativeEvent: { actionName: 'share' } });
    expect(climbMenuTestState.commands).toHaveLength(1);
    act(() => setClimbRowField('quickActions', true));
    expect(a11y.moreButton).not.toBeNull();
  });

  it('omits commands when the row has no resolver and leaves its label to its children', () => {
    render(<ClimbListRow climb={climb} {...boardProps} onPress={vi.fn()} />);
    expect(a11y.row?.accessibilityActions ?? []).toEqual([]);
    expect(a11y.row?.accessibilityLabel).toBeUndefined();
  });

  it('does not acknowledge a stale accessibility action after the resolver is removed', () => {
    const { rerender } = render(
      <ClimbListRow climb={climb} {...boardProps} onPress={vi.fn()} onOpenActions={vi.fn(resolveClimbActions)} />,
    );
    const oldActionHandler = a11y.row?.onAccessibilityAction;
    expect(oldActionHandler).toBeTypeOf('function');
    rerender(<ClimbListRow climb={climb} {...boardProps} onPress={vi.fn()} />);
    oldActionHandler?.({ nativeEvent: { actionName: 'share' } });
    expect(climbMenuTestState.commands).toEqual([]);
  });

  it('keeps one accessibilityActions array across unrelated rerenders', () => {
    const props = {
      climb,
      ...boardProps,
      onPress: vi.fn(),
      onOpenActions: vi.fn(resolveClimbActions),
      showMoreButton: true,
    };
    const { rerender } = render(<ClimbListRow {...props} />);
    const actions = a11y.row?.accessibilityActions;
    expect(actions).toBeDefined();
    rerender(<ClimbListRow {...props} selected />);
    expect(a11y.row?.accessibilityActions).toBe(actions);
  });

  it('refreshes the menu board snapshot when only the board angle changes', () => {
    let angle = 40;
    const onOpenActions = vi.fn((selectedClimb: Climb) => ({
      climb: selectedClimb,
      boardConfig: { ...boardProps, angle },
    }));
    const onPress = vi.fn();
    const { rerender } = render(
      <ClimbListRow climb={climb} {...boardProps} onPress={onPress} onOpenActions={onOpenActions} />,
    );
    expect(climbMenuTestState.target?.boardConfig.angle).toBe(40);
    angle = 30;
    rerender(<ClimbListRow climb={climb} {...boardProps} angle={30} onPress={onPress} onOpenActions={onOpenActions} />);
    expect(climbMenuTestState.target?.boardConfig.angle).toBe(30);
  });
});

// Android has no onAccessibilityTap at all — 'activate' maps to ACTION_CLICK in
// ReactAccessibilityDelegate and is the only route there, so the action list is
// gated on the platform at module-evaluation time.
describe('ClimbListRow screen-reader activation on Android', () => {
  beforeEach(() => {
    a11y.row = null;
    a11y.moreButton = null;
    vi.clearAllMocks();
  });

  it('adds the activate action on Android', async () => {
    platform.OS = 'android';
    vi.resetModules();
    try {
      const { ClimbListRow: AndroidClimbListRow } = await import('../ClimbListRow');
      render(
        <AndroidClimbListRow
          climb={climb}
          {...boardProps}
          onPress={vi.fn()}
          onOpenActions={vi.fn(resolveClimbActions)}
          showMoreButton
        />,
      );

      expect(a11y.row?.accessibilityActions).toEqual([{ name: 'activate' }, { name: 'share', label: 'Share' }]);
      expect(a11y.moreButton).not.toBeNull();
    } finally {
      platform.OS = 'ios';
      vi.resetModules();
    }
  });
});
