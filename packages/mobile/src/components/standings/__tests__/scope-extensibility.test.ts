import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCOPE_KINDS } from '@boardsesh/leaderboard';

/**
 * The extensibility guarantee, made enforceable — and stated precisely.
 *
 * The point of the scope registry is that adding a granularity later (city,
 * serial number, crew, event) does not ripple through the UI. What that means
 * exactly, so nobody over-claims it:
 *
 * - **Rendering is scope-agnostic, and this test enforces it.** No `.tsx` in
 *   this folder may branch on a specific kind. If one ever does, the promise
 *   has quietly stopped being true and the next contributor finds out the hard
 *   way.
 * - **Two `.ts` files do know kinds exist, unavoidably**, and are deliberately
 *   excluded: `scope-labels.ts` (the i18n linter hard-fails on a dynamic `t()`,
 *   so the keys need keep-markers) and `use-scope-options.ts` (building a key
 *   is inherently kind-specific — a board uuid is not a layout composite).
 *
 * So the real cost of a new granularity is: one registry entry, four locale
 * strings, one keep-marker, and one enumeration branch. Nothing in the
 * rendering path. That is the claim this file defends.
 */

const STANDINGS_DIR = join(__dirname, '..');

function readComponent(name: string): string {
  return readFileSync(join(STANDINGS_DIR, name), 'utf8');
}

describe('standings surface stays scope-agnostic', () => {
  const components = ['StandingsScreen.tsx', 'StandingsRow.tsx', 'ViewerStandingCard.tsx', 'StandingsEntryCard.tsx'];

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

  it('covers every rendering component in the folder, so the guard cannot go stale', () => {
    // Enumerating by hand would silently miss the next component someone adds,
    // and a guard with a hole in it is worse than no guard. Read the folder
    // instead and assert the list is complete.
    const rendered = readdirSync(STANDINGS_DIR)
      .filter((file) => file.endsWith('.tsx'))
      .sort();
    expect(
      [...components].sort(),
      'A .tsx component was added to src/components/standings/ without being added to the scope-agnostic check above.',
    ).toEqual(rendered);
  });
});
