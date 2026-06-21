import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gesture, type GestureType } from 'react-native-gesture-handler';
import { useSharedValue, runOnJS, type SharedValue } from 'react-native-reanimated';
import { hapticSelection } from '../../lib/haptics';
import { dropRowIndex, resolveReorderCommit } from './queue-drag-math';

// Press-and-hold this long on a handle before the drag arms. Short enough to
// feel instant on a deliberate grab, long enough that a quick flick scrolls
// the list (gorhom's BottomSheetFlatList scroll/scroll-to-expand) instead of
// lifting a row.
const LONG_PRESS_MS = 120;
// Fallback row height until the first future row reports its measured height.
// Queue rows are ~thumbnail (96) + vertical padding + separator.
const DEFAULT_ROW_HEIGHT = 120;

export type QueueDragShared = {
  activeUuid: SharedValue<string | null>;
  dragTranslateY: SharedValue<number>;
  activeRowIndex: SharedValue<number>;
  targetRowIndex: SharedValue<number>;
  rowHeight: SharedValue<number>;
};

type UseQueueDragOptions = {
  /**
   * Optimistically reorder + broadcast (queue-array indices).
   *
   * The hook internalises a ref so an unstable (non-`useCallback`) function
   * doesn't churn `controls` or re-render memoized rows.
   */
  reorderQueue: (uuid: string, oldIndex: number, newIndex: number) => void;
  /** flatRows index of the first/last contiguous `future-item` row (-1 when none). */
  firstFutureRowIndex: number;
  lastFutureRowIndex: number;
  /** queue-array index of the first future row — maps a row index to a queue index. */
  firstFutureQueueIndex: number;
};

/**
 * Row-facing drag controls. Passed down to every future `QueueItemRow`, so its
 * identity must stay stable across renders — it deliberately excludes the
 * `isDragging` flag (which flips on drag start/end). Each member is memoized in
 * `useQueueDrag`, so a memoized row only re-renders when its own props change,
 * never on drag start/end.
 */
export type QueueDragControls = {
  /** Shared values read by each row's animated style (lift + sibling shift). */
  shared: QueueDragShared;
  /** Report a future row's measured height (call once from onLayout). */
  onRowHeight: (height: number) => void;
  /** Build the long-press drag Pan for a future row's handle. */
  makeHandleGesture: (rowIndex: number, uuid: string, queueIndex: number) => GestureType;
};

export type UseQueueDragResult = {
  /** True while a row is lifted — drives the FlatList scroll + sheet-pan lock. */
  isDragging: boolean;
  /** Stable row-facing controls (no `isDragging`); safe to pass into memoized rows. */
  controls: QueueDragControls;
};

/**
 * Custom always-on drag-to-reorder for the contiguous `future-item` window of
 * the queue list. Lives at the list level (one instance per QueueList) so the
 * dragged row and its siblings share a single coordinate space. Each future
 * row's ≡ handle gets a `Gesture.Pan().activateAfterLongPress` from
 * `makeHandleGesture`; the row reads `shared` to lift itself and shift siblings
 * to open a gap. On release it maps (rowIndex → queueIndex) and calls
 * `reorderQueue`. While a drag is active `isDragging` flips so the host can
 * disable the list scroll and the sheet pan (so scroll-to-expand never fights
 * the drag).
 */
export function useQueueDrag({
  reorderQueue,
  firstFutureRowIndex,
  lastFutureRowIndex,
  firstFutureQueueIndex,
}: UseQueueDragOptions): UseQueueDragResult {
  const activeUuid = useSharedValue<string | null>(null);
  const dragTranslateY = useSharedValue(0);
  const activeRowIndex = useSharedValue(-1);
  const targetRowIndex = useSharedValue(-1);
  const rowHeight = useSharedValue(DEFAULT_ROW_HEIGHT);
  // Window bounds the drag clamps to; mirrored into shared values for the
  // onUpdate worklet.
  const firstRowIndexSV = useSharedValue(firstFutureRowIndex);
  const lastRowIndexSV = useSharedValue(lastFutureRowIndex);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    firstRowIndexSV.value = firstFutureRowIndex;
    lastRowIndexSV.value = lastFutureRowIndex;
  }, [firstFutureRowIndex, lastFutureRowIndex, firstRowIndexSV, lastRowIndexSV]);

  // Latest callbacks/mappings read on the JS thread when committing. Refs so
  // commit stays stable regardless of whether the caller wraps in useCallback.
  const reorderQueueRef = useRef(reorderQueue);
  reorderQueueRef.current = reorderQueue;
  const windowRef = useRef({ firstRowIndex: firstFutureRowIndex, firstQueueIndex: firstFutureQueueIndex });
  windowRef.current = { firstRowIndex: firstFutureRowIndex, firstQueueIndex: firstFutureQueueIndex };

  // Track the latest measured row height (don't latch the first one) so a board
  // switch with differently-shaped thumbnails keeps the drag step distance
  // correct. Future rows are uniform, so the >1px guard avoids churn from the
  // several rows reporting the same height.
  const onRowHeight = useCallback(
    (height: number) => {
      if (height > 0 && Math.abs(rowHeight.value - height) > 1) {
        rowHeight.value = height;
      }
    },
    [rowHeight],
  );

  const commit = useCallback(
    (uuid: string, oldQueueIndex: number, toRowIndex: number) => {
      const move = resolveReorderCommit(uuid, oldQueueIndex, toRowIndex, windowRef.current);
      if (move) reorderQueueRef.current(move.uuid, move.oldIndex, move.newIndex);
    },
    [], // reads refs at call time — stable regardless of reorderQueue identity
  );

  const makeHandleGesture = useCallback(
    (rowIndex: number, uuid: string, queueIndex: number): GestureType =>
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
          const next = dropRowIndex(rowIndex, event.translationY, height, firstRowIndexSV.value, lastRowIndexSV.value);
          if (next !== targetRowIndex.value) {
            targetRowIndex.value = next;
            runOnJS(hapticSelection)();
          }
        })
        .onEnd(() => {
          'worklet';
          runOnJS(commit)(uuid, queueIndex, targetRowIndex.value);
        })
        .onFinalize(() => {
          'worklet';
          activeUuid.value = null;
          dragTranslateY.value = 0;
          activeRowIndex.value = -1;
          targetRowIndex.value = -1;
          runOnJS(setIsDragging)(false);
        }),
    [activeUuid, activeRowIndex, targetRowIndex, dragTranslateY, rowHeight, firstRowIndexSV, lastRowIndexSV, commit],
  );

  // The shared-values bag holds stable `SharedValue` refs (reanimated never
  // swaps them), so memoize it once. A fresh wrapper each render would give
  // every row a new `drag.shared`, churning `renderRow`'s deps and re-rendering
  // the whole list on unrelated parent updates.
  const shared = useMemo<QueueDragShared>(
    () => ({ activeUuid, dragTranslateY, activeRowIndex, targetRowIndex, rowHeight }),
    [activeUuid, dragTranslateY, activeRowIndex, targetRowIndex, rowHeight],
  );

  // Row-facing controls: a permanently stable object (its three members are all
  // memoized above and never change identity). Passing this — rather than an
  // object that also carries `isDragging` — into memoized rows means a drag
  // start/end never re-renders the rows; only the dragged row reacts, via the
  // shared values on the UI thread.
  const controls = useMemo<QueueDragControls>(
    () => ({ shared, onRowHeight, makeHandleGesture }),
    [shared, onRowHeight, makeHandleGesture],
  );

  // Keep the result identity stable across unrelated renders; it changes only
  // when `isDragging` flips, which the host (QueueList) needs for scroll/sheet
  // locking — but that flip never reaches the rows (they read `controls`).
  return useMemo<UseQueueDragResult>(() => ({ isDragging, controls }), [isDragging, controls]);
}
