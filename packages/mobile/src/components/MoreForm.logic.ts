// Pure, node-testable helpers shared by every MoreForm renderer and the test
// stub. No native imports, no rendering — so the row-kind exhaustiveness guard,
// the select-label lookup and the press/disable rules can't drift across
// platforms and are unit-testable without mounting a native @expo/ui tree. The
// one hook here (`useOpensOutsideAppHint`) only reads a translation.

import { useTranslation } from 'react-i18next';
import type { MoreButtonRow, MoreOption } from './MoreForm.types';

/**
 * Exhaustiveness guard for the `MoreRow` discriminated union. Each platform's
 * row-kind switch ends with `default: return assertNeverRow(row)`, so adding a new
 * `MoreRow` kind without handling it is a compile error (the arg won't be `never`)
 * rather than a row that silently renders nothing.
 */
export function assertNeverRow(row: never): never {
  throw new Error(`Unhandled MoreRow kind: ${JSON.stringify(row)}`);
}

/**
 * The label of the currently-selected option, for a `select` row's trailing value
 * (the Android dropdown trigger shows it; iOS's native menu Picker derives it from
 * the selected tag). Falls back to an empty string if the key isn't found.
 */
export function selectedOptionLabel(options: MoreOption[], selectedKey: string): string {
  return options.find((option) => option.key === selectedKey)?.label ?? '';
}

/**
 * Whether a button row can be pressed right now. A disabled row and a row whose
 * action is already in flight (`loading`) both refuse the press, so a second tap
 * on "Sign out" while the first is still running does nothing.
 */
export function isButtonRowPressable(row: Pick<MoreButtonRow, 'disabled' | 'loading'>): boolean {
  return !row.disabled && !row.loading;
}

/**
 * The press handler every renderer hands its native button. Re-checks the row
 * at call time rather than trusting the native `enabled` flag alone, because a
 * press can be queued on the native side just before the row turns disabled.
 */
export function guardedButtonPress(row: Pick<MoreButtonRow, 'disabled' | 'loading' | 'onPress'>): () => void {
  return () => {
    if (isButtonRowPressable(row)) row.onPress();
  };
}

/**
 * The keys a segmented or select control must refuse. A wholly `disabled` row
 * refuses every option; otherwise the row's own `disabledKeys` (if any) apply.
 * For the renderers whose control only knows per-option disabling (the RN
 * fallback's and web's `SegmentedControl`).
 */
export function disabledOptionKeys(
  options: MoreOption[],
  disabled: boolean | undefined,
  disabledKeys?: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
  if (disabled) return new Set(options.map((option) => option.key));
  return disabledKeys;
}

/**
 * The screen-reader hint on a nav row marked `external`, telling the climber the
 * row leaves Boardsesh. Resolved here rather than by every screen so a caller only
 * sets `external: true` and every renderer says the same thing.
 */
export function useOpensOutsideAppHint(): string {
  const { t } = useTranslation('common');
  return t('mobile.a11y.opensOutsideApp');
}
