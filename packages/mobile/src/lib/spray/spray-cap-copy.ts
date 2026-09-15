import { MAX_HOLDS_PER_WALL, MAX_SPRAY_WALLS_PER_USER, MAX_VERSIONS_PER_WALL } from '@boardsesh/board-config';

/**
 * The caps, as copy, at the three points they bite.
 *
 * A cap a climber only meets as "Something went wrong" is indistinguishable from
 * a bug, and the three spray caps are all reachable by ordinary use: ten walls is
 * a gym with a lot of bays, 1,500 holds is a dense commercial spray wall, fifty
 * resets is four years of monthly changes. So each one is said out loud with its
 * number, BEFORE it bites where there is a sensible place to say it (the wall
 * count on the create step) and at the moment it bites everywhere else.
 *
 * The numbers are read from `@boardsesh/board-config`, never typed into a
 * catalog string: the server enforces those same constants, and a copy string
 * carrying a stale number would be telling a climber the rule is something other
 * than what refused them.
 */

/** `extensions.code` values the spray API refuses a cap with (SW-05). */
export const SPRAY_CAP_CODES = {
  walls: 'SPRAY_WALL_LIMIT_REACHED',
  holds: 'SPRAY_WALL_HOLD_LIMIT_REACHED',
  versions: 'SPRAY_WALL_VERSION_LIMIT_REACHED',
} as const;

export type SprayCapKind = keyof typeof SPRAY_CAP_CODES;

/** The cap's value, by kind. One lookup, so no call site re-picks a constant. */
export const SPRAY_CAP_VALUES = {
  walls: MAX_SPRAY_WALLS_PER_USER,
  holds: MAX_HOLDS_PER_WALL,
  versions: MAX_VERSIONS_PER_WALL,
} as const satisfies Record<SprayCapKind, number>;

/**
 * Whatever renders an i18n key. Taken as a parameter so this module stays pure
 * TypeScript — the caps and their copy are one idea, and it should not need a
 * React context to answer a question about a number.
 */
export type SprayCapTranslator = (key: string, values: { max: number }) => string;

/**
 * The message for one cap, rendered.
 *
 * A switch with three literal keys rather than a computed
 * `t(`sprayCaps.${kind}`)`: `check:i18n:orphans` walks every `t()` call and a
 * non-static argument is a hard failure, because a key nobody can find
 * statically is a key nobody can safely delete. Three lines is the whole cost.
 */
export function sprayCapMessage(kind: SprayCapKind, t: SprayCapTranslator): string {
  switch (kind) {
    case 'walls':
      return t('sprayCaps.walls', { max: MAX_SPRAY_WALLS_PER_USER });
    case 'holds':
      return t('sprayCaps.holds', { max: MAX_HOLDS_PER_WALL });
    case 'versions':
      return t('sprayCaps.versions', { max: MAX_VERSIONS_PER_WALL });
  }
}

/**
 * The cap a refusal is about, or null when the refusal is something else.
 *
 * Matched on `extensions.code`, never on the message text: the server's prose is
 * not a contract and is not translated, and a client that string-matches it
 * silently stops recognising the cap the first time somebody rewords an error.
 */
export function sprayCapFromErrorCode(code: string | null | undefined): SprayCapKind | null {
  if (!code) return null;
  const entry = (Object.entries(SPRAY_CAP_CODES) as [SprayCapKind, string][]).find(([, value]) => value === code);
  return entry?.[0] ?? null;
}
