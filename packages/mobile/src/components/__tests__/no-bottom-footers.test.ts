import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Sheet and screen actions go in the top bar (SheetTopBar through a sheet's
// `header`, useHeaderActions on a screen). A pinned bottom footer moves with
// the keyboard, the bottom inset and any error text above it, which is the
// yank this rule removes. See docs/mobile-sheets-vs-routes.md, "Where actions go".
//
// This is a source scan, not a render test: it fails when a file passes
// `footer=` to ModalSheet / Sheet, imports TickActionBar, or imports
// useSheetColumnStyle (the hook a hand-rolled sheet needs to pin its own
// footer), unless the file is on the list below.
//
// Known gaps, accepted for a cheap scan: a footer passed through a spread
// (`<ModalSheet {...props}>`) is invisible to it, and the comment stripper
// treats a `//` inside a string as a comment start (a URL after a colon is
// handled; other strings are not).

const MOBILE_ROOT = join(__dirname, '../../..');

/** The two footers the rule keeps for good. */
const PERMANENT_FOOTERS = [
  // Attempt / Save stay in thumb reach while logging an ascent.
  'src/components/LogAscentSheet.tsx',
  // A composer: the input and Send sit at the bottom, Messages-style.
  'src/components/you/CommentSheet.tsx',
];

/** Footers still to move to the top bar. Each later PR deletes its lines. */
const PENDING_FOOTERS: string[] = [];

const FOOTER_ALLOWLIST = new Set([...PERMANENT_FOOTERS, ...PENDING_FOOTERS]);

const TICK_ACTION_BAR_ALLOWLIST = new Set(['src/components/LogAscentSheet.tsx']);

/** Hand-rolled sheets that bound their own column. Shrink-only. */
const SHEET_COLUMN_STYLE_ALLOWLIST = new Set([
  'src/components/Sheet.tsx',
  'src/components/ModalSheet.tsx',
  // No footer any more, but still a raw native sheet with a scroll body, which
  // needs the iOS column bound to scroll at all (#3330). It can't move onto
  // ModalSheet: Apply commits from the native close and the sub-picker round
  // trip restores the scroll offset through its own scroll ref.
  'src/components/ClimbFilterSheet.tsx',
  // LogAscentSheet would be listed too, but it is a ModalSheet now and gets the
  // hook from the wrapper; it only mentions the hook in a comment.
]);

/** Where useSheetColumnStyle is defined. */
const SHEET_COLUMN_STYLE_HOME = new Set(['src/components/use-sheet-column-style.ts']);

/** Where TickActionBar is defined and re-exported: not a use of it. */
const TICK_ACTION_BAR_HOME = new Set(['src/components/tick/TickActionBar.tsx', 'src/components/tick/index.ts']);

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...listSourceFiles(fullPath));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function toRelative(filePath: string): string {
  return relative(MOBILE_ROOT, filePath).split(sep).join('/');
}

/** Drops comments, so prose that mentions a footer or TickActionBar is not a hit. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\w])\/\/.*$/gm, '$1');
}

/**
 * The opening tag of every `<ModalSheet` / `<Sheet` in the source, up to the
 * `>` that closes it. Braces are counted so an arrow function or a JSX element
 * inside a prop does not end the tag early.
 */
function sheetOpeningTags(source: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(/<(ModalSheet|Sheet)\b/g)) {
    const start = match.index ?? 0;
    let depth = 0;
    let quote: string | null = null;
    let end = source.length;
    for (let index = start + match[0].length; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      if (depth === 0 && (char === '"' || char === "'")) quote = char;
      else if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      else if (char === '>' && depth === 0) {
        end = index + 1;
        break;
      }
    }
    tags.push(source.slice(start, end));
  }
  return tags;
}

function passesSheetFooter(source: string): boolean {
  return sheetOpeningTags(stripComments(source)).some((tag) => /\sfooter\s*=/.test(tag));
}

function importsTickActionBar(source: string): boolean {
  const code = stripComments(source);
  return /import\s[^;]*\bTickActionBar\b[^;]*\sfrom\s/.test(code) || /<TickActionBar\b/.test(code);
}

function importsSheetColumnStyle(source: string): boolean {
  return /import\s[^;]*\buseSheetColumnStyle\b[^;]*\sfrom\s/.test(stripComments(source));
}

const SOURCE_FILES = [...listSourceFiles(join(MOBILE_ROOT, 'src')), ...listSourceFiles(join(MOBILE_ROOT, 'app'))];
const SOURCES = new Map(SOURCE_FILES.map((filePath) => [toRelative(filePath), readFileSync(filePath, 'utf8')]));

describe('no pinned bottom footers on sheets', () => {
  it('scans a real source tree', () => {
    expect(SOURCES.size).toBeGreaterThan(200);
    expect(SOURCES.has('src/components/ModalSheet.tsx')).toBe(true);
  });

  it('no file outside the allowlist passes footer= to ModalSheet or Sheet', () => {
    const offenders = [...SOURCES]
      .filter(([path, source]) => !FOOTER_ALLOWLIST.has(path) && passesSheetFooter(source))
      .map(([path]) => path);
    // Put the actions in a SheetTopBar through the sheet's `header` instead.
    expect(offenders).toEqual([]);
  });

  it('no file outside the allowlist imports TickActionBar', () => {
    const offenders = [...SOURCES]
      .filter(
        ([path, source]) =>
          !TICK_ACTION_BAR_ALLOWLIST.has(path) && !TICK_ACTION_BAR_HOME.has(path) && importsTickActionBar(source),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('no file outside the allowlist imports useSheetColumnStyle', () => {
    const offenders = [...SOURCES]
      .filter(
        ([path, source]) =>
          !SHEET_COLUMN_STYLE_ALLOWLIST.has(path) &&
          !SHEET_COLUMN_STYLE_HOME.has(path) &&
          importsSheetColumnStyle(source),
      )
      .map(([path]) => path);
    // Use ModalSheet / Sheet with a SheetTopBar header instead of a hand-rolled sheet.
    expect(offenders).toEqual([]);
  });

  it.each([...SHEET_COLUMN_STYLE_ALLOWLIST])(
    '%s still imports useSheetColumnStyle (delete it from the list if not)',
    (path) => {
      const source = SOURCES.get(path);
      expect(source, `${path} no longer exists`).toBeDefined();
      expect(importsSheetColumnStyle(source ?? '')).toBe(true);
    },
  );

  // A file that has moved its actions to the top bar must leave the list, so
  // the list only ever shrinks and never hides a new footer.
  it.each([...FOOTER_ALLOWLIST])('%s still passes a sheet footer (delete it from the list if not)', (path) => {
    const source = SOURCES.get(path);
    expect(source, `${path} no longer exists`).toBeDefined();
    expect(passesSheetFooter(source ?? '')).toBe(true);
  });

  it.each([...TICK_ACTION_BAR_ALLOWLIST])('%s still imports TickActionBar (delete it from the list if not)', (path) => {
    const source = SOURCES.get(path);
    expect(source, `${path} no longer exists`).toBeDefined();
    expect(importsTickActionBar(source ?? '')).toBe(true);
  });
});

describe('the footer scanner', () => {
  it('finds a footer prop after an arrow-function prop', () => {
    const source = `<ModalSheet visible onClose={() => a > b} footer={<Button title="Save" />}>body</ModalSheet>`;
    expect(passesSheetFooter(source)).toBe(true);
  });

  it('finds a footer on Sheet', () => {
    expect(passesSheetFooter(`<Sheet\n  sheetRef={ref}\n  footer={bar}\n>`)).toBe(true);
  });

  it('ignores a footer on a different component and in comments', () => {
    expect(passesSheetFooter(`<Section footer={<Text>x</Text>} />`)).toBe(false);
    expect(passesSheetFooter(`// <ModalSheet footer={x}>\n<ModalSheet header={bar}>`)).toBe(false);
  });

  it('ignores a footer inside the body, past the opening tag', () => {
    expect(passesSheetFooter(`<ModalSheet visible>\n<Section footer={x} />\n</ModalSheet>`)).toBe(false);
  });

  it('finds TickActionBar imports, direct and through the barrel, but not a comment', () => {
    expect(importsTickActionBar(`import { TickActionBar } from './tick/TickActionBar';`)).toBe(true);
    expect(importsTickActionBar(`import {\n  TickSheetHeader,\n  TickActionBar,\n} from '../tick';`)).toBe(true);
    expect(importsTickActionBar(`// Mirrors tickButtonStyles in TickActionBar.`)).toBe(false);
  });
});
