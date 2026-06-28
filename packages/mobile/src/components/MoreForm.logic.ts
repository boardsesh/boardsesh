// Pure, node-testable helpers shared by both platform MoreForm files and the test
// stub. No native imports, no rendering — so the row-kind exhaustiveness guard and
// the select-label lookup can't drift across platforms and are unit-testable
// without mounting a native @expo/ui tree.

import type { MoreOption } from './MoreForm.types';

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
