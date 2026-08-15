/**
 * Standings scopes — the extensibility spine.
 *
 * A scope is `{ kind, key }`. Everything that varies between "everyone",
 * "Kilter Board Original" and "my garage wall" lives in a registry entry;
 * nothing about a specific kind may leak into the screen that renders them.
 * The acceptance test for that is enforced (see `__tests__/scope.test.ts`):
 * adding a kind must not require touching the mobile route.
 *
 * The scopes deliberately differ in how well the data supports them. Measured
 * against production 2026-08-14, 30-day window, sends only, excluding the
 * frozen `json_import` corpus:
 *
 * | kind         | attribution coverage | scopes alive       |
 * |--------------|----------------------|--------------------|
 * | global       | 100%                 | 1 (1,203 climbers) |
 * | boardType    | 100%                 | 3 of 7 registered  |
 * | layout       | 99.99%               | 12 of 16           |
 * | board        | 86.8% (30d), 3% >90d | 808 active, max 17 |
 * | gym          | 46.9%                | 590 active, max 17 |
 *
 * `coverage` is carried on the entry so a surface can tell the reader why a
 * number looks low ("sends synced from the Kilter app don't carry a wall")
 * instead of silently under-reporting.
 */

export type ScopeKind = 'global' | 'boardType' | 'layout' | 'board' | 'gym';

export type Scope = {
  kind: ScopeKind;
  /** Empty for `global`. Opaque to the UI — only the registry entry parses it. */
  key: string;
};

/**
 * Board types worth registering. Deliberately an allowlist rather than every
 * distinct `board_type` in the table: decoy (6 climbers in 30 days), touchstone
 * (2) and grasshopper (1) would each render a permanently dead tab.
 */
export const RANKED_BOARD_TYPES = ['kilter', 'tension', 'moonboard'] as const;
export type RankedBoardType = (typeof RANKED_BOARD_TYPES)[number];

export function isRankedBoardType(value: string): value is RankedBoardType {
  return (RANKED_BOARD_TYPES as readonly string[]).includes(value);
}

export type ScopeKindDefinition = {
  kind: ScopeKind;
  /**
   * i18n key for the kind's own label ("Everyone", "Board", "Setup", "Wall").
   * A scope *instance* label (e.g. a board's name) comes from the server,
   * because only the server can resolve a key into a human name.
   */
  labelKey: string;
  /**
   * Fallback when a scope has no rows at all. Walked server-side; the response
   * reports which rung it landed on so the surface can say so rather than
   * silently showing a different leaderboard than the one that was asked for.
   * `null` terminates the ladder.
   */
  parentKind: ScopeKind | null;
  /**
   * Share of recent sends this kind can attribute at all, as measured above.
   * Drives the footer caveat. 1 means no attribution gap.
   */
  coverage: number;
  /** A scope of this kind needs a key; `global` does not. */
  requiresKey: boolean;
};

const DEFINITIONS: Record<ScopeKind, ScopeKindDefinition> = {
  global: {
    kind: 'global',
    labelKey: 'standings.scope.global',
    parentKind: null,
    coverage: 1,
    requiresKey: false,
  },
  boardType: {
    kind: 'boardType',
    labelKey: 'standings.scope.boardType',
    parentKind: 'global',
    coverage: 1,
    requiresKey: true,
  },
  layout: {
    kind: 'layout',
    labelKey: 'standings.scope.layout',
    parentKind: 'boardType',
    // Resolved by joining board_climbs on (climb_uuid, board_type); no
    // dependence on board_id, which is why this tier has no attribution gap.
    coverage: 0.9999,
    requiresKey: true,
  },
  board: {
    kind: 'board',
    labelKey: 'standings.scope.board',
    // Falls back to the *setup* rather than the board type: "every Kilter
    // Original at this angle" is far closer to what the climber was looking at
    // than "every Kilter anywhere".
    parentKind: 'layout',
    coverage: 0.868,
    requiresKey: true,
  },
  gym: {
    kind: 'gym',
    labelKey: 'standings.scope.gym',
    parentKind: 'layout',
    coverage: 0.469,
    requiresKey: true,
  },
};

export const SCOPE_KINDS: readonly ScopeKind[] = Object.keys(DEFINITIONS) as ScopeKind[];

export function scopeDefinition(kind: ScopeKind): ScopeKindDefinition {
  return DEFINITIONS[kind];
}

export const GLOBAL_SCOPE: Scope = { kind: 'global', key: '' };

/**
 * Layout keys are `boardType:layoutId`, so a layout scope carries its board
 * type with it and never has to be resolved against a second lookup.
 */
export function layoutScopeKey(boardType: string, layoutId: number): string {
  return `${boardType}:${layoutId}`;
}

export function parseLayoutScopeKey(key: string): { boardType: string; layoutId: number } | null {
  const separator = key.indexOf(':');
  if (separator <= 0) return null;
  const boardType = key.slice(0, separator);
  const layoutId = Number(key.slice(separator + 1));
  if (!boardType || !Number.isInteger(layoutId) || layoutId <= 0) return null;
  return { boardType, layoutId };
}

/**
 * The fallback ladder for a scope, nearest first, ending at global.
 *
 * A scope whose key cannot be resolved to a real entity still yields a usable
 * ladder — the point is that there is never a path to a screen with nothing on
 * it. Note this returns *kinds*; turning a parent kind into a concrete parent
 * scope needs the tick's own data (the board's layout, the gym's layout), which
 * only the server has.
 */
export function fallbackKinds(kind: ScopeKind): ScopeKind[] {
  const ladder: ScopeKind[] = [];
  let current = scopeDefinition(kind).parentKind;
  const guard = new Set<ScopeKind>([kind]);
  while (current && !guard.has(current)) {
    ladder.push(current);
    guard.add(current);
    current = scopeDefinition(current).parentKind;
  }
  return ladder;
}

export function isValidScope(scope: Scope): boolean {
  const definition = DEFINITIONS[scope.kind];
  if (!definition) return false;
  return definition.requiresKey ? scope.key.length > 0 : scope.key.length === 0;
}

/** Stable string form, for cache keys and React keys. */
export function scopeToId(scope: Scope): string {
  return scope.key ? `${scope.kind}:${scope.key}` : scope.kind;
}
