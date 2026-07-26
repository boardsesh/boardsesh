/**
 * Stand-in for `StyleSheet.flatten` in suites that mock `react-native` wholesale.
 * Resolves a (possibly nested) RN style array down to one object — later entries
 * win, falsy entries are skipped — so a mocked `View` can report the style it was
 * actually handed, and code under test that calls `StyleSheet.flatten` keeps working.
 *
 * Import it from inside the `vi.mock('react-native', …)` factory with a dynamic
 * `await import(…)`; a top-level import would be referenced before initialisation
 * because Vitest hoists mock factories above the imports.
 */
export function flattenStyle(style: unknown): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};
  const walk = (entry: unknown) => {
    if (!entry) return;
    if (Array.isArray(entry)) {
      for (const item of entry) walk(item);
      return;
    }
    Object.assign(flattened, entry);
  };
  walk(style);
  return flattened;
}
