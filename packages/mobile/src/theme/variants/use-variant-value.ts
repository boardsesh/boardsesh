import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from './select-by-variant';
import type { UiVariant } from '../resolve-ui-variant';

/**
 * `selectByVariant` bound to the live `theme.variant` — the everyday value pick for
 * a component that doesn't already destructure the theme.
 *
 * Same exhaustiveness guarantee as `selectByVariant`: the `Record<UiVariant, T>`
 * makes a new variant a compile error at the call site. Same performance rule, too:
 * when the value is an object handed to a `React.memo` child or used as a
 * `useMemo`/gesture dependency, define the map as a module-scope `const` and pass it
 * in — never an inline object literal (which builds a new object every render and
 * defeats memoisation). For primitives consumed directly in JSX, an inline map is
 * fine. See ./README.md.
 */
export function useVariantValue<T>(byVariant: Record<UiVariant, T>): T {
  return selectByVariant(useTheme().variant, byVariant);
}
