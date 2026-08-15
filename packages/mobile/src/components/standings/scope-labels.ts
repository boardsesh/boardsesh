import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ScopeKind } from '@boardsesh/leaderboard';

/**
 * The one mobile-side file that has to know scope kinds exist.
 *
 * It lives here rather than in the screen so that `StandingsScreen`,
 * `StandingsRow` and `ViewerStandingCard` stay genuinely scope-agnostic —
 * enforced by `__tests__/scope-extensibility.test.ts`.
 *
 * The lookup is a template literal rather than `t(definition.labelKey)` because
 * the i18n linter hard-fails on a `t(variable)` it cannot analyse statically
 * (CLAUDE.md). The keep-markers below cover the keys that template can resolve
 * to; `__tests__/scope-labels.test.ts` asserts the template still agrees with
 * every registry entry's declared `labelKey`, so the two cannot drift apart.
 *
 * Adding a granularity means: one registry entry, four locale strings, and one
 * keep-marker here. Nothing in the rendering path changes.
 */
// i18n-keep boards.standings.scope.global
// i18n-keep boards.standings.scope.boardType
// i18n-keep boards.standings.scope.layout
// i18n-keep boards.standings.scope.board
// i18n-keep boards.standings.scope.gym
export function scopeKindLabelKey(kind: ScopeKind): string {
  return `standings.scope.${kind}`;
}

export function useScopeKindLabel(): (kind: ScopeKind) => string {
  const { t } = useTranslation('boards');
  return useCallback((kind: ScopeKind) => t(`standings.scope.${kind}`), [t]);
}
