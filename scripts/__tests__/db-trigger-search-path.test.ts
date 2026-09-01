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
 * elsewhere: `scripts/dev-db-image-smoke.sh` asserts `pg_proc.proconfig`
 * against the fully-migrated dev-db image in the `test-dev-db` job (the only
 * other guard that runs in CI), and
 * `packages/db/src/__tests__/location-trigger.integration.test.ts` does the
 * same against a local dev DB, opt-in on `LOCATION_TRIGGER_DB_URL` — which no
 * workflow sets, so that one is a developer-machine check only.
 *
 * When this fails, add one line to a NEW migration:
 *
 *   ALTER FUNCTION <name>() SET search_path = public, pg_catalog;
 *
 * Never edit an applied migration — the ledger holds the hash of the file as it
 * ran (`docs/db-migrations.md`, "The recorded baseline").
 */

/**
 * Split SQL into top-level statements, with every comment removed and every
 * string literal and dollar-quoted body emptied.
 *
 * This is a small lexer rather than a set of regexes over raw text, and both
 * halves of that matter:
 *
 *   - **Emptying bodies and literals** is what stops a `DROP FUNCTION` written
 *     inside a `$$ … $$` body or an `EXECUTE '…'` string from deleting a real
 *     inventory entry, and stops a `;` inside a body from splitting a
 *     statement.
 *   - **Removing comments** — trailing ones too, not just whole-line ones — is
 *     what stops a `;` in `CREATE FUNCTION f() -- see #1234; fires on insert`
 *     from truncating the header and making the function invisible, and stops
 *     a migration's own prose description of an `ALTER FUNCTION` from reading
 *     as a real pin.
 *
 * A body is replaced by its own delimiter twice (`$$` → `$$$$`) so the header
 * still ends in the `AS $tag$` the matcher looks for, while carrying no
 * content.
 */
export function topLevelStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;

  while (index < sql.length) {
    // Line comment: drop it, keeping one space so tokens cannot fuse.
    if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index);
      index = newline === -1 ? sql.length : newline;
      current += ' ';
      continue;
    }
    // Block comment. PostgreSQL nests these, so count depth.
    if (sql.startsWith('/*', index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith('/*', index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      current += ' ';
      continue;
    }
    // Single-quoted literal -> empty literal. Doubled '' is an escaped quote.
    // Emitting `''` keeps a legacy `AS '…'` function body recognisable.
    if (sql[index] === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      current += "''";
      continue;
    }
    // Dollar-quoted body -> the delimiter twice, contents dropped.
    const dollarQuote = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
    if (dollarQuote) {
      const delimiter = dollarQuote[0];
      const close = sql.indexOf(delimiter, index + delimiter.length);
      index = close === -1 ? sql.length : close + delimiter.length;
      current += delimiter + delimiter;
      continue;
    }
    // Quoted identifier: kept verbatim, it can name a function.
    if (sql[index] === '"') {
      const close = sql.indexOf('"', index + 1);
      const end = close === -1 ? sql.length : close + 1;
      current += sql.slice(index, end);
      index = end;
      continue;
    }
    if (sql[index] === ';') {
      statements.push(current);
      current = '';
      index += 1;
      continue;
    }
    current += sql[index];
    index += 1;
  }
  statements.push(current);

  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

/**
 * A zero-argument `CREATE [OR REPLACE] FUNCTION`, anchored to the start of its
 * statement. The body delimiter is `$…$` (so `$function$`, which pg_dump emits,
 * is seen as well as `$$`) or `''` (the legacy quoted-body form). The header
 * span between the name and `AS` has no length cap: it cannot escape the
 * statement, because the statement was already split on a real top-level `;`.
 */
const CREATE_FUNCTION_RE =
  /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(\s*\)([\s\S]*?)\bAS\s+(?:\$[A-Za-z0-9_]*\$|'')/i;
const PIN_RE =
  /^ALTER\s+FUNCTION\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(\s*\)\s+SET\s+search_path\s*(?:=|TO)\s*public\s*,\s*pg_catalog\s*$/i;
const ALTER_SEARCH_PATH_RE = /^ALTER\s+FUNCTION\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(\s*\)\s+SET\s+search_path\b/i;
const UNPIN_RE =
  /^ALTER\s+FUNCTION\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(\s*\)\s+(?:RESET\s+search_path|SET\s+search_path\s+TO\s+DEFAULT)/i;
const DROP_FUNCTION_RE = /^DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([\s\S]*)$/i;
/** Only zero-argument targets, so a parameter type can never be read as a name. */
const DROP_TARGET_RE = /(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(\s*\)/gi;
const BARE_DROP_TARGET_RE = /^\s*(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*$/i;

/** Legal boundaries after a CREATE FUNCTION configuration value. */
const CREATE_FUNCTION_ATTRIBUTE =
  '(?:AS|LANGUAGE|TRANSFORM|WINDOW|IMMUTABLE|STABLE|VOLATILE|LEAKPROOF|NOT|CALLED|RETURNS|STRICT|EXTERNAL|SECURITY|PARALLEL|COST|ROWS|SUPPORT|SET)';
/**
 * PostgreSQL accepts repeated SET clauses and applies the last one. Function
 * attributes can also appear on either side of the AS body, so capture every
 * search_path value from the body-sanitized statement in source order. FROM
 * CURRENT is captured as undefined and therefore unsafe.
 */
const CREATE_FUNCTION_SEARCH_PATH_RE = new RegExp(
  `\\bSET\\s+search_path\\s*(?:(?:=|TO)\\s*([\\s\\S]*?)|FROM\\s+CURRENT)(?=\\s*(?:$|\\b${CREATE_FUNCTION_ATTRIBUTE}\\b))`,
  'gi',
);

function createFunctionPinsPrescribedSearchPath(statement: string): boolean {
  let effectiveSearchPath: string | undefined;
  for (const match of statement.matchAll(CREATE_FUNCTION_SEARCH_PATH_RE)) {
    effectiveSearchPath = match[1];
  }
  return effectiveSearchPath?.replace(/\s+/g, '').toLowerCase() === 'public,pg_catalog';
}

/**
 * Fold migration sources, in order, into a final pinned/unpinned verdict per
 * trigger function.
 *
 * Statements are applied **in source order**, not as separate per-kind passes.
 * A pass-per-kind fold gets drop-then-recreate backwards: it applies every
 * `DROP` after every `CREATE`, so a migration that drops a function and
 * immediately recreates it — the standard way to change one when
 * `CREATE OR REPLACE` will not do, and how 0195 already rewrites a trigger —
 * ends with the function missing from the inventory entirely. The recreated,
 * unpinned function then reads as green.
 */
export function foldMigrationSources(sources: Iterable<string>): Map<string, boolean> {
  const pinned = new Map<string, boolean>();

  for (const source of sources) {
    for (const statement of topLevelStatements(source)) {
      const created = CREATE_FUNCTION_RE.exec(statement);
      if (created !== null) {
        const name = created[1];
        const header = created[2] ?? '';
        // A later CREATE OR REPLACE without the clause DROPS the pin — exactly
        // the regression 0130 would have caused over 0127 had 0127 shipped
        // pinned.
        if (name !== undefined && /\bRETURNS\s+TRIGGER\b/i.test(header)) {
          pinned.set(name, createFunctionPinsPrescribedSearchPath(statement));
        }
        continue;
      }

      const unpinnedBy = UNPIN_RE.exec(statement);
      if (unpinnedBy !== null) {
        const name = unpinnedBy[1];
        if (name !== undefined && pinned.has(name)) pinned.set(name, false);
        continue;
      }

      const pinnedBy = PIN_RE.exec(statement);
      if (pinnedBy !== null) {
        const name = pinnedBy[1];
        if (name !== undefined && pinned.has(name)) pinned.set(name, true);
        continue;
      }

      const wronglyPinnedBy = ALTER_SEARCH_PATH_RE.exec(statement);
      if (wronglyPinnedBy !== null) {
        const name = wronglyPinnedBy[1];
        if (name !== undefined && pinned.has(name)) pinned.set(name, false);
        continue;
      }

      const dropped = DROP_FUNCTION_RE.exec(statement);
      if (dropped !== null) {
        const targets = dropped[1] ?? '';
        let matchedAny = false;
        for (const target of targets.matchAll(DROP_TARGET_RE)) {
          const name = target[1];
          if (name !== undefined) {
            pinned.delete(name);
            matchedAny = true;
          }
        }
        if (!matchedAny) {
          // `DROP FUNCTION name` with no argument list is legal when the name
          // is unambiguous.
          for (const target of targets.split(',')) {
            const name = BARE_DROP_TARGET_RE.exec(target)?.[1];
            if (name !== undefined) pinned.delete(name);
          }
        }
      }
    }
  }

  return pinned;
}

/**
 * Read the migrations IN JOURNAL ORDER. Journal order is what actually runs
 * (`docs/db-migrations.md`: order comes from `when`, and a `.sql` with no
 * journal entry is inert), so a `readdir` sweep would be the wrong sequence and
 * would also count orphans.
 */
function migrationSources(): string[] {
  const journal = parseJournal(readFileSync(JOURNAL_PATH, 'utf8'));
  return journal.entries.map((entry) => readFileSync(`${DRIZZLE_DIR}/${entry.tag}.sql`, 'utf8'));
}

function collectTriggerFunctions(): Map<string, boolean> {
  return foldMigrationSources(migrationSources());
}

function unpinnedIn(pinned: Map<string, boolean>): string[] {
  return [...pinned]
    .filter(([, isPinned]) => !isPinned)
    .map(([name]) => name)
    .sort();
}

describe('trigger functions pin search_path', () => {
  it('finds the trigger functions at all', () => {
    // Fail closed: an empty or shrunken inventory means the lexer or the paths
    // broke, not that the repo stopped using triggers. Same discipline as the
    // empty-inventory guard in scripts/postgres18-spatial-surface.test.sh.
    //
    // 14 is a floor, not a count, and it does not need bumping when a migration
    // adds a trigger function — the inventory only grows, and the assertion
    // below is what catches a new one that forgot its pin. It exists solely so
    // a broken matcher cannot report success on an empty set. If a migration
    // ever legitimately retires a trigger function, lower it deliberately.
    expect(collectTriggerFunctions().size).toBeGreaterThanOrEqual(14);
  });

  it('leaves no trigger function with an unpinned search_path', () => {
    expect(unpinnedIn(collectTriggerFunctions())).toEqual([]);
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

describe('the pin requires public then pg_catalog, and nothing else', () => {
  const mutateExistingPin = (clause: string) =>
    foldMigrationSources([...migrationSources(), `ALTER FUNCTION set_updated_at() ${clause};`]);
  const createTriggerWithAttributes = (beforeBody: string[], afterBody: string[]) =>
    [
      'CREATE FUNCTION inline_pin_fn() RETURNS TRIGGER',
      ...beforeBody,
      'AS $$ BEGIN RETURN NEW; END; $$',
      ...afterBody,
      'LANGUAGE plpgsql;',
    ].join('\n');
  const createTriggerWithPins = (...clauses: string[]) => createTriggerWithAttributes(clauses, []);

  it.each([
    ['an empty path', "SET search_path = ''"],
    ['public missing', 'SET search_path = pg_catalog'],
    ['pg_catalog missing', 'SET search_path = public'],
    ['the schemas reversed', 'SET search_path = pg_catalog, public'],
    ['an extra schema', 'SET search_path = public, pg_catalog, extensions'],
    ['an unrelated schema', 'SET search_path = private, pg_catalog'],
  ])('rejects %s', (_description, clause) => {
    expect(unpinnedIn(mutateExistingPin(clause))).toContain('set_updated_at');
  });

  it.each([
    'SET search_path = public, pg_catalog',
    'SET search_path TO public , pg_catalog',
    'SET   search_path=public,pg_catalog',
  ])('accepts canonical syntax: %s', (clause) => {
    expect(unpinnedIn(mutateExistingPin(clause))).not.toContain('set_updated_at');
  });

  it('rejects a CREATE FUNCTION whose path omits public', () => {
    const migration = createTriggerWithPins('SET search_path = pg_catalog');
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toContain('inline_pin_fn');
  });

  it.each([
    ['an extra schema', 'SET search_path = public, pg_catalog, extensions'],
    ['reversed schemas', 'SET search_path = pg_catalog, public'],
    ['the current session path', 'SET search_path FROM CURRENT'],
  ])('rejects canonical then %s because the last CREATE clause wins', (_description, override) => {
    const migration = createTriggerWithPins('SET search_path = public, pg_catalog', override);
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toContain('inline_pin_fn');
  });

  it('accepts wrong then canonical because the last CREATE clause wins', () => {
    const migration = createTriggerWithPins(
      'SET search_path = public, pg_catalog, extensions',
      'SET search_path TO public , pg_catalog',
    );
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).not.toContain('inline_pin_fn');
  });

  it.each([
    ['an extra schema', 'SET search_path = public, pg_catalog, extensions'],
    ['the current session path', 'SET search_path FROM CURRENT'],
  ])('rejects canonical before AS then %s after AS', (_description, override) => {
    const migration = createTriggerWithAttributes(['SET search_path = public, pg_catalog'], [override]);
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toContain('inline_pin_fn');
  });

  it.each([
    [
      'wrong before AS then canonical after AS',
      ['SET search_path = public, pg_catalog, extensions'],
      ['SET search_path TO public , pg_catalog'],
    ],
    ['canonical only after AS', [], ['SET search_path = public, pg_catalog']],
  ])('accepts %s', (_description, beforeBody, afterBody) => {
    const migration = createTriggerWithAttributes(beforeBody, afterBody);
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).not.toContain('inline_pin_fn');
  });
});

/**
 * The shapes a future migration can take that a naive text scan gets wrong.
 * Each of these was a real fail-open in an earlier draft of this guard: the
 * function silently left the inventory, so "no unpinned trigger functions"
 * passed while an unpinned one was live in the database.
 */
describe('the inventory survives the shapes that used to defeat it', () => {
  const unpinnedTriggerFunction = (header: string) => `${header}\nBEGIN RETURN NEW; END;\n$$ LANGUAGE plpgsql;`;

  it('sees a function recreated after a DROP in the same migration', () => {
    const migration = [
      'DROP FUNCTION IF EXISTS log_deletion_ticks();',
      '--> statement-breakpoint',
      unpinnedTriggerFunction('CREATE FUNCTION log_deletion_ticks() RETURNS TRIGGER AS $$'),
    ].join('\n');
    const pinned = foldMigrationSources([...migrationSources(), migration]);
    expect(pinned.has('log_deletion_ticks')).toBe(true);
    expect(unpinnedIn(pinned)).toEqual(['log_deletion_ticks']);
  });

  it('ignores a DROP FUNCTION written inside a function body', () => {
    const migration = [
      'CREATE FUNCTION reaper() RETURNS TRIGGER AS $$',
      "BEGIN EXECUTE 'DROP FUNCTION log_deletion_ticks()'; RETURN NEW; END;",
      '$$ LANGUAGE plpgsql;',
    ].join('\n');
    const pinned = foldMigrationSources([...migrationSources(), migration]);
    expect(pinned.has('log_deletion_ticks')).toBe(true);
    expect(unpinnedIn(pinned)).toEqual(['reaper']);
  });

  it('sees a function whose header carries a trailing comment containing a semicolon', () => {
    const migration = unpinnedTriggerFunction(
      'CREATE OR REPLACE FUNCTION new_trigger_fn() -- see #1234; fires on insert\nRETURNS TRIGGER AS $$',
    );
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toEqual(['new_trigger_fn']);
  });

  it('sees a legacy quoted-body definition', () => {
    const migration = "CREATE FUNCTION quoted_body_fn() RETURNS TRIGGER AS 'BEGIN RETURN NEW; END;' LANGUAGE plpgsql;";
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toEqual(['quoted_body_fn']);
  });

  it('sees a $function$-tagged body', () => {
    const migration = [
      'CREATE OR REPLACE FUNCTION public.tagged_body_fn() RETURNS trigger',
      '    LANGUAGE plpgsql',
      '    AS $function$',
      'BEGIN RETURN NEW; END;',
      '$function$;',
    ].join('\n');
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toEqual(['tagged_body_fn']);
  });

  it('does not read a migration comment describing an ALTER as a real pin', () => {
    const migration = [
      unpinnedTriggerFunction('CREATE FUNCTION commented_fn() RETURNS TRIGGER AS $$'),
      '-- Follow-up: ALTER FUNCTION commented_fn() SET search_path = public, pg_catalog;',
    ].join('\n');
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toEqual(['commented_fn']);
  });

  it('drops a function that a later migration really does remove', () => {
    const created = unpinnedTriggerFunction('CREATE FUNCTION doomed_fn() RETURNS TRIGGER AS $$');
    const pinned = foldMigrationSources([...migrationSources(), created, 'DROP FUNCTION doomed_fn();']);
    expect(pinned.has('doomed_fn')).toBe(false);
    expect(unpinnedIn(pinned)).toEqual([]);
  });
});
