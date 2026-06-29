// Pure, node-testable selection logic shared by both platform RadioGroup files.
// Keeping the haptic + disabled guard here means the iOS and Android components
// can't drift on "what happens when you pick an option", and it can be unit-tested
// without mounting a native @expo/ui tree. Mirrors SegmentedControl.logic.ts.

import { hapticSelection } from '../lib/haptics';
import type { RadioOption } from './RadioGroup.types';

/**
 * Build the select handler used by both platform RadioGroup implementations.
 * Fires a selection haptic, then `onChange` with the chosen option's value —
 * unless the option is `disabled`, in which case it's a no-op (no haptic, no
 * callback).
 *
 * `haptic` is injectable so the unit test can assert it fires without a native
 * haptics module; production call sites use the default `hapticSelection`.
 *
 * Takes the whole `RadioOption` (not just the value) so the disabled guard lives
 * here once: iOS resolves the option from the Picker tag before calling, Android
 * passes the row's option straight in.
 */
export function makeRadioSelectHandler<T extends string>(
  onChange: (value: T) => void,
  haptic: () => void = hapticSelection,
): (option: RadioOption<T>) => void {
  return (option) => {
    if (option.disabled) return;
    haptic();
    onChange(option.value);
  };
}
