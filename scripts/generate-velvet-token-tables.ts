/// <reference types="node" />

/**
 * Rewrite the token tables in docs/design/ai-design-guidelines.md from the real token
 * sources, so the doc cannot drift from the code.
 *
 * Usage:
 *   vp run docs:velvet-tokens          # rewrite the generated tables
 *   vp run check:velvet-tokens         # exit 1 if the committed doc is stale
 *
 * Each generated table sits between a marker pair in the doc:
 *
 *   <!-- velvet-tokens:<name>:start -->
 *   ...table (overwritten)...
 *   <!-- velvet-tokens:<name>:end -->
 *
 * Sources
 * -------
 * - `packages/shared/velvet-tokens/src/index.ts`: brand colours (light/dark), the
 *   Graphite Material surfaces and the Material container ladder. Pure TypeScript, so
 *   it is imported directly.
 * - `packages/mobile/src/theme/colors.ts`: the iOS `PlatformColor` names and the
 *   Android fallback ladder.
 * - `packages/mobile/src/theme/typography.ts`: the HIG and M3 type scales.
 * - `packages/mobile/src/theme/tokens.ts`: spacing, radii, opacity.
 *
 * The three mobile files import `react-native`, so they cannot be loaded in Node. The
 * generator reads their text and evaluates only the plain object literals it names. A
 * literal that stops being plain (a function call, a reference to another binding)
 * fails loudly instead of printing a wrong number.
 *
 * Which row says what ("Use" column) is editorial, so it lives here, not in the code.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  brandColors,
  brandColorsDark,
  materialSurfaceContainers,
  materialSurfaces,
} from '../packages/shared/velvet-tokens/src/index';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

export const DOC_PATH = 'docs/design/ai-design-guidelines.md';
const COLORS_PATH = 'packages/mobile/src/theme/colors.ts';
const TYPOGRAPHY_PATH = 'packages/mobile/src/theme/typography.ts';
const TOKENS_PATH = 'packages/mobile/src/theme/tokens.ts';

/** What each brand role is for. A role missing here prints "-" and the test fails. */
export const BRAND_ROLE_USE: Record<string, string> = {
  tint: 'Brand foreground, alias of `primary`',
  primary: 'Brand **foreground**: text, icons, links, borders',
  primaryFill: 'Brand **filled** surface/button background',
  primaryStrong: 'Brand foreground on a tonal violet wash (the player wall button)',
  onPrimary: 'Text/icon sitting on `primaryFill`',
  accent: 'Mint spark for highlights; **fill or stroke only, never text; pair a fill with dark text**',
  onAccent: 'The dark ink that pairs with `accent`; one ink for both mints',
  success: 'Success states',
  warning: 'Warnings',
  error: 'Destructive actions',
  live: 'This climb is lit / now on the wall',
  onLive: 'Text/icon on a `live` fill: white in light, the dark ink in dark',
  historyFill: 'The wall kiosk\'s "viewing history" bar',
};

/** What each system colour key means. */
export const SYSTEM_KEY_USE: Record<string, string> = {
  background: 'Screen base',
  secondaryBackground: 'Cards, sheets',
  tertiaryBackground: 'A step above the card',
  groupedBackground: 'Grouped-list base',
  secondaryGroupedBackground: 'Card that sits on `groupedBackground` (a Form row)',
  tertiaryGroupedBackground: 'A block inside a grouped card',
  elevatedSurface: 'Raised tile (selected segmented pill, elevated bar)',
  label: 'Primary text',
  secondaryLabel: 'Secondary text',
  tertiaryLabel: 'Tertiary text',
  separator: 'Hairlines, dividers',
  fill: 'Small control fills (segmented tracks)',
  tertiaryFill: 'Large grouped backgrounds; `fill` is for small controls',
  error: 'Destructive foreground and selected favourite hearts',
  accent: 'Interactive foreground; on iOS it adapts to Increase Contrast',
};

const TYPE_VARIANT_NOTES: Record<string, string> = {
  label: 'Every top-bar and header button',
};

// ---------------------------------------------------------------------------
// Reading the mobile sources
// ---------------------------------------------------------------------------

/** Replace `//` and block comments with nothing, leaving string contents alone. */
export function stripComments(source: string): string {
  let output = '';
  let index = 0;
  let quote: string | null = null;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote !== null) {
      output += char;
      if (char === '\\') {
        output += next ?? '';
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      output += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

/** The `{ ... }` literal that initialises `export const <name> = `, comments removed. */
export function extractObjectLiteral(source: string, name: string): string {
  const stripped = stripComments(source);
  const declaration = new RegExp(`export const ${name}\\s*(?::[^=]+)?=\\s*\\{`).exec(stripped);
  if (declaration === null) throw new Error(`export const ${name} = { ... } not found`);
  const start = declaration.index + declaration[0].length - 1;
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < stripped.length; index += 1) {
    const char = stripped[index];
    if (quote !== null) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return stripped.slice(start, index + 1);
    }
  }
  throw new Error(`export const ${name}: unbalanced braces`);
}

/** Evaluate a plain literal. Anything that is not data (calls, bindings) throws. */
export function evaluateLiteral(literal: string, label: string): Record<string, unknown> {
  // Only literal data may reach `new Function`: a bare identifier call, member access
  // or arrow is a sign the token stopped being a plain value.
  const probe = literal.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
  if (/[A-Za-z_$][\w$]*\s*\(|=>|\.\.\./.test(probe) || /:\s*[A-Za-z_$][\w$.]*\s*[,}]/.test(probe)) {
    throw new Error(`${label} is no longer a plain object literal; teach the generator about it`);
  }
  return new Function(`return (${literal});`)() as Record<string, unknown>;
}

function readLiteral(repoRoot: string, relativePath: string, name: string): Record<string, unknown> {
  const source = readFileSync(path.join(repoRoot, relativePath), 'utf8');
  return evaluateLiteral(extractObjectLiteral(source, name), `${relativePath} ${name}`);
}

/** `key: PlatformColor('name')` lines of `iosSystemColors`, plus the DynamicColorIOS accent. */
function readIosSystemColors(source: string): Array<{ key: string; platformColor: string }> {
  // `iosSystemColors` has a ternary initialiser, so scan from its declaration instead.
  const stripped = stripComments(source);
  const declaration = /export const iosSystemColors[^=]*=/.exec(stripped);
  if (declaration === null) throw new Error('export const iosSystemColors not found');
  const tail = stripped.slice(declaration.index);
  const open = tail.indexOf('{');
  let depth = 0;
  for (let index = open; index < tail.length; index += 1) {
    if (tail[index] === '{') depth += 1;
    else if (tail[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        const block = tail.slice(open, index + 1);
        const rows: Array<{ key: string; platformColor: string }> = [];
        for (const match of block.matchAll(/(\w+):\s*PlatformColor\('([^']+)'\)/g)) {
          rows.push({ key: match[1], platformColor: match[2] });
        }
        const hasDynamicAccent = /accent:\s*DynamicColorIOS\(/.test(block);
        if (hasDynamicAccent) rows.push({ key: 'accent', platformColor: 'brand tint (DynamicColorIOS)' });
        if (rows.length === 0) throw new Error('no PlatformColor entries found in iosSystemColors');
        return rows;
      }
    }
  }
  throw new Error('iosSystemColors: unbalanced braces');
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function escapeCell(cell: string): string {
  return cell.replace(/\|/g, '\\|');
}

/** A markdown table with padded columns, so the source reads like the rendered one. */
export function markdownTable(header: string[], rows: string[][]): string {
  const all = [header, ...rows].map((row) => row.map(escapeCell));
  const widths = header.map((_, column) => Math.max(3, ...all.map((row) => row[column].length)));
  const line = (row: string[]) => `| ${row.map((cell, column) => cell.padEnd(widths[column])).join(' | ')} |`;
  const separator = `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`;
  return [line(all[0]), separator, ...all.slice(1).map(line)].join('\n');
}

const code = (value: string | number): string => `\`${value}\``;

function typeCell(style: Record<string, unknown>): string {
  return `${style.fontSize} / ${style.fontWeight} / ${style.lineHeight}`;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export type TokenTables = Record<string, string>;

export function buildTokenTables(repoRoot: string): TokenTables {
  const colorsSource = readFileSync(path.join(repoRoot, COLORS_PATH), 'utf8');
  const tables: TokenTables = {};

  // Brand colours: light and dark from the shared package.
  tables.brand = markdownTable(
    ['Role', 'Light', 'Dark', 'Use'],
    (Object.keys(brandColors) as Array<keyof typeof brandColors>)
      .filter((role) => role !== 'tint')
      .map((role) => [code(role), code(brandColors[role]), code(brandColorsDark[role]), BRAND_ROLE_USE[role] ?? '-']),
  );

  // iOS: the PlatformColor behind every system role.
  tables['ios-system'] = markdownTable(
    ['Key', 'iOS `PlatformColor`', 'Meaning'],
    readIosSystemColors(colorsSource).map(({ key, platformColor }) => [
      code(key),
      key === 'accent' ? platformColor : code(platformColor),
      SYSTEM_KEY_USE[key] ?? '-',
    ]),
  );

  // Android + Liquid Glass fallback ladder.
  const android = readLiteral(repoRoot, COLORS_PATH, 'androidFallbackColors') as Record<
    'light' | 'dark',
    Record<string, string>
  >;
  tables['android-fallback'] = markdownTable(
    ['Key', 'Light', 'Dark', 'Meaning'],
    Object.keys(android.light).map((key) => [
      code(key),
      code(android.light[key]),
      code(android.dark[key]),
      SYSTEM_KEY_USE[key] ?? '-',
    ]),
  );

  // Material "Graphite" surfaces and container ladder (both from the shared package).
  tables['material-surfaces'] = markdownTable(
    ['Key', 'Dark', 'Light'],
    Object.keys(materialSurfaces.dark).map((key) => {
      const surfaceKey = key as keyof typeof materialSurfaces.dark;
      return [code(key), code(materialSurfaces.dark[surfaceKey]), code(materialSurfaces.light[surfaceKey])];
    }),
  );
  tables['material-containers'] = markdownTable(
    ['Container', 'Dark', 'Light'],
    Object.keys(materialSurfaceContainers.dark).map((key) => {
      const containerKey = key as keyof typeof materialSurfaceContainers.dark;
      return [
        code(key),
        code(materialSurfaceContainers.dark[containerKey]),
        code(materialSurfaceContainers.light[containerKey]),
      ];
    }),
  );

  // Type scales.
  const hig = readLiteral(repoRoot, TYPOGRAPHY_PATH, 'textStyles') as Record<string, Record<string, unknown>>;
  const material = readLiteral(repoRoot, TYPOGRAPHY_PATH, 'materialTextStyles') as Record<
    string,
    Record<string, unknown>
  >;
  tables['type-scale'] = markdownTable(
    ['Variant key', 'HIG (Liquid Glass)', 'M3 (Material)', 'Note'],
    Object.keys(hig).map((key) => [
      code(key),
      typeCell(hig[key]),
      typeCell(material[key]),
      TYPE_VARIANT_NOTES[key] ?? '',
    ]),
  );

  // Spacing, radii, opacity.
  const spacing = readLiteral(repoRoot, TOKENS_PATH, 'spacing');
  tables.spacing = markdownTable(
    ['Token', 'px'],
    Object.entries(spacing).map(([token, value]) => [code(token), String(value)]),
  );
  const radii = readLiteral(repoRoot, TOKENS_PATH, 'borderRadius');
  tables.radii = markdownTable(
    ['Token', 'pt'],
    Object.entries(radii).map(([token, value]) => [code(token), String(value)]),
  );
  const opacity = readLiteral(repoRoot, TOKENS_PATH, 'opacity');
  tables.opacity = markdownTable(
    ['Token', 'Value'],
    Object.entries(opacity).map(([token, value]) => [code(token), String(value)]),
  );

  return tables;
}

// ---------------------------------------------------------------------------
// Doc rewrite
// ---------------------------------------------------------------------------

const markerStart = (name: string) => `<!-- velvet-tokens:${name}:start -->`;
const markerEnd = (name: string) => `<!-- velvet-tokens:${name}:end -->`;

/** Replace each marked block in `doc`. Throws if a table has no marker pair, or the reverse. */
export function applyTokenTables(doc: string, tables: TokenTables): string {
  let result = doc;
  for (const [name, table] of Object.entries(tables)) {
    const start = result.indexOf(markerStart(name));
    const end = result.indexOf(markerEnd(name));
    if (start === -1 || end === -1 || end < start) {
      throw new Error(`${DOC_PATH} is missing the "${name}" marker pair (${markerStart(name)} ... ${markerEnd(name)})`);
    }
    result = `${result.slice(0, start + markerStart(name).length)}\n\n${table}\n\n${result.slice(end)}`;
  }
  const known = new Set(Object.keys(tables));
  for (const match of result.matchAll(/<!-- velvet-tokens:([\w-]+):start -->/g)) {
    if (!known.has(match[1])) throw new Error(`${DOC_PATH} has a "${match[1]}" marker the generator does not produce`);
  }
  return result;
}

export function renderDoc(repoRoot: string): { current: string; expected: string } {
  const current = readFileSync(path.join(repoRoot, DOC_PATH), 'utf8');
  return { current, expected: applyTokenTables(current, buildTokenTables(repoRoot)) };
}

function main(): void {
  const isCheck = process.argv.includes('--check');
  const { current, expected } = renderDoc(REPO_ROOT);
  if (isCheck) {
    if (current === expected) {
      console.log(`${DOC_PATH} token tables are up to date.`);
      return;
    }
    console.error(
      `${DOC_PATH} token tables are out of date: a token changed in code and the doc did not.\n` +
        '  run `vp run docs:velvet-tokens` and commit the result.',
    );
    process.exitCode = 1;
    return;
  }
  if (current === expected) {
    console.log(`${DOC_PATH} already up to date.`);
    return;
  }
  writeFileSync(path.join(REPO_ROOT, DOC_PATH), expected);
  console.log(`Rewrote the token tables in ${DOC_PATH}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}
