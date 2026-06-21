// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, useRef, type ReactNode } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { QueueItemRowBoard } from '../QueueItemRow';

// Count how many times the inner component body actually renders. The body
// renders `ClimbListItemContent` once per render, so a render counter there is a
// faithful proxy for "QueueItemRow's body ran". If React.memo is working, an
// identical-props re-render must NOT bump this counter.
const renderCounter = vi.hoisted(() => ({ count: 0 }));

// Capture the latest `onPress` handed to the row's main pressable, trailing
// tick button, and delete button so a test can assert identity across re-renders.
const captured = vi.hoisted(() => ({
  rowPress: null as null | (() => void),
  tickPress: null as null | (() => void),
  deletePress: null as null | (() => void),
}));

vi.mock('react-native', () => {
  const passthrough =
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children);
  return {
    Platform: { OS: 'ios' },
    PlatformColor: (name: string) => name,
    View: passthrough('div'),
    // Capture by testID so any future Pressable addition doesn't silently
    // overwrite the wrong slot.
    Pressable: ({ children, onPress, testID }: { children?: ReactNode; onPress?: () => void; testID?: string }) => {
      if (testID === 'tick-button' && onPress) captured.tickPress = onPress;
      if (testID === 'delete-button' && onPress) captured.deletePress = onPress;
      return createElement('button', null, children);
    },
    StyleSheet: {
      create: (styles: Record<string, unknown>) => styles,
      hairlineWidth: 1,
    },
  };
});

vi.mock('react-native-reanimated', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  // The row's `AnimatedPressable` is the only animated component, so capturing
  // its onPress gives us `handlePress`.
  const animatedPressable = ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => {
    if (onPress) captured.rowPress = onPress;
    return createElement('div', null, children);
  };
  return {
    default: { View: passthrough, createAnimatedComponent: () => animatedPressable },
    createAnimatedComponent: () => animatedPressable,
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
  const makeBuilder = () => {
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    const proxy: typeof builder = new Proxy(builder, { get: () => () => proxy });
    return proxy;
  };
  return {
    GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    Gesture: { Pan: () => makeBuilder() },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#fff', separator: '#ccc' },
    brandColors: { primary: '#6D28D9', success: '#0a0', error: '#a00' },
  }),
}));

vi.mock('../../lib/haptics', () => ({ hapticSelection: vi.fn(), hapticMedium: vi.fn() }));

vi.mock('../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../Icon', () => ({
  Icon: () => createElement('span', { 'data-icon': 'true' }),
}));

vi.mock('../ClimbListItemContent', () => ({
  ClimbListItemContent: ({ climb }: { climb?: { name?: string } }) => {
    renderCounter.count += 1;
    return createElement('span', { 'data-climb-name': climb?.name ?? '' });
  },
}));

vi.mock('../ClimbListThumbnail', () => ({ THUMBNAIL_WIDTH: 96 }));

vi.mock('../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12 } }));

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

function makeItem(uuid: string, name: string): ClimbQueueItem {
  return {
    uuid,
    climb: { uuid: `climb-${uuid}`, name } as ClimbQueueItem['climb'],
    addedBy: null,
    source: null,
  } as ClimbQueueItem;
}

// Stable callbacks — the production callers (QueueSheet / drawer-host) pass
// useCallback/useMemo-stable handlers, so the memo compare sees equal props.
const onPress = vi.fn();
const onRemove = vi.fn();
const onToggleSelect = vi.fn();

describe('QueueItemRow React.memo', () => {
  beforeEach(() => {
    renderCounter.count = 0;
    captured.rowPress = null;
    captured.tickPress = null;
    captured.deletePress = null;
    vi.clearAllMocks();
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
    const rowProps = {
      position: 1,
      board,
      isCurrentClimb: false,
      isHistoryItem: true,
      onPress,
      onRemove,
      onToggleSelect,
      onTickHistory,
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
    // dep only on `item.uuid`), or the row's pressables churn and defeat memo.
    const second = makeItem('a', 'Crimp Master');
    expect(second).not.toBe(first);
    rerender(<QueueItemRow item={second} {...rowProps} />);

    expect(captured.rowPress).toBe(rowPress);
    expect(captured.tickPress).toBe(tickPress);
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
});
