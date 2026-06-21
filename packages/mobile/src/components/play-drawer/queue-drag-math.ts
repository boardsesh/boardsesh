// Pure index / offset math for the queue drag-to-reorder hook. Extracted so the
// non-trivial mapping (flat-row index ↔ queue-array index, drop clamping, and
// the sibling gap-shift) is unit-testable without the Reanimated / gesture-
// handler runtime. Each helper carries the 'worklet' directive so it can also be
// called from UI-thread worklets (the directive is an inert string statement in
// plain JS / the test runner). This mirrors the codebase's existing pattern of
// importing 'worklet' helpers into worklets (e.g. computePeekOffset).

/** Map a flat-list row index in the future window to its queue-array index. */
export function queueIndexForRow(rowIndex: number, firstRowIndex: number, firstQueueIndex: number): number {
  'worklet';
  return firstQueueIndex + (rowIndex - firstRowIndex);
}

/** Clamp a (possibly out-of-range) row index to the draggable window. */
export function clampRowIndex(rowIndex: number, firstRowIndex: number, lastRowIndex: number): number {
  'worklet';
  if (rowIndex < firstRowIndex) return firstRowIndex;
  if (rowIndex > lastRowIndex) return lastRowIndex;
  return rowIndex;
}

/**
 * Where the dragged row would drop, given its starting row index and the finger
 * delta, clamped to the draggable window. `rowHeight` must be > 0.
 */
export function dropRowIndex(
  startRowIndex: number,
  translateY: number,
  rowHeight: number,
  firstRowIndex: number,
  lastRowIndex: number,
): number {
  'worklet';
  const raw = Math.round(startRowIndex + translateY / rowHeight);
  return clampRowIndex(raw, firstRowIndex, lastRowIndex);
}

/** The draggable window mapping needed to turn a drop into a queue reorder. */
export type ReorderWindow = { firstRowIndex: number; firstQueueIndex: number };

/**
 * Decide the reorder to commit when a drag ends: maps the drop row index to a
 * queue index and returns the move, or null when there's no draggable window
 * (`firstRowIndex < 0`) or the item didn't actually move. Pure so the hook's
 * JS-thread commit path is unit-testable without the gesture runtime.
 */
export function resolveReorderCommit(
  uuid: string,
  oldQueueIndex: number,
  toRowIndex: number,
  window: ReorderWindow,
): { uuid: string; oldIndex: number; newIndex: number } | null {
  if (window.firstRowIndex < 0) return null;
  const newQueueIndex = queueIndexForRow(toRowIndex, window.firstRowIndex, window.firstQueueIndex);
  if (newQueueIndex === oldQueueIndex) return null;
  return { uuid, oldIndex: oldQueueIndex, newIndex: newQueueIndex };
}

/**
 * Vertical offset a sibling row animates to so a gap opens under the lifted row:
 * rows the dragged row has crossed shift one row-height toward the drag origin;
 * the dragged row itself and untouched rows return 0.
 */
export function rowReorderShift(
  rowIndex: number,
  activeRowIndex: number,
  targetRowIndex: number,
  rowHeight: number,
): number {
  'worklet';
  if (activeRowIndex < targetRowIndex && rowIndex > activeRowIndex && rowIndex <= targetRowIndex) return -rowHeight;
  if (activeRowIndex > targetRowIndex && rowIndex >= targetRowIndex && rowIndex < activeRowIndex) return rowHeight;
  return 0;
}
