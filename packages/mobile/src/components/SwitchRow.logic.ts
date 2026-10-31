// Pure, node-testable toggle logic shared by both platform SwitchRow files.
// Keeping the guard + haptic here means the iOS and Android components can't
// drift on "what happens when you flip the switch", and it can be unit-tested
// without mounting a native @expo/ui tree.

import { hapticSelection } from '../lib/haptics';
import { traceNativeInput } from '../lib/native-input-diagnostic';

/**
 * Build the toggle handler used by both platform SwitchRow implementations.
 * Fires a selection haptic, then `onValueChange` with the next state — unless
 * `disabled`, in which case it's a no-op (no haptic, no callback).
 *
 * `haptic` is injectable so the unit test can assert it fires without a native
 * haptics module; production call sites use the default `hapticSelection`.
 *
 * @returns a `(next: boolean) => void` handler. iOS feeds the SwiftUI Toggle's
 * new value straight in; Android (whose `toggleable` modifier calls back with no
 * argument) wraps it as `() => handler(!value)`.
 */
export function makeToggleHandler(
  onValueChange: (next: boolean) => void,
  disabled: boolean,
  haptic: () => void = hapticSelection,
): (next: boolean) => void {
  return (next: boolean) => {
    traceNativeInput('make-toggle-entry', { next, capturedDisabled: disabled });
    if (disabled) {
      traceNativeInput('make-toggle-disabled-return');
      return;
    }
    traceNativeInput('before-haptic');
    haptic();
    traceNativeInput('after-haptic');
    traceNativeInput('before-parent-callback', { next });
    onValueChange(next);
    traceNativeInput('after-parent-callback');
  };
}
