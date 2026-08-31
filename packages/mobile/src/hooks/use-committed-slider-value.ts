import { useCallback, useEffect, useState } from 'react';

/**
 * Local-draft + commit-on-release for a slider that writes straight to a
 * persisted settings store (no separate sheet with its own Save button, like
 * the Classic marker brush/size sheets have). `draftValue` tracks every in-drag
 * change; `handleChangeEnd` is the only place this ever calls `commit`, so a
 * whole drag gesture writes to AsyncStorage once, not once per touch-move.
 *
 * `draftValue` re-seeds whenever `externalValue` changes (a preset apply, Reset
 * all, or the initial mount) — safe because `commit` finishing is itself an
 * `externalValue` change that resolves to the same number.
 *
 * Extracted from `components/settings/MarkerMultiplierSlider`, which still
 * re-exports it, because the native `@expo/ui` slider rows in `MoreForm` need
 * the same draft/commit split: a native `Slider` fires `onValueChange` on every
 * drag frame, and only its commit signal (iOS `onEditingChanged(false)`,
 * Android `onValueChangeFinished`) may reach the store.
 */
/**
 * Just the draft half: mirror an external number into local state that a drag
 * can move freely, re-seeding whenever the external value changes underneath.
 *
 * Split out because the MoreForm slider rows own their own commit (the row's
 * `onCommit` writes the setting), so they need the draft without a second,
 * unused commit callback threaded through to reach it.
 */
export function useDraftNumber(externalValue: number): {
  draftValue: number;
  setDraftValue: (value: number) => void;
} {
  const [draftValue, setDraftValue] = useState(externalValue);

  useEffect(() => {
    setDraftValue(externalValue);
  }, [externalValue]);

  return { draftValue, setDraftValue };
}

export function useCommittedSliderValue(
  externalValue: number,
  commit: (value: number) => void,
): { draftValue: number; setDraftValue: (value: number) => void; handleChangeEnd: (value: number) => void } {
  const { draftValue, setDraftValue } = useDraftNumber(externalValue);

  const handleChangeEnd = useCallback((value: number) => commit(value), [commit]);

  return { draftValue, setDraftValue, handleChangeEnd };
}
