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
    // Single-quoted literal -> empty literal. Doubled '' is an escaped quote;
    // an E-prefixed escape string also lets a backslash escape the next byte.
    // Emitting `''` keeps a legacy `AS '…'` function body recognisable.
    if (sql[index] === "'") {
      const stringPrefix = sql[index - 1];
      const characterBeforePrefix = sql[index - 2];
      const isEscapeString =
        (stringPrefix === 'E' || stringPrefix === 'e') &&
        (characterBeforePrefix === undefined || !/[A-Za-z0-9_$\u0080-\uFFFF]/.test(characterBeforePrefix));
      index += 1;
      while (index < sql.length) {
        if (isEscapeString && sql[index] === '\\') {
          index += 2;
          continue;
        }
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
    // PostgreSQL permits non-ASCII identifier characters in a dollar tag.
    // Matching any non-whitespace, non-dollar tag is deliberately a little
    // broader than the server lexer: sanitising an invalid construct can only
    // make this guard reject more conservatively, while missing a valid tag
    // could split on a body semicolon and ignore a later function attribute.
    const dollarQuote = /^\$(?:[^$\s]+)?\$/.exec(sql.slice(index));
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
 * PostgreSQL identifiers fold to lower case only when unquoted. Keep schema
 * and function captures separate so `public.FOO` resolves to `public.foo`,
 * while `"public"."FOO"` remains a distinct function and `"PUBLIC".foo` never
 * aliases the public schema.
 */
const POSTGRES_IDENTIFIER = '(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))';
const FUNCTION_TARGET = `(?:${POSTGRES_IDENTIFIER}\\s*\\.\\s*)?${POSTGRES_IDENTIFIER}`;
const CREATE_FUNCTION_RE = new RegExp(
  `^CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${FUNCTION_TARGET}(?=\\s*\\()([\\s\\S]*)$`,
  'i',
);
const CREATE_FUNCTION_PREFIX_RE = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i;
const CANONICAL_ALTER_PIN_RE = new RegExp(
  `^ALTER\\s+(?:FUNCTION|ROUTINE)\\s+${FUNCTION_TARGET}\\s*(?:\\(\\s*\\))?\\s+SET\\s+${POSTGRES_IDENTIFIER}\\s*(?:=|TO)\\s*public\\s*,\\s*pg_catalog\\s*$`,
  'i',
);
const ALTER_FUNCTION_OR_ROUTINE_RE = new RegExp(`^ALTER\\s+(?:FUNCTION|ROUTINE)\\s+${FUNCTION_TARGET}(?=\\s|\\()`, 'i');
const ALTER_FUNCTION_OR_ROUTINE_PREFIX_RE = /^ALTER\s+(?:FUNCTION|ROUTINE)\b/i;
const DROP_FUNCTION_RE = /^DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([\s\S]*)$/i;
/** Only zero-argument targets, so a parameter type can never be read as a name. */
const DROP_TARGET_RE = new RegExp(`${FUNCTION_TARGET}\\s*\\(\\s*\\)`, 'gi');
const BARE_DROP_TARGET_RE = new RegExp(`^\\s*${FUNCTION_TARGET}\\s*$`, 'i');

function postgresIdentifier(quotedName: string | undefined, unquotedName: string | undefined): string | undefined {
  return quotedName ?? unquotedName?.toLowerCase();
}

/** Resolve only functions in public; quoted schema names remain case-sensitive. */
function publicFunctionName(match: RegExpExecArray | RegExpMatchArray, offset = 1): string | undefined {
  const quotedSchema = match[offset];
  const unquotedSchema = match[offset + 1];
  if (quotedSchema !== undefined && quotedSchema !== 'public') return undefined;
  if (unquotedSchema !== undefined && unquotedSchema.toLowerCase() !== 'public') return undefined;
  return postgresIdentifier(match[offset + 2], match[offset + 3]);
}

function configurationParameter(quotedName: string | undefined, unquotedName: string | undefined): string | undefined {
  return (quotedName ?? unquotedName)?.toLowerCase();
}

const RETURNS_TRIGGER_RE = /\bRETURNS\s+(?:(?:"pg_catalog"|pg_catalog)\s*\.\s*)?(?:"trigger"|trigger)(?=\s|$)/i;
const UNPARSED_CREATE_SENTINEL = '<unparsed CREATE FUNCTION>';
const UNPARSED_ALTER_SENTINEL = '<unparsed ALTER FUNCTION or ROUTINE>';

/** Legal boundaries after a CREATE FUNCTION configuration value. */
const CREATE_FUNCTION_ATTRIBUTE =
  '(?:AS|LANGUAGE|TRANSFORM|WINDOW|IMMUTABLE|STABLE|VOLATILE|LEAKPROOF|NOT|CALLED|RETURNS|STRICT|EXTERNAL|SECURITY|PARALLEL|COST|ROWS|SUPPORT|SET|RESET)';
/**
 * PostgreSQL accepts repeated SET clauses and applies the last one. Function
 * attributes can also appear on either side of the AS body, so capture every
 * search_path value from the body-sanitized statement in source order. FROM
 * CURRENT is captured as undefined and therefore unsafe.
 */
const CREATE_FUNCTION_SEARCH_PATH_RE = new RegExp(
  `\\bSET\\s+${POSTGRES_IDENTIFIER}\\s*(?:(?:=|TO)\\s*([\\s\\S]*?)|FROM\\s+CURRENT)(?=\\s*(?:$|\\b${CREATE_FUNCTION_ATTRIBUTE}\\b))`,
  'gi',
);
const CREATE_FUNCTION_UNSAFE_CONFIGURATION_RE =
  /\b(?:RESET\s+(?:ALL\b|"search_path"(?=\s|$)|search_path\b)|SET\s+SCHEMA\b|(?:SET|RESET)\s+U&")/i;

function createFunctionPinsPrescribedSearchPath(statement: string): boolean {
  if (CREATE_FUNCTION_UNSAFE_CONFIGURATION_RE.test(statement)) return false;

  let effectiveSearchPath: string | undefined;
  for (const match of statement.matchAll(CREATE_FUNCTION_SEARCH_PATH_RE)) {
    if (configurationParameter(match[1], match[2]) === 'search_path') {
      effectiveSearchPath = match[3];
    }
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
        const name = publicFunctionName(created);
        const definition = created[5] ?? '';
        // A later CREATE OR REPLACE without the clause DROPS the pin — exactly
        // the regression 0130 would have caused over 0127 had 0127 shipped
        // pinned. Once a public name is in the inventory, conservatively treat
        // any later definition of that name as the same function. This catches
        // valid alternate body strings and return-type spellings without
        // pretending this textual guard is a complete PostgreSQL parser.
        // A valid trigger-returning function necessarily has zero input
        // arguments. OUT-only declarations do not count toward PostgreSQL
        // identity, so requiring a literal empty `()` here would miss them.
        const createsTrigger = RETURNS_TRIGGER_RE.test(definition);
        if (name !== undefined && (pinned.has(name) || createsTrigger)) {
          pinned.set(name, createFunctionPinsPrescribedSearchPath(statement));
        }
        continue;
      }
      if (CREATE_FUNCTION_PREFIX_RE.test(statement)) {
        // Unicode-escaped identifiers and future grammar additions must not
        // silently evade the inventory. A synthetic unpinned entry turns any
        // unparsed CREATE into a visible contract failure.
        pinned.set(UNPARSED_CREATE_SENTINEL, false);
        continue;
      }

      const pinnedBy = CANONICAL_ALTER_PIN_RE.exec(statement);
      if (pinnedBy !== null) {
        const name = publicFunctionName(pinnedBy);
        const parameter = configurationParameter(pinnedBy[5], pinnedBy[6]);
        if (name !== undefined && parameter === 'search_path' && pinned.has(name)) pinned.set(name, true);
        continue;
      }

      // Only the exact single-action canonical pin above is trusted. PostgreSQL
      // has many signature and action spellings (including OUT-only arguments,
      // which do not change identity), so every other ALTER of an inventoried
      // public name folds to unsafe. The catalog-level guard supplies the final
      // semantic proof against conservative false positives here.
      const altered = ALTER_FUNCTION_OR_ROUTINE_RE.exec(statement);
      if (altered !== null) {
        const name = publicFunctionName(altered);
        if (name !== undefined && pinned.has(name)) pinned.set(name, false);
        continue;
      }
      if (ALTER_FUNCTION_OR_ROUTINE_PREFIX_RE.test(statement)) {
        // Do not enumerate every valid PostgreSQL identifier spelling. If the
        // bounded target parser cannot consume an ALTER, fail closed instead.
        pinned.set(UNPARSED_ALTER_SENTINEL, false);
        continue;
      }

      const dropped = DROP_FUNCTION_RE.exec(statement);
      if (dropped !== null) {
        const targets = dropped[1] ?? '';
        let matchedAny = false;
        for (const target of targets.matchAll(DROP_TARGET_RE)) {
          const name = publicFunctionName(target);
          if (name !== undefined) {
            pinned.delete(name);
            matchedAny = true;
          }
        }
        if (!matchedAny) {
          // `DROP FUNCTION name` with no argument list is legal when the name
          // is unambiguous.
          for (const target of targets.split(',')) {
            const bareTarget = BARE_DROP_TARGET_RE.exec(target);
            const name = bareTarget === null ? undefined : publicFunctionName(bareTarget);
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
  const mutateExistingFunction = (statement: string) => foldMigrationSources([...migrationSources(), `${statement};`]);
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

  it.each([
    ['FUNCTION RESET ALL', 'ALTER FUNCTION set_updated_at() RESET ALL'],
    ['ROUTINE RESET ALL', 'ALTER ROUTINE set_updated_at() RESET ALL'],
    ['ROUTINE RESET search_path', 'ALTER ROUTINE set_updated_at() RESET search_path'],
    ['ROUTINE SET TO DEFAULT', 'ALTER ROUTINE set_updated_at() SET search_path TO DEFAULT'],
    ['ROUTINE noncanonical path', 'ALTER ROUTINE set_updated_at() SET search_path = public, pg_catalog, extensions'],
    ['multi-action FUNCTION RESET ALL', 'ALTER FUNCTION set_updated_at() COST 1 RESET ALL'],
    [
      'multi-action ROUTINE noncanonical path',
      'ALTER ROUTINE set_updated_at() COST 1 SET search_path = private, pg_catalog',
    ],
    [
      'multi-action FUNCTION canonical path',
      'ALTER FUNCTION set_updated_at() COST 1 SET search_path = public, pg_catalog',
    ],
    ['bare FUNCTION RESET ALL', 'ALTER FUNCTION set_updated_at RESET ALL'],
    ['bare ROUTINE RESET search_path', 'ALTER ROUTINE set_updated_at RESET search_path'],
    ['bare ROUTINE noncanonical path', 'ALTER ROUTINE set_updated_at SET search_path = private, pg_catalog'],
    ['quoted public schema RESET ALL', 'ALTER FUNCTION "public"."set_updated_at" RESET ALL'],
    ['quoted parameter RESET', 'ALTER FUNCTION set_updated_at() RESET "search_path"'],
    ['quoted parameter override', 'ALTER FUNCTION set_updated_at() SET "search_path" = private, pg_catalog'],
    ['OUT-only identity RESET', 'ALTER FUNCTION set_updated_at(OUT ignored pg_catalog.trigger) RESET ALL'],
    ['unrelated ALTER action', 'ALTER FUNCTION set_updated_at() COST 1'],
    ['upper-case unquoted target', 'ALTER FUNCTION SET_UPDATED_AT() RESET ALL'],
  ])('rejects %s', (_description, statement) => {
    expect(unpinnedIn(mutateExistingFunction(statement))).toContain('set_updated_at');
  });

  it.each([
    'ALTER ROUTINE set_updated_at() SET search_path = public, pg_catalog',
    'ALTER ROUTINE public.set_updated_at() SET search_path TO public , pg_catalog',
    'ALTER FUNCTION set_updated_at SET search_path = public, pg_catalog',
    'ALTER ROUTINE "public"."set_updated_at" SET search_path TO public, pg_catalog',
    'ALTER FUNCTION SET_UPDATED_AT() SET search_path = public, pg_catalog',
    'ALTER FUNCTION set_updated_at() SET "search_path" = public, pg_catalog',
  ])('accepts canonical ALTER ROUTINE syntax: %s', (statement) => {
    expect(unpinnedIn(mutateExistingFunction(statement))).not.toContain('set_updated_at');
  });

  it('does not alias a quoted upper-case schema to public', () => {
    const pinned = foldMigrationSources([
      ...migrationSources(),
      'ALTER FUNCTION set_updated_at() RESET ALL;',
      'ALTER FUNCTION "PUBLIC".set_updated_at() SET search_path = public, pg_catalog;',
    ]);
    expect(unpinnedIn(pinned)).toContain('set_updated_at');
  });

  it('fails closed on a Unicode-escaped ALTER target', () => {
    const pinned = mutateExistingFunction('ALTER FUNCTION U&"set_updated_at"() RESET ALL');
    expect(unpinnedIn(pinned)).toContain(UNPARSED_ALTER_SENTINEL);
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

  it('rejects canonical then a quoted search_path override', () => {
    const migration = createTriggerWithPins(
      'SET search_path = public, pg_catalog',
      'SET "search_path" = private, pg_catalog',
    );
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toContain('inline_pin_fn');
  });

  it('rejects canonical then a Unicode-escaped search_path override', () => {
    const migration = createTriggerWithPins(
      'SET search_path = public, pg_catalog',
      'SET U&"search_path" = private, pg_catalog',
    );
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toContain('inline_pin_fn');
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

  it.each([
    ['RESET ALL', 'RESET ALL'],
    ['RESET search_path', 'RESET search_path'],
    ['quoted RESET search_path', 'RESET "search_path"'],
    ['SET SCHEMA', "SET SCHEMA 'private'"],
  ])('rejects canonical before AS then %s after AS', (_description, override) => {
    const migration = createTriggerWithAttributes(['SET search_path = public, pg_catalog'], [override]);
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toContain('inline_pin_fn');
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

  it.each([
    ['escape string', "E'BEGIN RETURN NEW; END;'"],
    ['Unicode escape string', "U&'BEGIN RETURN NEW; END;'"],
  ])('invalidates an existing pin when OR REPLACE uses an %s body', (_description, body) => {
    const migration = [
      'CREATE OR REPLACE FUNCTION set_updated_at() RETURNS pg_catalog.trigger',
      `AS ${body} LANGUAGE plpgsql;`,
    ].join('\n');
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toContain('set_updated_at');
  });

  it('keeps an E-string escaped apostrophe intact through a later override', () => {
    const migration = String.raw`CREATE FUNCTION escaped_comment_fn() RETURNS trigger
SET search_path = public, pg_catalog
AS E'BEGIN -- it\'s valid
 RETURN NULL; END;'
LANGUAGE plpgsql SET search_path = private;`;
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toContain('escaped_comment_fn');
  });

  it('invalidates an existing pin when OR REPLACE uses an OUT-only identity', () => {
    const migration = [
      'CREATE OR REPLACE FUNCTION set_updated_at(OUT ignored pg_catalog.trigger)',
      'RETURNS pg_catalog.trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;',
    ].join('\n');
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toContain('set_updated_at');
  });

  it('recognises a new OUT-only trigger function', () => {
    const migration = [
      'CREATE FUNCTION new_out_trigger(OUT ignored pg_catalog.trigger)',
      'RETURNS pg_catalog.trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;',
    ].join('\n');
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toContain('new_out_trigger');
  });

  it('fails closed on a Unicode-escaped CREATE target', () => {
    const migration = [
      'CREATE FUNCTION U&"unicode_trigger"() RETURNS trigger',
      'AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;',
    ].join('\n');
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toContain(UNPARSED_CREATE_SENTINEL);
  });

  it('recognises a schema-qualified trigger return type', () => {
    const migration = unpinnedTriggerFunction(
      'CREATE FUNCTION qualified_trigger_fn() RETURNS pg_catalog.trigger AS $$',
    );
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toEqual(['qualified_trigger_fn']);
  });

  it.each([
    'CREATE FUNCTION "public".quoted_schema_fn() RETURNS trigger AS $$',
    'CREATE FUNCTION public . spaced_schema_fn() RETURNS trigger AS $$',
  ])('recognises public schema spelling: %s', (header) => {
    const migration = unpinnedTriggerFunction(header);
    const expectedName = header.includes('quoted_schema_fn') ? 'quoted_schema_fn' : 'spaced_schema_fn';
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toEqual([expectedName]);
  });

  it('folds an unquoted upper-case CREATE name like PostgreSQL', () => {
    const created = [
      'CREATE FUNCTION INLINE_PIN_FN() RETURNS trigger',
      'SET search_path = public, pg_catalog AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;',
    ].join('\n');
    const pinned = foldMigrationSources([...migrationSources(), created, 'ALTER FUNCTION inline_pin_fn() RESET ALL;']);
    expect(unpinnedIn(pinned)).toEqual(['inline_pin_fn']);
  });

  it('keeps a non-ASCII dollar body intact through a later override', () => {
    const migration = [
      'CREATE FUNCTION unicode_body_fn() RETURNS trigger',
      'SET search_path = public, pg_catalog AS $corpsé$',
      'BEGIN PERFORM 1; RETURN NEW; END;',
      '$corpsé$ SET "search_path" = private, pg_catalog LANGUAGE plpgsql;',
    ].join('\n');
    expect(unpinnedIn(foldMigrationSources([...migrationSources(), migration]))).toEqual(['unicode_body_fn']);
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
