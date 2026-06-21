import type { UiVariant } from '../resolve-ui-variant';

/**
 * Pick a value by the resolved UI variant from an exhaustive map.
 *
 * The map is typed `Record<UiVariant, T>`, so adding a third variant becomes a
 * compile error at every call site until each one supplies a value —
 * exhaustiveness by construction. This is the declarative replacement for
 * `variant === 'material' ? a : b` ternaries in component render bodies.
 *
 * Reach for this only for a genuinely LOCAL, positional one-off. If the value
 * has a stable, designer-facing name (an action-icon colour policy, a chart
 * palette, a caption style) it belongs in a token resolved by the provider and
 * read as `theme.X` — not here. See ./README.md for the decision tree.
 *
 * Performance: when `T` is an object handed to a `React.memo` child or used as a
 * `useMemo`/gesture dependency, define the per-variant map as a module-scope
 * `const` and pass it in — never an inline object literal built per render
 * (that defeats memoisation, the same hazard `jsx-no-constructed-context-values`
 * guards one level up).
 */
export function selectByVariant<T>(variant: UiVariant, byVariant: Record<UiVariant, T>): T {
  return byVariant[variant];
}
