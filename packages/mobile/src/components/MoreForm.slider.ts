// Shared slider plumbing for MoreForm's `slider` row, kept out of
// MoreForm.logic.ts because that module documents itself as React-free and this
// needs a hook. Both platform files import from here so the two @expo/ui slider
// APIs can't drift apart in the two trees.

import { useCallback, useEffect, useRef } from 'react';
import type { MoreSliderRow } from './MoreForm.types';

/**
 * Material3's `Slider` takes `steps` = the number of discrete values BETWEEN the
 * endpoints, where 0 means continuous. SwiftUI's takes `step` = the increment.
 * So a 0.5–2.0 slider stepping by 0.1 has 15 intervals, 16 selectable values,
 * and therefore 14 steps between the ends.
 *
 * Off-by-one errors here are invisible in a screenshot and only show up as a
 * thumb that won't land on the last value, so this is unit-tested against every
 * real slider bound in the app rather than reasoned about at each call site.
 */
export function materialStepCount(min: number, max: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  return Math.max(0, Math.round((max - min) / step) - 1);
}

/**
 * Bridges both platforms' release signals onto `MoreSliderRow.onCommit(value)`.
 *
 * Android's `onValueChangeFinished()` carries no value and iOS's
 * `onEditingChanged(isEditing)` carries a boolean, so neither can commit on its
 * own — the last dragged value is held in a ref here rather than duplicated in
 * both platform files.
 *
 * The ref (not state) is deliberate: it is written on every drag frame and read
 * only once, on release, so it must not cause a render.
 */
export function useSliderCommit(row: MoreSliderRow): {
  handleValueChange: (value: number) => void;
  /** iOS `onEditingChanged`. Commits on the falling edge. */
  handleEditingChanged: (isEditing: boolean) => void;
  /** Android `onValueChangeFinished`. */
  handleFinished: () => void;
} {
  const { value, onValueChange, onCommit } = row;

  // The value dragged since the last commit, or null if this gesture hasn't
  // moved. Refs, not state: both are written per drag frame and read once, on
  // release, so neither may cause a render — and keeping them out of the
  // callback deps is what stops the native view seeing a new prop identity on
  // every frame of a drag.
  const draggedValue = useRef<number | null>(null);
  const externalValue = useRef(value);

  // An effect, not a render-phase write: assigning during render would clobber
  // the in-drag value whenever something unrelated re-rendered mid-gesture.
  useEffect(() => {
    externalValue.current = value;
  }, [value]);

  const handleValueChange = useCallback(
    (next: number) => {
      draggedValue.current = next;
      onValueChange(next);
    },
    [onValueChange],
  );

  // Falls back to the external value so a release that moved nothing still
  // commits something coherent rather than a stale number from a past gesture.
  const handleFinished = useCallback(() => {
    const committed = draggedValue.current ?? externalValue.current;
    draggedValue.current = null;
    onCommit(committed);
  }, [onCommit]);

  const handleEditingChanged = useCallback(
    (isEditing: boolean) => {
      if (!isEditing) handleFinished();
    },
    [handleFinished],
  );

  return { handleValueChange, handleEditingChanged, handleFinished };
}
