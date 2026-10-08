// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, createRef, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';

// The queue sheet's Clear and bulk Remove each offer an Undo (HIG "Undo and
// redo"). The Undo must restore through the queue's ordinary whole-queue
// replace (`setQueue`) so a shared session syncs it like any other edit, and
// must keep whatever a crew member changed in the meantime.

type Snapshot = { queue: ClimbQueueItem[]; currentClimbQueueItem: ClimbQueueItem | null };
const live = vi.hoisted(() => ({ current: { queue: [], currentClimbQueueItem: null } as Snapshot }));

type ViewProps = { children?: ReactNode; testID?: string; onPress?: () => void; accessibilityLabel?: string };
vi.mock('react-native', () => ({
  View: ({ children }: ViewProps) => createElement('div', null, children),
  Pressable: ({ children, onPress, accessibilityLabel }: ViewProps) =>
    createElement('button', { onClick: onPress, 'data-label': accessibilityLabel }, children),
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
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
  useTheme: () => ({ systemColors: { background: '#fff', separator: '#000' }, sheet: { handleStyle: {} } }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticWarning: vi.fn() }));
vi.mock('../../../theme/colors', () => ({ brandColors: { error: '#f00' } }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { white: '#fff' } }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 3: 12, 4: 16 } }));
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
  QueueList: ({ queue, onToggleSelect }: { queue: ClimbQueueItem[]; onToggleSelect: (uuid: string) => void }) =>
    createElement(
      'div',
      null,
      queue.map((item) =>
        createElement('button', {
          key: item.uuid,
          'data-testid': `select-${item.uuid}`,
          onClick: () => onToggleSelect(item.uuid),
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
}));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueData: () => live.current,
  useQueueActions: () => actions,
  usePlaylistSuggestionSource: () => null,
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

function renderSheet() {
  const ref = createRef<QueueSheetHandle>();
  const view = render(
    createElement(QueueSheet, {
      ref,
      board: { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 },
      onClose: () => {},
      onClimbPress: () => {},
      onSuggestionPress: () => {},
      onTickHistory: () => {},
    }),
  );
  act(() => ref.current?.present());
  return view;
}

beforeEach(() => {
  const queue = ['a', 'b', 'c'].map(item);
  live.current = { queue, currentClimbQueueItem: queue[1] };
  for (const mock of Object.values(actions)) mock.mockReset();
  actions.getQueueSnapshot.mockImplementation(() => live.current);
  actions.clearQueue.mockImplementation(() => {
    live.current = { queue: [], currentClimbQueueItem: null };
  });
  actions.removeQueueItems.mockImplementation((uuids: readonly string[]) => {
    const removed = new Set(uuids);
    live.current = {
      queue: live.current.queue.filter((queueItem) => !removed.has(queueItem.uuid)),
      currentClimbQueueItem: live.current.currentClimbQueueItem,
    };
  });
});

describe('QueueSheet undo', () => {
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

  it('drops the offer when dismissed, so a late tap restores nothing', () => {
    const { getByTestId, queryByTestId } = renderSheet();
    fireEvent.click(getByTestId('clear'));
    fireEvent.click(getByTestId('undo-dismiss'));
    expect(queryByTestId('undo-snackbar')).toBeNull();
    expect(actions.setQueue).not.toHaveBeenCalled();
  });
});
