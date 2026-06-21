import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gesture, type GestureType } from 'react-native-gesture-handler';
import { useSharedValue, runOnJS, type SharedValue } from 'react-native-reanimated';
import { hapticSelection } from '../../lib/haptics';
import { dropRowIndex } from '../play-drawer/queue-drag-math';

// Press-and-hold this long on a handle before the drag arms — long enough that a
// quick flick scrolls the list instead of lifting a row. Matches the queue.
const LONG_PRESS_MS = 120;
// Fallback row height until the first row reports its measured height.
const DEFAULT_ROW_HEIGHT = 96;

export type PlaylistDragShared = {
  activeUuid: SharedValue<string | null>;
  dragTranslateY: SharedValue<number>;
  activeRowIndex: SharedValue<number>;
  targetRowIndex: SharedValue<number>;
  rowHeight: SharedValue<number>;
};

/**
 * Row-facing drag controls passed down to every `PlaylistEditClimbRow`. Identity
 * stays stable across renders (every member is memoized) so a memoized row only
 * re-renders when its own props change, never on drag start/end.
 */
export type PlaylistDragControls = {
  shared: PlaylistDragShared;
  /** Report a row's measured height (call once from onLayout). */
  onRowHeight: (height: number) => void;
  /** Build the long-press drag Pan for a row's handle. */
  makeHandleGesture: (rowIndex: number, uuid: string) => GestureType;
};

export type UsePlaylistDragOptions = {
  /**
   * Commit a single move (loaded-list indices). Internalised via a ref so an
   * unstable (non-`useCallback`) function doesn't churn `controls`.
   */
  reorder: (uuid: string, newIndex: number) => void;
  /** Number of rows in the editable list (drag clamps to [0, itemCount - 1]). */
  itemCount: number;
};

export type UsePlaylistDragResult = {
  /** True while a row is lifted — drives the list scroll lock. */
  isDragging: boolean;
  /** Stable row-facing controls (no `isDragging`); safe for memoized rows. */
  controls: PlaylistDragControls;
};

/**
 * Custom long-press drag-to-reorder for the playlist edit list. One instance per
 * list (so the dragged row and its siblings share a coordinate space). Each row's
 * ≡ handle gets a `Gesture.Pan().activateAfterLongPress` from `makeHandleGesture`;
 * the row reads `shared` to lift itself and shift siblings to open a gap. On
 * release it commits `(uuid, newIndex)`. Simpler than the queue's hook: the whole
 * loaded list is reorderable, so a row index maps straight to a list index.
 */
export function usePlaylistDrag({ reorder, itemCount }: UsePlaylistDragOptions): UsePlaylistDragResult {
  const activeUuid = useSharedValue<string | null>(null);
  const dragTranslateY = useSharedValue(0);
  const activeRowIndex = useSharedValue(-1);
  const targetRowIndex = useSharedValue(-1);
  const rowHeight = useSharedValue(DEFAULT_ROW_HEIGHT);
  const lastRowIndexSV = useSharedValue(itemCount - 1);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    lastRowIndexSV.value = itemCount - 1;
  }, [itemCount, lastRowIndexSV]);

  // Read on the JS thread at commit time. A ref keeps `commit` stable regardless
  // of whether the caller wrapped `reorder` in useCallback.
  const reorderRef = useRef(reorder);
  reorderRef.current = reorder;

  const onRowHeight = useCallback(
    (height: number) => {
      if (height > 0 && Math.abs(rowHeight.value - height) > 1) {
        rowHeight.value = height;
      }
    },
    [rowHeight],
  );

  const commit = useCallback((uuid: string, fromRowIndex: number, toRowIndex: number) => {
    if (toRowIndex !== fromRowIndex && toRowIndex >= 0) {
      reorderRef.current(uuid, toRowIndex);
    }
  }, []);

  const makeHandleGesture = useCallback(
    (rowIndex: number, uuid: string): GestureType =>
      Gesture.Pan()
        .activateAfterLongPress(LONG_PRESS_MS)
        .onStart(() => {
          'worklet';
          activeUuid.value = uuid;
          activeRowIndex.value = rowIndex;
          targetRowIndex.value = rowIndex;
          dragTranslateY.value = 0;
          runOnJS(setIsDragging)(true);
          runOnJS(hapticSelection)();
        })
        .onUpdate((event) => {
          'worklet';
          dragTranslateY.value = event.translationY;
          const height = rowHeight.value || DEFAULT_ROW_HEIGHT;
          const next = dropRowIndex(rowIndex, event.translationY, height, 0, lastRowIndexSV.value);
          if (next !== targetRowIndex.value) {
            targetRowIndex.value = next;
            runOnJS(hapticSelection)();
          }
        })
        .onEnd(() => {
          'worklet';
          runOnJS(commit)(uuid, rowIndex, targetRowIndex.value);
        })
        .onFinalize(() => {
          'worklet';
          activeUuid.value = null;
          dragTranslateY.value = 0;
          activeRowIndex.value = -1;
          targetRowIndex.value = -1;
          runOnJS(setIsDragging)(false);
        }),
    [activeUuid, activeRowIndex, targetRowIndex, dragTranslateY, rowHeight, lastRowIndexSV, commit],
  );

  const shared = useMemo<PlaylistDragShared>(
    () => ({ activeUuid, dragTranslateY, activeRowIndex, targetRowIndex, rowHeight }),
    [activeUuid, dragTranslateY, activeRowIndex, targetRowIndex, rowHeight],
  );

  const controls = useMemo<PlaylistDragControls>(
    () => ({ shared, onRowHeight, makeHandleGesture }),
    [shared, onRowHeight, makeHandleGesture],
  );

  return useMemo<UsePlaylistDragResult>(() => ({ isDragging, controls }), [isDragging, controls]);
}
