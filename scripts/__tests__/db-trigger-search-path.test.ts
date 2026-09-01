/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DRIZZLE_DIR, JOURNAL_PATH, parseJournal } from '../lib/drizzle-migrations';

/**
 * Every plpgsql trigger function created by `packages/db/drizzle` must end up
 * with a pinned `search_path`.
 *
 * `pg_restore` issues `set_config('search_path', '', false)` before it does
 * anything, deliberately, so an unqualified `geography`, `social_entity_type`,
 * `sync_deletions` or `nextval('..._seq')` in a trigger body is unresolvable
 * while that trigger fires during `COPY`. That is #4699: a `--data-only`
 * restore into an already-loaded schema aborted on the first spatial table with
 * zero rows loaded, and only ran at all with `--disable-triggers` — which needs
 * a superuser.
 *
 * The check is textual on purpose. The CI job that runs it (`db-migrations`)
 * has a stock `postgres:17` service with no PostGIS and never executes the
 * migration SQL, so it cannot ask a catalog. The catalog-level counterparts run
 * elsewhere: `scripts/dev-db-image-smoke.sh` asserts `pg_proc.proconfig` against
 * the fully-migrated dev-db image in the `test-dev-db` job, and
 * `packages/db/src/__tests__/location-trigger.integration.test.ts` does the same
 * opt-in against a local dev DB.
 *
 * When this fails, add one line to a NEW migration:
 *
 *   ALTER FUNCTION <name>() SET search_path = public, pg_catalog;
 *
 * Never edit an applied migration — the ledger holds the hash of the file as it
 * ran (`docs/db-migrations.md`, "The recorded baseline").
 */

/**
 * `CREATE [OR REPLACE] FUNCTION name() RETURNS TRIGGER … AS $tag$`. The
 * dollar-quote tag is matched as `$…$` rather than a bare `$$` so a body opened
 * with `$function$` (which pg_dump emits, and which a future migration may be
 * pasted from) is still seen.
 */
const TRIGGER_FUNCTION_RE =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(\s*\)([\s\S]{0,400}?)\bAS\s+\$[A-Za-z_][A-Za-z0-9_]*\$|\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(\s*\)([\s\S]{0,400}?)\bAS\s+\$\$/gi;
const PIN_RE = /\bALTER\s+FUNCTION\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\([^)]*\)\s+SET\s+search_path\s*=/gi;
const UNPIN_RE =
  /\bALTER\s+FUNCTION\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\([^)]*\)\s+(?:RESET\s+search_path|SET\s+search_path\s+TO\s+DEFAULT)/gi;
const DROP_RE = /\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;

/**
 * Drop whole-line SQL comments before matching. The migrations quote their own
 * `ALTER FUNCTION` / `CREATE FUNCTION` statements inside explanatory comment
 * blocks, and a prose mention must not read as a pin. Trailing comments
 * (`;--> statement-breakpoint`) are left alone — nothing matches across them.
 */
function stripFullLineComments(body: string): string {
  return body
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
}

/**
 * Walk the journal IN ORDER and fold every migration's effect on each trigger
 * function into a final pinned/unpinned verdict. Journal order is what actually
 * runs (`docs/db-migrations.md`: order comes from `when`, and a `.sql` with no
 * journal entry is inert), so a `readdir` sweep would be the wrong sequence and
 * would also count orphans.
 */
function collectTriggerFunctions(): Map<string, boolean> {
  const journal = parseJournal(readFileSync(JOURNAL_PATH, 'utf8'));
  const pinned = new Map<string, boolean>();

  for (const entry of journal.entries) {
    const body = stripFullLineComments(readFileSync(`${DRIZZLE_DIR}/${entry.tag}.sql`, 'utf8'));

    for (const match of body.matchAll(TRIGGER_FUNCTION_RE)) {
      const name = match[1] ?? match[3];
      const header = match[2] ?? match[4] ?? '';
      if (name === undefined || !/\bRETURNS\s+TRIGGER\b/i.test(header)) continue;
      // A later CREATE OR REPLACE without the clause DROPS the pin — exactly the
      // regression 0130 would have caused over 0127 had 0127 shipped pinned.
      pinned.set(name, /\bSET\s+search_path\s*=/i.test(header));
    }
    for (const match of body.matchAll(PIN_RE)) {
      const name = match[1];
      if (name !== undefined && pinned.has(name)) pinned.set(name, true);
    }
    for (const match of body.matchAll(UNPIN_RE)) {
      const name = match[1];
      if (name !== undefined && pinned.has(name)) pinned.set(name, false);
    }
    for (const match of body.matchAll(DROP_RE)) {
      const name = match[1];
      if (name !== undefined) pinned.delete(name);
    }
  }

  return pinned;
}

describe('trigger functions pin search_path', () => {
  it('finds the trigger functions at all', () => {
    // Fail closed: an empty or shrunken inventory means the regex or the paths
    // broke, not that the repo stopped using triggers. Same discipline as the
    // empty-inventory guard in scripts/postgres18-spatial-surface.test.sh.
    expect(collectTriggerFunctions().size).toBeGreaterThanOrEqual(14);
  });

  it('leaves no trigger function with an unpinned search_path', () => {
    const unpinned = [...collectTriggerFunctions()]
      .filter(([, isPinned]) => !isPinned)
      .map(([name]) => name)
      .sort();
    expect(unpinned).toEqual([]);
  });

  it('pins the two that fire on INSERT and so run during COPY', () => {
    // set_location_from_coordinates fails at the assignment (`geography`);
    // update_vote_counts fails earlier still, at plpgsql compilation of
    // `DECLARE v_entity_type social_entity_type`, so its skip guard cannot
    // rescue it. Both abort a --data-only restore.
    const pinned = collectTriggerFunctions();
    expect(pinned.get('set_location_from_coordinates')).toBe(true);
    expect(pinned.get('update_vote_counts')).toBe(true);
  });
});
