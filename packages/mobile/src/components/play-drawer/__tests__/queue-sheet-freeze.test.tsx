// @vitest-environment jsdom
vi.mock('../../use-ios-sheet-background-style', () => ({ useIosSheetBackgroundStyle: () => undefined }));
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { act, render } from '@testing-library/react';
import { createElement, createRef, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';

// Freeze-contract harness for QueueSheet. Both queue sheets (root + /play copy,
// PR #3337) stay mounted the whole session. A HIDDEN sheet must freeze the queue
// data it hands to QueueList to a referentially stable snapshot, so it bails out
// of the memoized QueueList instead of rebuilding on every queue nav elsewhere;
// once presented, it tracks live data again.

// The live queue-data value the (mocked) provider hands back. A test swaps this
// out and re-renders to stand in for a queue mutation somewhere else in the app.
const queueData = vi.hoisted(() => ({
  current: null as { queue: ClimbQueueItem[]; currentClimbQueueItem: ClimbQueueItem | null } | null,
}));

// The managed-sheet handle QueueSheet drives from present()/dismiss().
const managedSheet = vi.hoisted(() => ({
  present: vi.fn(),
  dismiss: vi.fn(),
  dismissAndWait: vi.fn(async () => ({ status: 'dismissed' as const })),
  onChange: vi.fn(),
  onFullyDismissed: vi.fn(),
}));

// Counts QueueList renders and records the queue prop identity it last saw. The
// mock is React.memo'd (like the real QueueList), so a stable `queue` reference
// makes it bail — exactly the win the frozen snapshot buys.
const queueList = vi.hoisted(() => ({ renders: 0, lastQueue: null as ClimbQueueItem[] | null }));

const platform = vi.hoisted(() => ({ os: 'ios' }));
// The local (mount-point) inset, and the callbacks the header / list mocks
// capture so a test can drive edit mode + selection to reveal the bulk bar.
const safeArea = vi.hoisted(() => ({ bottom: 0 }));
const sheetCallbacks = vi.hoisted(() => ({
  clearAll: null as (() => void) | null,
  toggleEditMode: null as (() => void) | null,
  toggleSelect: null as ((uuid: string) => void) | null,
}));
const gestureRoot = vi.hoisted(() => ({ style: undefined as unknown }));

type ViewProps = { children?: ReactNode; testID?: string; style?: unknown };
vi.mock('react-native', () => ({
  View: ({ children, testID, style }: ViewProps) =>
    createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(style) }, children),
  Pressable: ({ children }: ViewProps) => createElement('div', null, children),
  Platform: {
    get OS() {
      return platform.os;
    },
    select: (options: Record<string, unknown>) => options[platform.os] ?? options.default,
  },
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
}));

vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children, style }: ViewProps) => {
    gestureRoot.style = style;
    return createElement('div', { 'data-testid': 'dialog-gesture-root' }, children);
  },
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  // Passthrough sheet — renders its content inline (toasts/native modals are
  // irrelevant to the freeze contract; we only need the tree to commit).
  BottomSheetModal: ({ children }: ViewProps) => createElement('div', { 'data-testid': 'sheet' }, children),
}));

vi.mock('../../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: () => ({
    handle: {
      present: managedSheet.present,
      dismiss: managedSheet.dismiss,
      dismissAndWait: managedSheet.dismissAndWait,
    },
    onChange: managedSheet.onChange,
    onFullyDismissed: managedSheet.onFullyDismissed,
  }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: safeArea.bottom, left: 0, right: 0 }),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { background: '#fff', separator: '#000' },
    sheet: { handleStyle: {} },
  }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticMedium: vi.fn(), hapticWarning: vi.fn() }));
vi.mock('../../../theme/colors', () => ({ brandColors: { error: '#f00' } }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { white: '#fff' } }));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 3: 12, 4: 16 },
}));

vi.mock('../QueueSheetHeader', () => ({
  QueueSheetHeader: ({ onToggleEditMode, onClearAll }: { onToggleEditMode: () => void; onClearAll: () => void }) => {
    sheetCallbacks.clearAll = onClearAll;
    sheetCallbacks.toggleEditMode = onToggleEditMode;
    return null;
  },
}));
vi.mock('../../UndoSnackbar', () => ({
  UndoSnackbar: ({ bottom }: { bottom: number }) =>
    createElement('div', { 'data-testid': 'undo-snackbar', 'data-bottom': bottom }),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: ViewProps) => createElement('div', null, children) }));

vi.mock('../QueueList', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    QueueList: React.memo(
      ({ queue, onToggleSelect }: { queue: ClimbQueueItem[]; onToggleSelect: (uuid: string) => void }) => {
        sheetCallbacks.toggleSelect = onToggleSelect;
        queueList.renders += 1;
        queueList.lastQueue = queue;
        return React.createElement('div', {
          'data-testid': 'queue-list',
          'data-uuids': queue.map((item) => item.uuid).join(','),
        });
      },
    ),
  };
});

// Stable across renders — the real useQueueActions returns memoized callbacks;
// fresh functions each render would churn QueueList's props and defeat the memo.
const queueActions = vi.hoisted(() => ({
  removeFromQueue: vi.fn(),
  removeQueueItems: vi.fn(),
  clearQueue: vi.fn(),
  reorderQueue: vi.fn(),
  setQueue: vi.fn(),
  getQueueSnapshot: vi.fn(() => queueData.current ?? { queue: [], currentClimbQueueItem: null }),
  setPlaylistSuggestionSource: vi.fn(),
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueData: () => queueData.current,
  useQueueActions: () => queueActions,
  usePlaylistSuggestionSource: () => null,
  useQueueSessionId: () => ({ sessionId: null }),
}));

import { QueueSheet, type QueueSheetHandle } from '../QueueSheet';
import { publishWindowInsetBottom, resetWindowInsetForTests } from '../../../lib/window-inset-store';

function makeQueueItem(uuid: string): ClimbQueueItem {
  return {
    uuid,
    climb: {
      uuid,
      name: `Climb ${uuid}`,
      frames: 'p1r12',
      setter_username: 'setter',
      angle: 40,
      ascensionist_count: 0,
      difficulty: 'V3',
      quality_average: '3.0',
      stars: 3,
      difficulty_error: '0.3',
      benchmark_difficulty: null,
    },
    suggested: false,
  };
}

function makeData(uuids: string[]) {
  const queue = uuids.map(makeQueueItem);
  return { queue, currentClimbQueueItem: queue[0] ?? null };
}

const board = {
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 40,
};

const noopProps = {
  board,
  onClose: () => {},
  onClimbPress: () => {},
  onSuggestionPress: () => {},
  onTickHistory: () => {},
};

function renderSheet(handleRef: ReturnType<typeof createRef<QueueSheetHandle>>) {
  return render(createElement(QueueSheet, { ...noopProps, ref: handleRef }));
}

describe('QueueSheet freeze contract', () => {
  beforeEach(() => {
    platform.os = 'ios';
    gestureRoot.style = undefined;
    queueData.current = makeData(['a', 'b']);
    managedSheet.present.mockClear();
    managedSheet.dismiss.mockClear();
    managedSheet.dismissAndWait.mockClear();
    queueList.renders = 0;
    queueList.lastQueue = null;
    safeArea.bottom = 0;
    resetWindowInsetForTests();
  });

  it('hosts Android queue gestures inside the native dialog with a flex root', () => {
    platform.os = 'android';
    const { getByTestId } = renderSheet(createRef<QueueSheetHandle>());
    const root = getByTestId('dialog-gesture-root');
    expect(getByTestId('sheet').contains(root)).toBe(true);
    expect(root.contains(getByTestId('queue-list'))).toBe(true);
    expect(gestureRoot.style).toHaveProperty('flex', 1);
  });

  it('preserves the iOS sheet content without an extra gesture root', () => {
    const { queryByTestId, getByTestId } = renderSheet(createRef<QueueSheetHandle>());
    expect(queryByTestId('dialog-gesture-root')).toBeNull();
    expect(getByTestId('sheet').contains(getByTestId('queue-list'))).toBe(true);
  });

  it('does NOT re-render QueueList when queue data changes while hidden', () => {
    const handleRef = createRef<QueueSheetHandle>();
    const { container, rerender } = renderSheet(handleRef);

    // Hidden sheet's initial snapshot = the live data at mount.
    expect(container.querySelector('[data-testid="queue-list"]')?.getAttribute('data-uuids')).toBe('a,b');
    const rendersAfterMount = queueList.renders;
    const frozenQueue = queueList.lastQueue;

    // A queue mutation elsewhere changes the provider's live value; force the
    // hidden sheet to re-render (as the provider would).
    queueData.current = makeData(['a', 'b', 'c']);
    rerender(createElement(QueueSheet, { ...noopProps, ref: handleRef }));

    // The frozen snapshot held: QueueList still shows the stale queue, kept its
    // referential identity, and the memo bailed (no extra render).
    expect(container.querySelector('[data-testid="queue-list"]')?.getAttribute('data-uuids')).toBe('a,b');
    expect(queueList.lastQueue).toBe(frozenQueue);
    expect(queueList.renders).toBe(rendersAfterMount);
  });

  it('tracks live queue data once present() is called', () => {
    const handleRef = createRef<QueueSheetHandle>();
    const { container } = renderSheet(handleRef);

    expect(container.querySelector('[data-testid="queue-list"]')?.getAttribute('data-uuids')).toBe('a,b');

    // The live queue changes while the sheet is still hidden — frozen.
    queueData.current = makeData(['a', 'b', 'c']);

    // Present the sheet: setIsActive(true) unfreezes the snapshot in the same
    // commit, so the list catches up to the live queue.
    act(() => {
      handleRef.current?.present();
    });

    expect(managedSheet.present).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="queue-list"]')?.getAttribute('data-uuids')).toBe('a,b,c');
    expect(queueList.lastQueue).toBe(queueData.current?.queue);
  });

  it('forwards dismissAndWait through the imperative handle', async () => {
    const handleRef = createRef<QueueSheetHandle>();
    renderSheet(handleRef);

    if (!handleRef.current) throw new Error('queue sheet handle did not mount');
    await expect(handleRef.current.dismissAndWait()).resolves.toEqual({ status: 'dismissed' });
    expect(managedSheet.dismissAndWait).toHaveBeenCalledTimes(1);
  });
});

describe('QueueSheet bulk-remove bar', () => {
  beforeEach(() => {
    platform.os = 'ios';
    queueData.current = makeData(['a', 'b']);
    safeArea.bottom = 0;
    resetWindowInsetForTests();
  });

  it('pads by the WINDOW inset, not the in-tab inset that folds in the tab bar (#3776)', () => {
    // A mount point inside a NativeTabs tab reports 139 (34 + 49 bar + 56
    // accessory, DEVICE_VERIFIED iPhone 17 Pro); the sheet covers that chrome,
    // so the bar clears only the window's 34 + spacing[3].
    safeArea.bottom = 139;
    act(() => publishWindowInsetBottom(34));
    const { container } = renderSheet(createRef<QueueSheetHandle>());

    act(() => sheetCallbacks.toggleEditMode?.());
    act(() => sheetCallbacks.toggleSelect?.('a'));

    const styles = [...container.querySelectorAll('[data-style]')].map((node) => node.getAttribute('data-style') ?? '');
    const bulkBarStyle = styles.find((style) => style.includes('"paddingBottom"'));
    expect(bulkBarStyle).toContain('"paddingBottom":46');
  });

  it('keeps Undo above the window inset after clearing the queue', () => {
    safeArea.bottom = 139;
    act(() => publishWindowInsetBottom(34));
    const { getByTestId } = renderSheet(createRef<QueueSheetHandle>());

    act(() => sheetCallbacks.clearAll?.());

    expect(getByTestId('undo-snackbar').getAttribute('data-bottom')).toBe('46');
  });
});
