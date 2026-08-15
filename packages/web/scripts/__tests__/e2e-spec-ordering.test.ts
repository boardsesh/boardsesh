// @vitest-environment node

/**
 * Guards against re-pinning an e2e spec by filename.
 *
 * `aa-embed-headers.spec.ts` carried an alphabetical prefix for weeks because
 * Playwright orders spec files alphabetically inside a shard and those raw
 * HTTP checks hung when browser specs ran first (#4463). The prefix hid the
 * defect instead of testing it, and it only ever protected one particular
 * `--shard=N/8` arrangement — adding or removing a single test elsewhere
 * reshuffles the whole split and quietly retires the protection.
 *
 * A rename is the cheapest possible "fix" for the next ordering flake, and it
 * leaves nothing behind that explains itself. This makes that rename fail
 * loudly and points at the issue that recorded the actual mechanism.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

const E2E_DIR = join(import.meta.dirname, '..', '..', 'e2e');

/**
 * The three cheap ways to buy a sort position, all of which work and all of
 * which a reviewer reads as a typo rather than as a workaround. Real spec
 * names start with a whole lowercase word, so none of these costs a false
 * positive.
 *
 * This catches sorting hacks that *look* like hacks. It cannot catch a plain
 * word that happens to sort first (`aardvark-embed.spec.ts`) — nothing short
 * of a committed order manifest could, and that would make every added spec a
 * two-file change. The point is that the obvious rename now fails loudly and
 * says why.
 */
const ORDERING_PREFIXES: readonly RegExp[] = [
  /^[^a-z]/, // a leading digit or `_` sorts before every letter
  /^[a-z][-_]/, // `a-`, `z_` — one letter plus a separator sorts ahead of any real name
  /^([a-z])\1+[-_]/, // `aa-`, `zzz_` — the original pin
];

function e2eSpecBasenames(): string[] {
  return readdirSync(E2E_DIR).filter((entry) => entry.endsWith('.spec.ts'));
}

describe('e2e spec filenames carry no alphabetical ordering pin', () => {
  it('has no spec whose name buys a sort position', () => {
    const pinned = e2eSpecBasenames().filter((basename) => ORDERING_PREFIXES.some((pattern) => pattern.test(basename)));

    expect(
      pinned,
      'An e2e spec is pinned by filename so it sorts first (or last) inside its shard. ' +
        'That is the workaround #4463 removed: it hides an ordering-dependent failure ' +
        'instead of testing it, and it silently stops working the next time a test is ' +
        'added anywhere in the suite. Drive the ordering explicitly inside the spec ' +
        '(see the describe.serial block in e2e/embed-headers.spec.ts) instead.',
    ).toEqual([]);
  });

  it('still has the embed-header spec under its un-pinned name', () => {
    // If this file is renamed back, the check above would pass vacuously.
    expect(e2eSpecBasenames()).toContain('embed-headers.spec.ts');
  });
});
