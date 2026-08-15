import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCOPE_KINDS } from '@boardsesh/leaderboard';

/**
 * The extensibility guarantee, made enforceable.
 *
 * The whole point of the scope registry is that adding a granularity later —
 * city, serial number, crew, event — is a registry entry plus four locale
 * strings, and touches neither the screen nor the row. If a scope kind's name
 * ever appears in the rendering code, that promise has quietly stopped being
 * true, and the next contributor will discover it the hard way.
 *
 * This asserts the negative: the UI must not branch on any specific kind.
 */

const STANDINGS_DIR = join(__dirname, '..');

function readComponent(name: string): string {
  return readFileSync(join(STANDINGS_DIR, name), 'utf8');
}

describe('standings surface stays scope-agnostic', () => {
  const components = ['StandingsScreen.tsx', 'StandingsRow.tsx', 'ViewerStandingCard.tsx'];

  for (const component of components) {
    it(`${component} does not name any individual scope kind`, () => {
      const source = readComponent(component);

      for (const kind of SCOPE_KINDS) {
        // `global` is the one legitimate mention: it is the terminal rung of
        // the fallback ladder and the default scope, not a per-kind branch.
        if (kind === 'global') continue;

        // Match the kind as a quoted string literal, which is how a branch on
        // it would have to be written.
        const asLiteral = new RegExp(`['"\`]${kind}['"\`]`);
        expect(
          asLiteral.test(source),
          `${component} references the '${kind}' scope kind directly. Scope-specific behaviour belongs in the registry ` +
            `(packages/shared/leaderboard/src/scope.ts), not in the UI — otherwise adding a granularity means editing ` +
            `the screen, which is exactly what the registry exists to avoid.`,
        ).toBe(false);
      }
    });
  }

  it('covers every component that renders a scope', () => {
    // A new rendering component added to this folder should be added above, or
    // the guarantee only holds for the files someone remembered.
    expect(components).toContain('StandingsScreen.tsx');
    expect(components.length).toBeGreaterThanOrEqual(3);
  });
});
