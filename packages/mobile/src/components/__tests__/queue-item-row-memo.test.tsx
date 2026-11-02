// @vitest-environment jsdom
vi.mock('../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, isValidElement, useRef, type ReactNode } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { QueueItemRowBoard } from '../QueueItemRow';
import type { QueueDragControls } from '../play-drawer/use-queue-drag';

// Count how many times the inner component body actually renders. The body
// renders `ClimbListItemContent` once per render, so a render counter there is a
// faithful proxy for "QueueItemRow's body ran". If React.memo is working, an
// identical-props re-render must NOT bump this counter.
const renderCounter = vi.hoisted(() => ({ count: 0 }));
const themeState = vi.hoisted(() => ({
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  scheme: 'dark' as 'dark' | 'light',
}));
const menuState = vi.hoisted(() => ({
  target: null as unknown,
  actions: [{ name: 'share', label: 'Share' }],
  emptyActions: [] as { name: string; label: string }[],
  rows: [{ id: 'share' }],
  emptyRows: [] as { id: string }[],
  onAction: vi.fn(),
}));
vi.mock('../climb-actions/ClimbActionsMenu', () => ({
  useClimbMenu: (target: unknown) => {
    menuState.target = target;
    return {
      rows: target ? menuState.rows : menuState.emptyRows,
      menuKey: 'queue-slot',
      accessibilityActions: target ? menuState.actions : menuState.emptyActions,
      onAccessibilityAction: menuState.onAction,
    };
  },
  ClimbMenu: ({ children, rows }: { children?: ReactNode; rows: unknown[] }) =>
    rows.length > 0 ? createElement('div', { 'data-native-menu': true }, children) : children,
}));

// Capture callbacks at their rendered targets so tests distinguish the row tap
// from its sibling tick button without depending on gesture construction order.
const captured = vi.hoisted(() => ({
  rowPress: null as null | (() => void),
  tickPress: null as null | (() => void),
  deletePress: null as null | (() => void),
}));

// Per-instance call logs for gestures created via the RNGH mock below, keyed by
// factory. One array is pushed per `Gesture.Pan()`/`Gesture.Tap()`/`Gesture.LongPress()`
// call, in creation order — lets a test inspect exactly what was chained onto a
// specific gesture (e.g. "the swipe Pan never gets an exclusivity relationship wired
// onto it by a future edit").
const gestureCalls = vi.hoisted(() => ({
  panLogs: [] as { method: string; args: unknown[] }[][],
  tapLogs: [] as { method: string; args: unknown[] }[][],
  longPressLogs: [] as { method: string; args: unknown[] }[][],
}));

// Screen-reader activation props, captured off the rendered elements. RNGH's
// gesture recognizers never reach RN's accessibility-action bridge, so the row and
// its tick button wire onAccessibilityTap/onAccessibilityAction explicitly (#3914).
// Keyed by which element carried them: the row is the accessible button-role
// Animated.View, the tick is the `tick-button` testID.
type AccessibilityCapture = {
  onAccessibilityTap?: () => void;
  accessibilityActions?: { name: string; label?: string }[];
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  accessibilityLabel?: string;
};
const a11y = vi.hoisted(() => ({
  row: null as null | AccessibilityCapture,
  tick: null as null | AccessibilityCapture,
}));

// Mutable so the Android-gate test can flip the platform, reset the module registry
// and re-import the component — the `activate` action list is decided at
// module-evaluation time.
const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));

vi.mock('react-native', () => {
  return {
    Platform: platform,
    DynamicColorIOS: (appearances: { light: string }) => appearances.light,
    PlatformColor: (name: string) => name,
    View: ({
      children,
      testID,
      accessible,
      accessibilityRole,
      ...rest
    }: {
      children?: ReactNode;
      testID?: string;
      accessible?: boolean;
      accessibilityRole?: string;
    } & AccessibilityCapture) => {
      if (accessible && accessibilityRole === 'button' && testID !== 'tick-button') a11y.row = rest;
      if (testID === 'tick-button') {
        a11y.tick = {
          onAccessibilityTap: rest.onAccessibilityTap,
          accessibilityActions: rest.accessibilityActions,
          onAccessibilityAction: rest.onAccessibilityAction,
        };
      }
      return createElement('div', { 'data-testid': testID }, children);
    },
    // Capture by testID so any future Pressable addition doesn't silently
    // overwrite the wrong slot. (The tick button is now an RNGH gesture, not a
    // Pressable — its callback is captured in the Gesture.Tap mock below.)
    Pressable: ({ children, onPress, testID }: { children?: ReactNode; onPress?: () => void; testID?: string }) => {
      if (testID === 'delete-button' && onPress) captured.deletePress = onPress;
      return createElement('button', null, children);
    },
    StyleSheet: {
      flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
      create: (styles: Record<string, unknown>) => styles,
      hairlineWidth: 1,
    },
  };
});

vi.mock('react-native-reanimated', () => {
  // The row itself is the accessible, button-role Animated.View (the outer
  // container/swipe wrappers carry no accessibility props), so key the capture on
  // that pair rather than adding a testID that production doesn't need.
  const passthrough = ({
    children,
    accessible,
    accessibilityRole,
    ...rest
  }: {
    children?: ReactNode;
    accessible?: boolean;
    accessibilityRole?: string;
  } & AccessibilityCapture) => {
    if (accessible && accessibilityRole === 'button') {
      a11y.row = {
        onAccessibilityTap: rest.onAccessibilityTap,
        accessibilityActions: rest.accessibilityActions,
        onAccessibilityAction: rest.onAccessibilityAction,
        accessibilityLabel: rest.accessibilityLabel,
      };
    }
    return createElement('div', null, children);
  };
  return {
    default: { View: passthrough },
    useAnimatedStyle: (fn: () => unknown) => fn(),
    // Real reanimated returns a stable ref across renders; mirror that so the
    // callback-stability test reflects production behaviour (a fresh object each
    // render would churn every callback that reads a shared value).
    useSharedValue: (initial: unknown) => {
      const ref = useRef({ value: initial });
      return ref.current;
    },
    withSpring: (value: unknown) => value,
    withTiming: (value: unknown) => value,
    runOnJS:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  };
});

vi.mock('react-native-gesture-handler', () => {
  // Record gesture configuration and expose its start callback to the detector.
  const makeBuilder = (log: { method: string; args: unknown[] }[]) => {
    let onStart: unknown;
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    const proxy: typeof builder = new Proxy(builder, {
      get: (_target, prop: string) => {
        if (prop === 'capturedOnStart') return onStart;
        return (...args: unknown[]) => {
          log.push({ method: prop, args });
          if (prop === 'onStart') onStart = args[0];
          return proxy;
        };
      },
    });
    return proxy;
  };

  return {
    GestureDetector: ({ children, gesture }: { children?: ReactNode; gesture: { capturedOnStart?: () => void } }) => {
      if (isValidElement<{ testID?: string; accessible?: boolean; accessibilityRole?: string }>(children)) {
        if (children.props.testID === 'tick-button') captured.tickPress = gesture.capturedOnStart ?? null;
        else if (children.props.accessible && children.props.accessibilityRole === 'button') {
          captured.rowPress = gesture.capturedOnStart ?? null;
        }
      }
      return createElement('div', null, children);
    },
    Gesture: {
      Pan: () => {
        const log: { method: string; args: unknown[] }[] = [];
        gestureCalls.panLogs.push(log);
        return makeBuilder(log);
      },
      Tap: () => {
        const log: { method: string; args: unknown[] }[] = [];
        gestureCalls.tapLogs.push(log);
        return makeBuilder(log);
      },
      LongPress: () => {
        const log: { method: string; args: unknown[] }[] = [];
        gestureCalls.longPressLogs.push(log);
        return makeBuilder(log);
      },
      // The composed tap/long-press gesture — nothing is chained onto it directly,
      // it's just handed to <GestureDetector>, so no call-logging needed here.
      Exclusive: () => ({}),
    },
  };
});

vi.mock('react-i18next', () => ({
  // Raw key passthrough (what the rest of this file asserts on), EXCEPT for the
  // added-by label, which resolves its `{{name}}` placeholder. Asserting on a raw
  // key there would pass even if the name argument never reached the catalog.
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key === 'mobile.queue.addedByAria' ? `Added by ${String(options?.name)}` : key,
  }),
}));

vi.mock('../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    variant: themeState.variant,
    systemColors: {
      secondaryBackground: '#fff',
      separator: '#ccc',
      label: themeState.scheme === 'dark' ? '#FFFFFF' : '#1C1C1E',
      secondaryLabel: themeState.scheme === 'dark' ? '#D0D0D0' : '#3C3C43',
      tertiaryLabel: 'tertiaryLabel',
      error: 'systemRed',
    },
    brandColors: { primary: '#6D28D9', success: '#0a0', error: '#a00' },
  }),
}));

vi.mock('../../lib/haptics', () => ({ hapticSelection: vi.fn(), hapticMedium: vi.fn() }));

vi.mock('../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../Icon', () => ({
  Icon: ({ name, size, color }: { name: string; size: number; color: string }) =>
    createElement('span', { 'data-icon': 'true', 'data-name': name, 'data-size': size, 'data-color': color }),
}));

vi.mock('../ClimbListItemContent', () => ({
  ClimbListItemContent: ({ climb }: { climb?: { name?: string } }) => {
    renderCounter.count += 1;
    return createElement('span', { 'data-climb-name': climb?.name ?? '' });
  },
}));

vi.mock('../ClimbListThumbnail', () => ({}));

// Without this mock the new import drags PressableAvatar → expo-router's
// useRouter and Avatar → Image/PixelRatio into a graph whose `react-native` mock
// above exports only Platform, PlatformColor, View, Pressable and StyleSheet —
// which would break every test in this file, not just the attribution ones.
vi.mock('../board-presence/BoardDriverAvatar', () => ({
  BoardDriverAvatar: ({ name }: { name?: string | null }) => createElement('span', { 'data-added-by': name ?? '' }),
}));

vi.mock('../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12 },
}));

vi.mock('../../theme/animations', () => ({ springs: { interactive: {} } }));

vi.mock('../play-drawer/queue-drag-math', () => ({ rowReorderShift: () => 0 }));

import { QueueItemRow } from '../QueueItemRow';

const board: QueueItemRowBoard = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 40,
};

function makeItem(uuid: string, name: string, addedByUser?: ClimbQueueItem['addedByUser']): ClimbQueueItem {
  return {
    uuid,
    climb: { uuid: `climb-${uuid}`, name } as ClimbQueueItem['climb'],
    addedBy: null,
    source: null,
    addedByUser,
  } as ClimbQueueItem;
}

// Stable callbacks — the production callers (QueueSheet / drawer-host) pass
// useCallback/useMemo-stable handlers, so the memo compare sees equal props.
const onPress = vi.fn();
const onRemove = vi.fn();
const onToggleSelect = vi.fn();

describe('QueueItemRow React.memo', () => {
  beforeEach(() => {
    themeState.variant = 'liquidGlass';
    themeState.scheme = 'dark';
    renderCounter.count = 0;
    captured.rowPress = null;
    captured.tickPress = null;
    captured.deletePress = null;
    gestureCalls.panLogs = [];
    gestureCalls.tapLogs = [];
    gestureCalls.longPressLogs = [];
    a11y.row = null;
    a11y.tick = null;
    vi.clearAllMocks();
  });

  it.each([
    ['liquidGlass', 'dark', '#FFFFFF'],
    ['liquidGlass', 'light', '#1C1C1E'],
    ['material', 'dark', '#D0D0D0'],
    ['material', 'light', '#3C3C43'],
  ] as const)('keeps the queue history Tick neutral at 26 pt (%s, %s)', (variant, scheme, expectedColor) => {
    themeState.variant = variant;
    themeState.scheme = scheme;
    const props = {
      item: makeItem('history', 'Crimp Master'),
      position: 1,
      board,
      isHistoryItem: true,
      isCurrentClimb: false,
      onPress,
      onRemove,
      onTickHistory: vi.fn(),
    };
    const rendered = render(<QueueItemRow {...props} />);
    for (const isCurrentClimb of [false, true]) {
      rendered.rerender(<QueueItemRow {...props} isCurrentClimb={isCurrentClimb} />);
      const tick = rendered.container.querySelector('[data-name="tick.fill"]');
      expect(tick?.getAttribute('data-color')).toBe(expectedColor);
      expect(tick?.getAttribute('data-size')).toBe('26');
    }
  });

  it('announces frame counts when route metadata arrives for the same queue climb', () => {
    const item = makeItem('route', 'Long Route');
    const props = { position: 1, board, isCurrentClimb: false, onPress, onRemove };
    const { rerender } = render(<QueueItemRow {...props} item={item} />);
    expect(a11y.row?.accessibilityLabel).not.toContain('mobile.climbRow.frameCount');
    rerender(<QueueItemRow {...props} item={{ ...item, climb: { ...item.climb, framesCount: 4 } }} />);
    expect(a11y.row?.accessibilityLabel).toContain('mobile.climbRow.frameCount');
  });

  it('reveals a short swipe, commits a full release, and ignores cancelled releases', () => {
    render(
      <QueueItemRow
        item={makeItem('a', 'Crimp Master')}
        position={1}
        board={board}
        isCurrentClimb={false}
        onPress={onPress}
        onRemove={onRemove}
        onToggleSelect={onToggleSelect}
      />,
    );
    const release = gestureCalls.panLogs[0].find((call) => call.method === 'onEnd')?.args[0] as (
      event: { translationX: number },
      success: boolean,
    ) => void;
    release({ translationX: -90 }, true);
    expect(onRemove).not.toHaveBeenCalled();
    release({ translationX: -220 }, false);
    expect(onRemove).not.toHaveBeenCalled();
    release({ translationX: -220 }, true);
    expect(onRemove).toHaveBeenCalledExactlyOnceWith('a');
  });

  it('does not let a stale full swipe delete a recycled row', () => {
    const props = { position: 1, board, isCurrentClimb: false, onPress, onRemove, onToggleSelect };
    const { rerender } = render(<QueueItemRow item={makeItem('a', 'Crimp Master')} {...props} />);
    const oldRelease = gestureCalls.panLogs[0].find((call) => call.method === 'onEnd')?.args[0] as (
      event: { translationX: number },
      success: boolean,
    ) => void;
    rerender(<QueueItemRow item={makeItem('b', 'New Climb')} {...props} />);
    oldRelease({ translationX: -220 }, true);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('skips re-render when given referentially-equal props', () => {
    const item = makeItem('a', 'Crimp Master');
    const element = (
      <QueueItemRow
        item={item}
        position={1}
        board={board}
        isCurrentClimb={false}
        onPress={onPress}
        onRemove={onRemove}
        onToggleSelect={onToggleSelect}
      />
    );

    const { rerender } = render(element);
    expect(renderCounter.count).toBe(1);

    // Re-render the SAME element (identical props). A working memo skips the body.
    rerender(element);
    expect(renderCounter.count).toBe(1);
  });

  it('re-renders when a prop actually changes (selection toggles)', () => {
    const item = makeItem('a', 'Crimp Master');
    const { rerender } = render(
      <QueueItemRow
        item={item}
        position={1}
        board={board}
        isCurrentClimb={false}
        isEditMode
        isSelected={false}
        onPress={onPress}
        onRemove={onRemove}
        onToggleSelect={onToggleSelect}
      />,
    );
    expect(renderCounter.count).toBe(1);

    rerender(
      <QueueItemRow
        item={item}
        position={1}
        board={board}
        isCurrentClimb={false}
        isEditMode
        isSelected
        onPress={onPress}
        onRemove={onRemove}
        onToggleSelect={onToggleSelect}
      />,
    );
    expect(renderCounter.count).toBe(2);
  });

  it('keeps press callbacks stable when item identity changes but its data is equal', () => {
    const onTickHistory = vi.fn();
    const onOpenActions = vi.fn();
    const rowProps = {
      position: 1,
      board,
      isCurrentClimb: false,
      isHistoryItem: true,
      onPress,
      onRemove,
      onToggleSelect,
      onTickHistory,
      onOpenActions,
    };

    const first = makeItem('a', 'Crimp Master');
    const { rerender } = render(<QueueItemRow item={first} {...rowProps} />);

    const rowPress = captured.rowPress;
    const tickPress = captured.tickPress;
    expect(rowPress).toBeTypeOf('function');
    expect(tickPress).toBeTypeOf('function');

    // A fresh item object with the same uuid + data — exactly what the queue
    // reducer produces when it rebuilds the array on an unrelated update. The
    // callbacks must keep their identity (they read the live item via a ref and
    // dep only on `item.uuid`), or the row's gestures/pressables churn and defeat
    // memo. The native menu owns long-press independently of these tap callbacks.
    const second = makeItem('a', 'Crimp Master');
    expect(second).not.toBe(first);
    rerender(<QueueItemRow item={second} {...rowProps} />);

    expect(captured.rowPress).toBe(rowPress);
    expect(captured.tickPress).toBe(tickPress);
  });

  it('resolves the native menu for the exact queue slot without selecting the climb', () => {
    const localOnPress = vi.fn();
    const item = makeItem('a', 'Crimp Master');
    const target = { climb: item.climb, boardConfig: board, queueItemUuid: item.uuid };
    const onOpenActions = vi.fn(() => target);
    const { container } = render(
      <QueueItemRow
        item={item}
        position={1}
        board={board}
        isCurrentClimb={false}
        onPress={localOnPress}
        onRemove={onRemove}
        onToggleSelect={onToggleSelect}
        onOpenActions={onOpenActions}
      />,
    );

    expect(captured.rowPress).toBeTypeOf('function');
    expect(onOpenActions).toHaveBeenCalledTimes(1);
    expect(onOpenActions).toHaveBeenCalledWith(item);
    expect(menuState.target).toEqual(target);
    expect(container.querySelector('[data-native-menu]')).not.toBeNull();
    expect(gestureCalls.longPressLogs).toHaveLength(0);
    expect(localOnPress).not.toHaveBeenCalled();

    a11y.row?.onAccessibilityAction?.({ nativeEvent: { actionName: 'share' } });
    expect(menuState.onAction).toHaveBeenCalledWith({ nativeEvent: { actionName: 'share' } });
    expect(a11y.row?.accessibilityActions).toContainEqual({ name: 'share', label: 'Share' });
    expect(localOnPress).not.toHaveBeenCalled();

    captured.rowPress?.();
    expect(localOnPress).toHaveBeenCalledTimes(1);
    expect(localOnPress).toHaveBeenCalledWith(item);
    expect(onOpenActions).toHaveBeenCalledTimes(1);
  });

  it('hands the menu one target per slot while the queue rebuilds its items', () => {
    const item = makeItem('slot-a', 'Crimp Master');
    const onOpenActions = vi.fn(() => ({ climb: item.climb, boardConfig: board, queueItemUuid: item.uuid }));
    const props = { position: 1, board, isCurrentClimb: false, onPress, onRemove, onOpenActions };
    const { rerender } = render(<QueueItemRow {...props} item={item} />);
    const first = menuState.target;
    // The reducer hands a fresh item object for the same slot and climb.
    rerender(<QueueItemRow {...props} item={{ ...item }} position={2} />);
    expect(menuState.target).toBe(first);
    expect(onOpenActions).toHaveBeenCalledTimes(1);
  });

  it("leaves the menu's Log a tick off a History row that has its own tick", () => {
    const item = makeItem('a', 'Crimp Master');
    menuState.actions = [
      { name: 'tick', label: 'Log a tick' },
      { name: 'share', label: 'Share' },
    ];
    try {
      render(
        <QueueItemRow
          item={item}
          position={1}
          board={board}
          isCurrentClimb={false}
          isHistoryItem
          onPress={onPress}
          onRemove={onRemove}
          onToggleSelect={onToggleSelect}
          onTickHistory={vi.fn()}
          onOpenActions={() => ({ climb: item.climb, boardConfig: board, queueItemUuid: item.uuid })}
        />,
      );
      const names = a11y.row?.accessibilityActions?.map((action) => action.name);
      expect(names).toContain('share');
      expect(names).not.toContain('tick');
    } finally {
      menuState.actions = [{ name: 'share', label: 'Share' }];
    }
  });

  it('refreshes the menu board when the same queue slot remains after an angle change', () => {
    const item = makeItem('same-slot', 'Crimp Master');
    const onOpenActions = vi.fn(() => ({ climb: item.climb, boardConfig: board, queueItemUuid: item.uuid }));
    const props = { item, position: 1, isCurrentClimb: false, onPress, onRemove, onOpenActions };
    const { rerender } = render(<QueueItemRow {...props} board={board} />);
    expect(menuState.target).toMatchObject({ queueItemUuid: item.uuid, boardConfig: { angle: 40 } });
    rerender(<QueueItemRow {...props} board={{ ...board, angle: 30 }} />);
    expect(onOpenActions).toHaveBeenCalledTimes(2);
    expect(menuState.target).toMatchObject({ queueItemUuid: item.uuid, boardConfig: { angle: 30 } });
    expect(onPress).not.toHaveBeenCalled();
  });

  // #3914: the row's press lives on an RNGH Gesture.Tap, which never registers with
  // RN's accessibility-action bridge — a VoiceOver/TalkBack activate reached nothing.
  // The row must therefore expose onAccessibilityTap plus, on Android only, an
  // `activate` action that call the same handler the tap does. These assertions
  // invoke the props the component actually renders, so reverting the fix leaves
  // them undefined and fails here. (Platform.OS is mocked as 'ios' in this file;
  // the Android gate has its own re-import test at the bottom.)
  it('activates the row from a screen-reader tap and from the activate action', () => {
    const localOnPress = vi.fn();
    const item = makeItem('a', 'Crimp Master');
    render(
      <QueueItemRow
        item={item}
        position={1}
        board={board}
        isCurrentClimb={false}
        onPress={localOnPress}
        onRemove={onRemove}
        onToggleSelect={onToggleSelect}
      />,
    );

    expect(a11y.row?.onAccessibilityTap).toBeTypeOf('function');
    expect(a11y.row?.onAccessibilityAction).toBeTypeOf('function');
    // iOS: no unlabelled `activate` entry — VoiceOver would announce the raw
    // developer-facing name as a custom action on every row, and the double-tap
    // already reaches onAccessibilityTap.
    expect(a11y.row?.accessibilityActions).toBeUndefined();

    a11y.row?.onAccessibilityTap?.();
    expect(localOnPress).toHaveBeenCalledTimes(1);
    expect(localOnPress).toHaveBeenCalledWith(item);

    a11y.row?.onAccessibilityAction?.({ nativeEvent: { actionName: 'activate' } });
    expect(localOnPress).toHaveBeenCalledTimes(2);

    // A different action name must be a no-op — guards against a handler that
    // blindly presses the row for every action a future PR adds to this element.
    a11y.row?.onAccessibilityAction?.({ nativeEvent: { actionName: 'magicTap' } });
    expect(localOnPress).toHaveBeenCalledTimes(2);
  });

  it('toggles selection from a screen-reader activation while in edit mode', () => {
    const localOnToggleSelect = vi.fn();
    const item = makeItem('a', 'Crimp Master');
    render(
      <QueueItemRow
        item={item}
        position={1}
        board={board}
        isCurrentClimb={false}
        isEditMode
        isSelected={false}
        onPress={onPress}
        onRemove={onRemove}
        onToggleSelect={localOnToggleSelect}
      />,
    );

    a11y.row?.onAccessibilityAction?.({ nativeEvent: { actionName: 'activate' } });
    expect(localOnToggleSelect).toHaveBeenCalledTimes(1);
    expect(localOnToggleSelect).toHaveBeenCalledWith('a');
    expect(onPress).not.toHaveBeenCalled();

    // Both routes go through the same handler, so both must respect edit mode.
    a11y.row?.onAccessibilityTap?.();
    expect(localOnToggleSelect).toHaveBeenCalledTimes(2);
    expect(onPress).not.toHaveBeenCalled();
  });

  // Same gap on the history row's trailing tick button — its own Gesture.Tap was
  // equally unreachable by a screen reader. The nested view's own props only reach
  // TalkBack (UIKit treats the row's `accessible` container as a leaf and never
  // focuses inside it), so the row also has to publish the tick as a labelled
  // custom action of its own. Both routes are asserted.
  it('logs an ascent from a screen-reader activation of the tick button', () => {
    const onTickHistory = vi.fn();
    const item = makeItem('a', 'Crimp Master');
    render(
      <QueueItemRow
        item={item}
        position={1}
        board={board}
        isCurrentClimb={false}
        isHistoryItem
        onPress={onPress}
        onRemove={onRemove}
        onToggleSelect={onToggleSelect}
        onTickHistory={onTickHistory}
      />,
    );

    expect(a11y.tick?.onAccessibilityTap).toBeTypeOf('function');
    expect(a11y.tick?.onAccessibilityAction).toBeTypeOf('function');
    expect(a11y.tick?.accessibilityActions).toBeUndefined();

    a11y.tick?.onAccessibilityTap?.();
    expect(onTickHistory).toHaveBeenCalledTimes(1);
    expect(onTickHistory).toHaveBeenCalledWith(item);

    a11y.tick?.onAccessibilityAction?.({ nativeEvent: { actionName: 'activate' } });
    expect(onTickHistory).toHaveBeenCalledTimes(2);

    a11y.tick?.onAccessibilityAction?.({ nativeEvent: { actionName: 'magicTap' } });
    expect(onTickHistory).toHaveBeenCalledTimes(2);
    // The tick's activation must not also fire the row press, which would make the
    // history climb current and dismiss the queue sheet.
    expect(onPress).not.toHaveBeenCalled();
  });

  it('publishes the tick as a labelled custom action on the row itself', () => {
    const onTickHistory = vi.fn();
    const item = makeItem('a', 'Crimp Master');
    render(
      <QueueItemRow
        item={item}
        position={1}
        board={board}
        isCurrentClimb={false}
        isHistoryItem
        onPress={onPress}
        onRemove={onRemove}
        onToggleSelect={onToggleSelect}
        onTickHistory={onTickHistory}
      />,
    );

    expect(a11y.row?.accessibilityActions).toEqual([{ name: 'logAscent', label: 'mobile.queue.logAscent' }]);

    a11y.row?.onAccessibilityAction?.({ nativeEvent: { actionName: 'logAscent' } });
    expect(onTickHistory).toHaveBeenCalledTimes(1);
    expect(onTickHistory).toHaveBeenCalledWith(item);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('offers no tick action on a row without a tick button', () => {
    render(
      <QueueItemRow
        item={makeItem('a', 'Crimp Master')}
        position={1}
        board={board}
        isCurrentClimb={false}
        onPress={onPress}
        onRemove={onRemove}
        onToggleSelect={onToggleSelect}
      />,
    );

    // Precondition, so this guard can't pass vacuously against unfixed code.
    expect(a11y.row?.onAccessibilityAction).toBeTypeOf('function');
    expect(a11y.row?.accessibilityActions ?? []).not.toContainEqual(expect.objectContaining({ name: 'logAscent' }));
  });

  // The row's action list comes from a useMemo keyed on whether the tick shows, so
  // it keeps its identity across renders. An inline array would hand the row a
  // fresh one every render and churn the props of this element on every update.
  it('reuses one accessibilityActions array across renders', () => {
    const item = makeItem('a', 'Crimp Master');
    const element = (
      <QueueItemRow
        item={item}
        position={1}
        board={board}
        isCurrentClimb={false}
        isHistoryItem
        onPress={onPress}
        onRemove={onRemove}
        onToggleSelect={onToggleSelect}
        onTickHistory={vi.fn()}
      />
    );
    const { rerender } = render(element);
    const rowActions = a11y.row?.accessibilityActions;
    expect(rowActions).toBeDefined();

    rerender(
      <QueueItemRow
        item={makeItem('a', 'Crimp Master')}
        position={2}
        board={board}
        isCurrentClimb={false}
        isHistoryItem
        onPress={onPress}
        onRemove={onRemove}
        onToggleSelect={onToggleSelect}
        onTickHistory={vi.fn()}
      />,
    );
    expect(a11y.row?.accessibilityActions).toBe(rowActions);
  });

  it('keeps handleDeletePress stable when item identity changes but its data is equal', () => {
    const rowProps = {
      position: 1,
      board,
      isCurrentClimb: false,
      onPress,
      onRemove,
      onToggleSelect,
    };

    const first = makeItem('a', 'Crimp Master');
    const { rerender } = render(<QueueItemRow item={first} {...rowProps} />);

    const deletePress = captured.deletePress;
    expect(deletePress).toBeTypeOf('function');

    // A fresh item object with the same uuid — same case as the tick-press test.
    const second = makeItem('a', 'Crimp Master');
    expect(second).not.toBe(first);
    rerender(<QueueItemRow item={second} {...rowProps} />);

    expect(captured.deletePress).toBe(deletePress);
  });

  it('keeps the drag handle outside the native long-press trigger', () => {
    const handleGestureCalls: { method: string; args: unknown[] }[] = [];
    const handleGesture: Record<string, (...args: unknown[]) => unknown> = {};
    const handleGestureProxy = new Proxy(handleGesture, {
      get:
        (_target, prop: string) =>
        (...args: unknown[]) => {
          handleGestureCalls.push({ method: prop, args });
          return handleGestureProxy;
        },
    });

    const dragShared: QueueDragControls['shared'] = {
      activeUuid: { value: null },
      dragTranslateY: { value: 0 },
      activeRowIndex: { value: -1 },
      targetRowIndex: { value: -1 },
      rowHeight: { value: 120 },
    } as unknown as QueueDragControls['shared'];

    const makeHandleGesture = vi.fn(
      () => handleGestureProxy as unknown as ReturnType<QueueDragControls['makeHandleGesture']>,
    );
    const drag: QueueDragControls = {
      shared: dragShared,
      onRowHeight: vi.fn(),
      makeHandleGesture,
    };

    const item = makeItem('a', 'Crimp Master');
    const { container } = render(
      <QueueItemRow
        item={item}
        position={1}
        board={board}
        isCurrentClimb={false}
        onPress={onPress}
        onRemove={onRemove}
        onToggleSelect={onToggleSelect}
        drag={drag}
        isDraggable
        rowIndex={0}
        queueIndex={0}
        onOpenActions={() => ({ climb: item.climb, boardConfig: board, queueItemUuid: item.uuid })}
      />,
    );

    expect(makeHandleGesture).toHaveBeenCalledWith(0, 'a', 0);
    expect(handleGestureCalls).toEqual([]);
    const handle = container.querySelector('[data-testid="queue-row-drag-handle"]');
    expect(handle).not.toBeNull();
    expect(handle?.closest('[data-native-menu]')).toBeNull();
    expect(container.querySelector('[data-native-menu] [data-climb-name]')).not.toBeNull();
  });

  it('keeps the history tick outside the menu and selects only its logging action', () => {
    const onTickHistory = vi.fn();
    const item = makeItem('a', 'Crimp Master');
    const { container } = render(
      <QueueItemRow
        item={item}
        position={1}
        board={board}
        isCurrentClimb={false}
        isHistoryItem
        onPress={onPress}
        onRemove={onRemove}
        onToggleSelect={onToggleSelect}
        onTickHistory={onTickHistory}
        onOpenActions={() => ({ climb: item.climb, boardConfig: board, queueItemUuid: item.uuid })}
      />,
    );

    const tick = container.querySelector('[data-testid="tick-button"]');
    expect(tick).not.toBeNull();
    expect(tick?.closest('[data-native-menu]')).toBeNull();
    captured.tickPress?.();
    expect(onTickHistory).toHaveBeenCalledWith(item);
    expect(onPress).not.toHaveBeenCalled();
  });

  // Regression guard for the swipe-to-delete side of #3683: this fix moved the row's
  // press/long-press off RN core Pressable onto RNGH gestures living in the same
  // arena as the pre-existing swipe Pan. The swipe Pan must stay a plain,
  // movement-gated gesture — no exclusivity/blocking relationship wired onto it —
  // so a future edit doesn't accidentally couple it to the new tap/long-press
  // gestures and break either swipe-to-delete or tap-to-navigate. (The real
  // cross-gesture arbitration only exists in the native runtime and isn't something
  // this jsdom-level mock can exercise — see the iOS QA matrix in the PR body.)
  it('keeps the swipe-to-delete Pan gesture free of any exclusivity/blocking wiring', () => {
    const item = makeItem('a', 'Crimp Master');
    render(
      <QueueItemRow
        item={item}
        position={1}
        board={board}
        isCurrentClimb={false}
        onPress={onPress}
        onRemove={onRemove}
        onToggleSelect={onToggleSelect}
      />,
    );

    // No `drag` prop, so the only Gesture.Pan() created is the row's swipe gesture.
    expect(gestureCalls.panLogs).toHaveLength(1);
    const swipeCalls = gestureCalls.panLogs[0].map((call) => call.method);
    expect(swipeCalls).toEqual(
      expect.arrayContaining(['enabled', 'activeOffsetX', 'failOffsetY', 'onUpdate', 'onEnd']),
    );
    expect(swipeCalls).not.toContain('blocksExternalGesture');
    expect(swipeCalls).not.toContain('requireExternalGestureToFail');
    expect(swipeCalls).not.toContain('simultaneousWithExternalGesture');

    // The native menu adds no competing RNGH long-press recognizer.
    expect(gestureCalls.tapLogs).toHaveLength(1);
    expect(gestureCalls.tapLogs[0].map((call) => call.method)).not.toContain('blocksExternalGesture');
    expect(gestureCalls.longPressLogs).toHaveLength(0);
  });

  // Regression guard for #3295: the swipe-to-remove Pan bailed on a ±5px vertical
  // wobble (`.failOffsetY([-5, 5])`) before its ±10px horizontal activation, so a
  // natural horizontal swipe failed the Pan and the row's tap fell through and just
  // selected the climb instead of revealing Delete. The Y bail must stay wider than
  // the X activation so the swipe survives normal wobble (the board manager's
  // retired swipe-to-delete row had widened this exact value first). The real
  // cross-gesture arbitration only exists in the native runtime — see the on-device
  // QA matrix in the PR body — but the threshold itself is guarded here.
  it('gives the swipe-to-remove Pan a vertical bail wide enough to survive swipe wobble', () => {
    const item = makeItem('a', 'Crimp Master');
    render(
      <QueueItemRow
        item={item}
        position={1}
        board={board}
        isCurrentClimb={false}
        onPress={onPress}
        onRemove={onRemove}
        onToggleSelect={onToggleSelect}
      />,
    );

    // No `drag` prop, so the only Gesture.Pan() created is the row's swipe gesture.
    expect(gestureCalls.panLogs).toHaveLength(1);
    const swipeCalls = gestureCalls.panLogs[0];

    const failOffsetY = swipeCalls.find((call) => call.method === 'failOffsetY');
    expect(failOffsetY?.args).toEqual([[-14, 14]]);
  });

  // Regression guard for the #3900 Codex follow-up: the swipe is left-only (onUpdate
  // discards positive-X motion), so its Pan must activate on leftward drag ONLY. A
  // symmetric `activeOffsetX([-10, 10])` also activated on right-and-down diagonals,
  // and once the Y bail widened to 14px a +11px-X/+13px-Y drag would cross +10px X
  // before 14px Y and capture the Pan as a no-op — blocking the BottomSheetFlatList
  // from scrolling. Single-negative `activeOffsetX(-10)` sets only the leftward
  // threshold (verified against RNGH's panGesture source), so rightward motion yields
  // to the scroll. Assert the single-negative form, never the symmetric array.
  it('activates the swipe Pan on leftward drag only, so right-diagonal drags do not snag the scroll', () => {
    const item = makeItem('a', 'Crimp Master');
    render(
      <QueueItemRow
        item={item}
        position={1}
        board={board}
        isCurrentClimb={false}
        onPress={onPress}
        onRemove={onRemove}
        onToggleSelect={onToggleSelect}
      />,
    );

    expect(gestureCalls.panLogs).toHaveLength(1);
    const activeOffsetX = gestureCalls.panLogs[0].find((call) => call.method === 'activeOffsetX');
    // Single negative number = leftward-only activation; NOT a symmetric [-10, 10]
    // array (which would also activate on rightward / right-diagonal drags).
    expect(activeOffsetX?.args).toEqual([-10]);
  });
});

describe('QueueItemRow added-by attribution', () => {
  const peer = { id: 'peer-1', username: 'Mina', avatarUrl: null };
  const baseProps = {
    position: 1,
    board,
    isCurrentClimb: false,
    onPress,
    onRemove,
    onToggleSelect,
  };

  beforeEach(() => {
    renderCounter.count = 0;
    a11y.row = null;
    a11y.tick = null;
    vi.clearAllMocks();
  });

  it('renders nothing outside a session', () => {
    const { container } = render(
      <QueueItemRow item={makeItem('a', 'Crimp Master', peer)} {...baseProps} showAddedBy={false} viewerUserId="me" />,
    );
    expect(container.querySelector('[data-added-by]')).toBeNull();
    expect(a11y.row?.accessibilityLabel).not.toContain('Added by');
  });

  it('renders no empty slot for an item that predates attribution', () => {
    const { container } = render(
      <QueueItemRow item={makeItem('a', 'Crimp Master')} {...baseProps} showAddedBy viewerUserId="me" />,
    );
    expect(container.querySelector('[data-added-by]')).toBeNull();
    expect(a11y.row?.accessibilityLabel).not.toContain('Added by');
  });

  it('renders nothing for the viewers own add', () => {
    const own = { id: 'me', username: 'Marco', avatarUrl: null };
    const { container } = render(
      <QueueItemRow item={makeItem('a', 'Crimp Master', own)} {...baseProps} showAddedBy viewerUserId="me" />,
    );
    expect(container.querySelector('[data-added-by]')).toBeNull();
    expect(a11y.row?.accessibilityLabel).not.toContain('Added by');
  });

  it('renders the peers face and names them in the row label', () => {
    const { container } = render(
      <QueueItemRow item={makeItem('a', 'Crimp Master', peer)} {...baseProps} showAddedBy viewerUserId="me" />,
    );
    expect(container.querySelector('[data-added-by]')?.getAttribute('data-added-by')).toBe('Mina');
    expect(a11y.row?.accessibilityLabel).toContain('Added by Mina');
  });

  it('suppresses the face in edit mode but keeps the name in the row label', () => {
    // Edit mode is the row's widest state, so the 20dp glyph goes. The
    // accessibility label has no width budget though, and a VoiceOver user
    // bulk-selecting rows to delete still needs to know whose climb each one is.
    const { container } = render(
      <QueueItemRow
        item={makeItem('a', 'Crimp Master', peer)}
        {...baseProps}
        showAddedBy
        viewerUserId="me"
        isEditMode
      />,
    );
    expect(container.querySelector('[data-added-by]')).toBeNull();
    expect(a11y.row?.accessibilityLabel).toContain('Added by Mina');
  });

  it('still skips a re-render with attribution props set', () => {
    const element = (
      <QueueItemRow item={makeItem('a', 'Crimp Master', peer)} {...baseProps} showAddedBy viewerUserId="me" />
    );
    const { rerender } = render(element);
    expect(renderCounter.count).toBe(1);
    rerender(element);
    expect(renderCounter.count).toBe(1);
  });

  it('re-renders exactly once when a session starts', () => {
    const item = makeItem('a', 'Crimp Master', peer);
    const { rerender } = render(<QueueItemRow item={item} {...baseProps} showAddedBy={false} viewerUserId="me" />);
    expect(renderCounter.count).toBe(1);
    rerender(<QueueItemRow item={item} {...baseProps} showAddedBy viewerUserId="me" />);
    expect(renderCounter.count).toBe(2);
  });
});

// Android has no onAccessibilityTap at all — 'activate' maps to ACTION_CLICK in
// ReactAccessibilityDelegate and is the only route there, so the action list is
// gated on the platform at module-evaluation time.
describe('QueueItemRow screen-reader activation on Android', () => {
  beforeEach(() => {
    a11y.row = null;
    a11y.tick = null;
    vi.clearAllMocks();
  });

  it('adds the activate action on Android', async () => {
    platform.OS = 'android';
    vi.resetModules();
    try {
      const { QueueItemRow: AndroidQueueItemRow } = await import('../QueueItemRow');
      render(
        <AndroidQueueItemRow
          item={makeItem('a', 'Crimp Master')}
          position={1}
          board={board}
          isCurrentClimb={false}
          isHistoryItem
          onPress={vi.fn()}
          onRemove={vi.fn()}
          onToggleSelect={vi.fn()}
          onTickHistory={vi.fn()}
        />,
      );

      expect(a11y.row?.accessibilityActions).toEqual([
        { name: 'activate' },
        { name: 'logAscent', label: 'mobile.queue.logAscent' },
      ]);
      expect(a11y.tick?.accessibilityActions).toEqual([{ name: 'activate' }]);
    } finally {
      platform.OS = 'ios';
      vi.resetModules();
    }
  });
});
