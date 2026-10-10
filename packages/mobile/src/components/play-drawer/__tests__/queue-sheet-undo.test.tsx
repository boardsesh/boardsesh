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
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, createRef, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { restoreRemovedQueueItems } from '../../../lib/queue-undo';
import { invalidatePrivacyQueries } from '../../../lib/privacy/privacy-cache';

// The queue sheet's Clear and bulk Remove each offer an Undo (HIG "Undo and
// redo"). The Undo must restore through the queue's ordinary whole-queue
// replace (`setQueue`) so a shared session syncs it like any other edit, and
// must keep whatever a crew member changed in the meantime.

type Snapshot = { queue: ClimbQueueItem[]; currentClimbQueueItem: ClimbQueueItem | null };
const live = vi.hoisted(() => ({
  current: { queue: [], currentClimbQueueItem: null } as Snapshot,
  sessionId: 'session-1' as string | null,
  boardAccountScope: 'kilter:account-1',
  playlistSource: null as PlaylistSuggestionSource | null,
}));

type ViewProps = { children?: ReactNode; testID?: string; onPress?: () => void; accessibilityLabel?: string };
vi.mock('react-native', () => ({
  View: ({ children }: ViewProps) => createElement('div', null, children),
  Pressable: ({ children, onPress, accessibilityLabel }: ViewProps) =>
    createElement('button', { onClick: onPress, 'data-label': accessibilityLabel }, children),
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios },
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
}));
vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: ViewProps) => createElement('div', null, children),
}));
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetModal: ({ children }: ViewProps) => createElement('div', null, children),
}));
vi.mock('../../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: () => ({
    handle: { present: vi.fn(), dismiss: vi.fn(), dismissAndWait: vi.fn() },
    onChange: vi.fn(),
    onFullyDismissed: vi.fn(),
  }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { count?: number }) => (params?.count == null ? key : `${key}:${params.count}`),
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({ systemColors: { background: '#fff', separator: '#000' }, sheet: { handleStyle: {} } }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticWarning: vi.fn() }));
vi.mock('../../../theme/colors', () => ({ brandColors: { error: '#f00' } }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { white: '#fff' } }));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 3: 12, 4: 16 },
}));
vi.mock('../../Text', () => ({ Text: ({ children }: ViewProps) => createElement('span', null, children) }));

// Header: Clear + an edit toggle. List: one select button per row.
vi.mock('../QueueSheetHeader', () => ({
  QueueSheetHeader: ({ onClearAll, onToggleEditMode }: { onClearAll: () => void; onToggleEditMode: () => void }) =>
    createElement(
      'div',
      null,
      createElement('button', { 'data-testid': 'clear', onClick: onClearAll }),
      createElement('button', { 'data-testid': 'edit', onClick: onToggleEditMode }),
    ),
}));
vi.mock('../QueueList', () => ({
  QueueList: ({
    queue,
    onToggleSelect,
    onRemove,
  }: {
    queue: ClimbQueueItem[];
    onToggleSelect: (uuid: string) => void;
    onRemove: (uuid: string) => void;
  }) =>
    createElement(
      'div',
      null,
      ...queue.map((item) =>
        createElement('button', {
          key: item.uuid,
          'data-testid': `select-${item.uuid}`,
          onClick: () => onToggleSelect(item.uuid),
        }),
      ),
      ...queue.map((item) =>
        createElement('button', {
          key: `remove-${item.uuid}`,
          'data-testid': `remove-${item.uuid}`,
          onClick: () => onRemove(item.uuid),
        }),
      ),
    ),
}));
vi.mock('../../UndoSnackbar', () => ({
  UndoSnackbar: ({ message, onUndo, onDismiss }: { message: string; onUndo: () => void; onDismiss: () => void }) =>
    createElement(
      'div',
      { 'data-testid': 'undo-snackbar', 'data-message': message },
      createElement('button', { 'data-testid': 'undo', onClick: onUndo }),
      createElement('button', { 'data-testid': 'undo-dismiss', onClick: onDismiss }),
    ),
}));

const actions = vi.hoisted(() => ({
  removeFromQueue: vi.fn(),
  reorderQueue: vi.fn(),
  setPlaylistSuggestionSource: vi.fn(),
  getQueueSnapshot: vi.fn(),
  clearQueue: vi.fn(),
  removeQueueItems: vi.fn(),
  setQueue: vi.fn(),
  restoreQueueItems: vi.fn(),
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueData: () => live.current,
  useQueueActions: () => actions,
  usePlaylistSuggestionSource: () => live.playlistSource,
  useQueueSessionId: () => ({ sessionId: live.sessionId, undoScope: `${live.sessionId}:${live.boardAccountScope}` }),
}));

import { QueueSheet, type QueueSheetHandle } from '../QueueSheet';

function item(uuid: string): ClimbQueueItem {
  return {
    uuid,
    climb: {
      uuid: `climb-${uuid}`,
      name: uuid,
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

const uuidsOf = (queue: ClimbQueueItem[]) => queue.map((queueItem) => queueItem.uuid);

const sheetProps = {
  board: { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 },
  onClose: () => {},
  onClimbPress: () => {},
  onSuggestionPress: () => {},
  onTickHistory: () => {},
};

function renderSheet() {
  const ref = createRef<QueueSheetHandle>();
  const view = render(createElement(QueueSheet, { ...sheetProps, ref }));
  act(() => ref.current?.present());
  return view;
}

beforeEach(() => {
  const queue = ['a', 'b', 'c'].map(item);
  live.current = { queue, currentClimbQueueItem: queue[1] };
  live.sessionId = 'session-1';
  live.boardAccountScope = 'kilter:account-1';
  live.playlistSource = null;
  for (const mock of Object.values(actions)) mock.mockReset();
  actions.getQueueSnapshot.mockImplementation(() => live.current);
  actions.restoreQueueItems.mockImplementation((before: Snapshot, removedUuids: ReadonlySet<string>) => {
    const restored = restoreRemovedQueueItems(before, removedUuids, live.current);
    actions.setQueue(restored.queue, restored.currentClimbQueueItem);
  });
  actions.clearQueue.mockImplementation(() => {
    live.current = { queue: [], currentClimbQueueItem: null };
    live.playlistSource = null;
  });
  actions.removeQueueItems.mockImplementation((uuids: readonly string[]) => {
    const removed = new Set(uuids);
    live.current = {
      queue: live.current.queue.filter((queueItem) => !removed.has(queueItem.uuid)),
      currentClimbQueueItem:
        live.current.currentClimbQueueItem && removed.has(live.current.currentClimbQueueItem.uuid)
          ? null
          : live.current.currentClimbQueueItem,
    };
  });
});

describe('QueueSheet undo', () => {
  it('rejects a stale Undo callback after privacy invalidation without waiting for a render', async () => {
    const queryClient = new QueryClient();
    live.playlistSource = {
      playlistUuid: 'private-playlist',
      activatedClimbUuid: 'climb-b',
      boardKey: 'kilter:1',
      climbs: [item('b').climb],
    };
    const { getByTestId } = renderSheet();
    fireEvent.click(getByTestId('clear'));
    const undoButton = getByTestId('undo');
    // The mocked provider's scope stays unchanged: only the imperative privacy
    // generation can protect the callback captured by this rendered button.
    await invalidatePrivacyQueries(queryClient);
    fireEvent.click(undoButton);

    expect(actions.restoreQueueItems).not.toHaveBeenCalled();
    expect(actions.setQueue).not.toHaveBeenCalled();
    expect(actions.setPlaylistSuggestionSource).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it('offers Undo after Clear and puts the queue back through setQueue', () => {
    const { getByTestId } = renderSheet();
    fireEvent.click(getByTestId('clear'));
    expect(actions.clearQueue).toHaveBeenCalledTimes(1);
    expect(getByTestId('undo-snackbar').getAttribute('data-message')).toBe('mobile.queueSheet.cleared');

    fireEvent.click(getByTestId('undo'));
    expect(actions.setQueue).toHaveBeenCalledTimes(1);
    const [restoredQueue, restoredCurrent] = actions.setQueue.mock.calls[0] as [
      ClimbQueueItem[],
      ClimbQueueItem | null,
    ];
    expect(uuidsOf(restoredQueue)).toEqual(['a', 'b', 'c']);
    expect(restoredCurrent?.uuid).toBe('b');
  });

  it("keeps a crew member's add made while the Undo was on screen", () => {
    const { getByTestId } = renderSheet();
    fireEvent.click(getByTestId('clear'));
    // A peer queues a climb before the climber taps Undo.
    live.current = { queue: [item('peer')], currentClimbQueueItem: null };

    fireEvent.click(getByTestId('undo'));
    const [restoredQueue] = actions.setQueue.mock.calls[0] as [ClimbQueueItem[]];
    expect(uuidsOf(restoredQueue)).toEqual(['a', 'b', 'c', 'peer']);
  });

  it('removes the selection in one batch and Undo restores only those climbs', () => {
    const { getByTestId, container } = renderSheet();
    fireEvent.click(getByTestId('edit'));
    fireEvent.click(getByTestId('select-a'));
    fireEvent.click(getByTestId('select-c'));
    const removeButton = container.querySelector('[data-label="queueDrawer.removeItems:2"]');
    if (!removeButton) throw new Error('bulk remove button missing');
    fireEvent.click(removeButton);

    // One batched action (it rides the serialized queue lane), not N removes.
    expect(actions.removeQueueItems).toHaveBeenCalledTimes(1);
    expect(actions.removeFromQueue).not.toHaveBeenCalled();
    expect(getByTestId('undo-snackbar').getAttribute('data-message')).toBe('mobile.queueSheet.removed:2');

    // Meanwhile a crew member removes b: the Undo must not bring b back.
    live.current = { queue: [], currentClimbQueueItem: null };
    fireEvent.click(getByTestId('undo'));
    const [restoredQueue] = actions.setQueue.mock.calls[0] as [ClimbQueueItem[]];
    expect(uuidsOf(restoredQueue)).toEqual(['a', 'c']);
  });

  it('offers scoped Undo for a one-row swipe removal and keeps a peer current climb', () => {
    const { getByTestId } = renderSheet();
    fireEvent.click(getByTestId('remove-b'));
    expect(actions.removeQueueItems).toHaveBeenCalledWith(['b']);
    expect(getByTestId('undo-snackbar').getAttribute('data-message')).toBe('mobile.queueSheet.removed:1');
    const peer = item('peer');
    live.current = { queue: [...live.current.queue, peer], currentClimbQueueItem: peer };
    fireEvent.click(getByTestId('undo'));
    const [restoredQueue, restoredCurrent] = actions.setQueue.mock.calls[0] as [ClimbQueueItem[], ClimbQueueItem];
    expect(uuidsOf(restoredQueue)).toEqual(['a', 'b', 'c', 'peer']);
    expect(restoredCurrent.uuid).toBe('peer');
  });

  it('drops the offer when dismissed, so a late tap restores nothing', () => {
    const { getByTestId, queryByTestId } = renderSheet();
    fireEvent.click(getByTestId('clear'));
    fireEvent.click(getByTestId('undo-dismiss'));
    expect(queryByTestId('undo-snackbar')).toBeNull();
    expect(actions.setQueue).not.toHaveBeenCalled();
  });

  it('drops the offer when the session ends or changes, so Undo cannot write into another room', () => {
    const { getByTestId, queryByTestId, rerender } = renderSheet();
    fireEvent.click(getByTestId('clear'));
    expect(getByTestId('undo-snackbar')).toBeTruthy();

    // SessionEnded / leave → clearSession → the provider's session id changes.
    live.sessionId = null;
    rerender(createElement(QueueSheet, sheetProps));
    expect(queryByTestId('undo-snackbar')).toBeNull();
    expect(actions.setQueue).not.toHaveBeenCalled();
  });

  it.each(['tension:account-1', 'kilter:account-2'])('drops solo Undo on board/account switch to %s', (scope) => {
    live.sessionId = null;
    const { getByTestId, queryByTestId, rerender } = renderSheet();
    fireEvent.click(getByTestId('clear'));
    live.boardAccountScope = scope;
    rerender(createElement(QueueSheet, sheetProps));
    expect(queryByTestId('undo-snackbar')).toBeNull();
    expect(actions.restoreQueueItems).not.toHaveBeenCalled();
  });

  it("keeps an Undo within the 500-climb sync cap by dropping re-added climbs, never the crew's", () => {
    const fullQueue = Array.from({ length: 500 }, (_unused, index) => item(`q-${index}`));
    live.current = { queue: fullQueue, currentClimbQueueItem: null };
    const { getByTestId } = renderSheet();
    fireEvent.click(getByTestId('clear'));
    live.current = { queue: [item('peer')], currentClimbQueueItem: null };

    fireEvent.click(getByTestId('undo'));
    const [restoredQueue] = actions.setQueue.mock.calls[0] as [ClimbQueueItem[]];
    expect(restoredQueue).toHaveLength(500);
    expect(restoredQueue.at(-1)?.uuid).toBe('peer');
    expect(restoredQueue.some((queueItem) => queueItem.uuid === 'q-499')).toBe(false);
  });
});
