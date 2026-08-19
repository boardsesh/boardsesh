import { describe, expect, it } from 'vite-plus/test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression guard for #3975: `validateInput(SomeSchema, raw, 'field')` is
// only safe to call as a bare statement (discarding the parsed return) when
// `SomeSchema` has no `.default(...)`/`.transform(...)` in its chain — those
// only take effect on the PARSED result, never on the raw input the resolver
// keeps reading afterwards. `ClimbSearchInputSchema`'s `boulders`/`routes`
// defaults were exactly this: dead code because searchClimbs discarded the
// parsed value (see packages/backend/src/graphql/resolvers/climbs/queries.ts
// and packages/backend/src/validation/schemas/climbs.ts). This test statically
// scans every resolver file for statement-form validateInput calls and fails
// if the referenced schema has a live default/transform, so a future schema
// change can't silently go dormant the same way.

const currentDir = dirname(fileURLToPath(import.meta.url));
// packages/backend/src/validation/__tests__ -> packages/backend/src
const backendSrcDir = join(currentDir, '..', '..');
const resolversDir = join(backendSrcDir, 'graphql', 'resolvers');
const schemasDir = join(backendSrcDir, 'validation', 'schemas');

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(fullPath);
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) return [fullPath];
    return [];
  });
}

/** Strip `//` and `/* *\/` comments so prose mentioning `.default(`/`.transform(`
 * (e.g. explaining this very footgun) can't trip the scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

type DiscardedCall = { file: string; line: number; schemaName: string };

/** Find statement-form `validateInput(SchemaName, ...)` calls: the statement
 * begins with `validateInput(`, i.e. the return isn't assigned/awaited into a
 * variable. Matched against the whole file rather than line-by-line so a call
 * wrapped across lines (schema name on the next line, as the formatter does
 * for long argument lists) is still caught. */
function findDiscardedValidateInputCalls(filePath: string): DiscardedCall[] {
  const source = stripComments(readFileSync(filePath, 'utf8'));
  const calls: DiscardedCall[] = [];
  const statementFormRegex = /(?:^|\n)[ \t]*validateInput\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  let match = statementFormRegex.exec(source);
  while (match !== null) {
    // Line number of the `validateInput(` token itself.
    const tokenIndex = source.indexOf('validateInput(', match.index);
    calls.push({
      file: filePath,
      line: source.slice(0, tokenIndex).split('\n').length,
      schemaName: match[1],
    });
    match = statementFormRegex.exec(source);
  }
  return calls;
}

/** Slice out one `export const <Name> = ...` schema definition from a schema
 * file's source, from its declaration up to (but not including) the next
 * top-level `export const/function` — a good-enough approximation of "this
 * schema's chain" for detecting `.default(`/`.transform(` without a real
 * parser. */
function extractSchemaBody(source: string, schemaName: string): string | undefined {
  const declRegex = new RegExp(`export const ${schemaName}\\b`);
  const declMatch = declRegex.exec(source);
  if (!declMatch) return undefined;
  const startIndex = declMatch.index;
  const nextExportRegex = /\n(?=export (const|function) )/g;
  nextExportRegex.lastIndex = startIndex + declMatch[0].length;
  const nextMatch = nextExportRegex.exec(source);
  const endIndex = nextMatch ? nextMatch.index : source.length;
  return source.slice(startIndex, endIndex);
}

/** Collect every `export const <Name>` in the schema files, so a schema body
 * can be checked for references to OTHER schemas and followed into them. */
function collectSchemaBodies(schemaFiles: { path: string; source: string }[]): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const { source } of schemaFiles) {
    const stripped = stripComments(source);
    for (const match of stripped.matchAll(/export const ([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
      const name = match[1];
      if (bodies.has(name)) continue;
      const body = extractSchemaBody(stripped, name);
      if (body !== undefined) bodies.set(name, body);
    }
  }
  return bodies;
}

/** True when the schema — or any schema it composes, transitively — carries a
 * `.default()`/`.transform()`. Composition matters: `ClimbQueueItemSchema` has
 * no default of its own but embeds `ClimbInputSchema`, whose null-coalescing
 * `.transform()`s are just as dead when the parsed return is thrown away. */
function schemaHasLiveDefaultOrTransform(
  schemaName: string,
  bodies: Map<string, string>,
  seen: Set<string> = new Set(),
): boolean {
  if (seen.has(schemaName)) return false;
  seen.add(schemaName);
  const body = bodies.get(schemaName);
  // Schema not found in validation/schemas (e.g. imported from elsewhere,
  // or a plain z.ZodSchema built inline) — nothing to flag here.
  if (body === undefined) return false;
  if (/\.default\(|\.transform\(/.test(body)) return true;
  for (const match of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    const referenced = match[1];
    if (referenced === schemaName || !bodies.has(referenced)) continue;
    if (schemaHasLiveDefaultOrTransform(referenced, bodies, seen)) return true;
  }
  return false;
}

/**
 * Pre-existing discarded-return call sites, kept out of the failure list so
 * this guard can land as a ratchet rather than forcing an unrelated
 * behaviour change in the same PR.
 *
 * `ClimbQueueItemSchema` embeds `ClimbInputSchema`, whose nullish fields
 * `.transform()` null into `''`/`0`. The queue mutations validate and then
 * store/broadcast the RAW item, so those coercions never apply — peers and
 * Redis keep the nulls. Capturing the parsed value here would change what
 * every party-mode client receives for a queue item, which needs its own
 * change with its own QA, not a drive-by in the #3975 fix.
 *
 * Entries are `<resolver path relative to graphql/resolvers>::<SchemaName>`.
 * Shrink this list; never grow it.
 */
const KNOWN_DISCARDED_ALLOWLIST = new Set(['queue/mutations.ts::ClimbQueueItemSchema']);

function allowlistKey(call: DiscardedCall): string {
  return `${relative(resolversDir, call.file).split(sep).join('/')}::${call.schemaName}`;
}

describe('validateInput discarded-return usage', () => {
  it('never discards the return of a schema with a live .default()/.transform()', () => {
    const resolverFiles = listTsFiles(resolversDir);
    const schemaBodies = collectSchemaBodies(
      listTsFiles(schemasDir).map((path) => ({ path, source: readFileSync(path, 'utf8') })),
    );

    const offenders: DiscardedCall[] = [];
    const matchedAllowlistKeys = new Set<string>();
    for (const file of resolverFiles) {
      for (const call of findDiscardedValidateInputCalls(file)) {
        if (!schemaHasLiveDefaultOrTransform(call.schemaName, schemaBodies)) continue;
        const key = allowlistKey(call);
        if (KNOWN_DISCARDED_ALLOWLIST.has(key)) {
          matchedAllowlistKeys.add(key);
          continue;
        }
        offenders.push(call);
      }
    }

    // The allowlist is a ratchet: once a call site is cleaned up (or deleted),
    // its entry has to go too, or it silently starts covering something new.
    expect([...KNOWN_DISCARDED_ALLOWLIST].filter((key) => !matchedAllowlistKeys.has(key))).toEqual([]);

    if (offenders.length > 0) {
      const details = offenders
        .map((offender) => `  ${offender.file}:${offender.line} — validateInput(${offender.schemaName}, ...)`)
        .join('\n');
      throw new Error(
        `Found ${offenders.length} statement-form validateInput() call(s) whose schema has a ` +
          `.default()/.transform() that will never apply because the parsed return is discarded ` +
          `(see #3975):\n${details}\n\nEither capture the return (const parsed = validateInput(...)) ` +
          `and use it, or remove the default/transform if it's not meant to apply.`,
      );
    }

    expect(offenders).toEqual([]);
  });

  it('sanity check: the scan actually finds discarded statement-form calls today', () => {
    // Guards against the scan itself silently matching nothing (e.g. a path
    // typo) and the first test passing for the wrong reason. Deliberately a
    // low floor rather than today's exact count — resolvers legitimately come
    // and go, and this assertion only needs to prove the scanner sees code.
    const resolverFiles = listTsFiles(resolversDir);
    expect(resolverFiles.length).toBeGreaterThan(0);
    const totalDiscarded = resolverFiles.flatMap((file) => findDiscardedValidateInputCalls(file));
    expect(totalDiscarded.length).toBeGreaterThan(5);
  });
});
