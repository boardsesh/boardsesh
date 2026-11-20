// No new violet for a selected or current item.
//
// Velvet Send v2 rule: violet text and icons only on things you can tap. A
// selected row, the board you're on or an active chip is a state, not a link, so
// painting it `brandColors.primary` makes it look tappable (HIG Color: "if you use
// your brand color to indicate that a borderless button is interactive, using the
// same or similar color to stylize noninteractive text is confusing"). Read
// `theme.selection` instead:
//
//   selected title    → theme.selection.text      (label)
//   checkmark         → theme.selection.checkmark (accent)
//   row / cell wash   → theme.selection.fill      (brand fill at 13% light, 20% dark)
//
// The scan is one deliberately simple pattern: a selection flag named `isActive`,
// `active`, `isSelected` or `selected` (bare or as a member, `item.isActive`),
// followed straight by `?` and `brandColors.primary` (or `brand.primary`,
// `theme.brandColors.primary`). `primaryFill` is not matched. Comparisons
// (`index === activeIndex ? …`), other flag names and negated flags are missed on
// purpose: a false negative is fine, a false positive is not. Comments are
// stripped first (a `//` after whitespace, and block comments).
//
// ALLOWLIST is shrink-only: each entry is a file that still holds that many
// ternaries today. Never add an entry; when you migrate one (wave W1), lower or
// delete it (the test fails on a stale count so the list can't rot).

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const PACKAGE_ROOT = join(__dirname, '..', '..');
const SOURCE_ROOTS = [join(PACKAGE_ROOT, 'src'), join(PACKAGE_ROOT, 'app')];

// The lookbehind skips a negated flag however it is written: `!selected`,
// `! selected`, `!item.selected`, `!item?.isActive`.
const SELECTION_TERNARY =
  /(?<!!\s*(?:[\w$]+\??\.)*)\b(?:isActive|active|isSelected|selected)\s*\?\s*(?:theme\.)?(?:brandColors|brand)\.primary\b/g;

/**
 * Drop block comments and `//` comments that follow whitespace (not the `//` in a
 * URL), so a doc comment quoting the pattern isn't counted.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function countSelectionTernaries(source: string): number {
  return (stripComments(source).match(SELECTION_TERNARY) ?? []).length;
}

/**
 * The allowlist's size, pinned so no one can add an entry or raise a count.
 * When you migrate a file, lower its entry AND these two numbers.
 */
const ALLOWLIST_FILES = 0;
const ALLOWLIST_TOTAL = 0;

/** File → count today. Shrink-only. */
const ALLOWLIST: Record<string, number> = {};

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === '.expo') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts') && !/\.test\.tsx?$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function countAll(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const root of SOURCE_ROOTS) {
    for (const file of walk(root)) {
      const uses = countSelectionTernaries(readFileSync(file, 'utf8'));
      if (uses > 0) counts.set(relative(PACKAGE_ROOT, file), uses);
    }
  }
  return counts;
}

const HOW_TO_FIX =
  'A selected or current item is a state, not a link: use theme.selection (text: label, ' +
  'checkmark: accent, fill: the brand wash behind the row) instead of brandColors.primary. ' +
  'Violet text and icons only on things you can tap. See "Velvet Send v2 roles" in ' +
  'docs/design/ai-design-guidelines.md.';

describe('the selection-ternary scanner', () => {
  it.each([
    ['a bare flag', 'color={selected ? brandColors.primary : systemColors.label}', 1],
    ['a member flag', 'color={item.isActive ? brandColors.primary : undefined}', 1],
    ['an isSelected flag over two lines', 'color={isSelected\n  ? brandColors.primary\n  : systemColors.label}', 1],
    ['the theme path', 'borderColor: active ? theme.brandColors.primary : separator', 1],
    ['the brand alias', 'const tint = isActive ? brand.primary : label;', 1],
    ['a fill, not a foreground', 'backgroundColor: selected ? brandColors.primaryFill : fill', 0],
    ['a negated flag', 'color={!selected ? brandColors.primary : label}', 0],
    ['a negated member flag', 'color={!item.selected ? brandColors.primary : label}', 0],
    ['a negated flag after a space', 'color={! selected ? brandColors.primary : label}', 0],
    ['a negated optional member flag', 'color={!option?.isActive ? brandColors.primary : label}', 0],
    ['a flag after an unrelated negation', 'color={!hidden && selected ? brandColors.primary : label}', 1],
    ['a comparison', 'color={index === activeIndex ? brandColors.primary : label}', 0],
    ['another flag name', 'color={isPinned ? brandColors.primary : label}', 0],
    ['a comment', '// selected ? brandColors.primary was the old look', 0],
    ['the selection role', 'color={selected ? theme.selection.text : systemColors.label}', 0],
  ])('counts %s', (_label, source, expected) => {
    expect(countSelectionTernaries(source)).toBe(expected);
  });
});

describe('selection is never violet text', () => {
  const counts = countAll();

  it('adds no new `selected ? brandColors.primary` ternary', () => {
    const offenders = [...counts]
      .filter(([path, count]) => count > (ALLOWLIST[path] ?? 0))
      .map(([path, count]) => `${path}: ${count} (allowed ${ALLOWLIST[path] ?? 0})`);
    expect(offenders, HOW_TO_FIX).toEqual([]);
  });

  it('keeps the allowlist shrink-only (no stale counts)', () => {
    const stale = Object.entries(ALLOWLIST)
      .filter(([path, allowed]) => (counts.get(path) ?? 0) < allowed)
      .map(([path, allowed]) => `${path}: now ${counts.get(path) ?? 0}, allowlist says ${allowed}`);
    expect(stale, 'Lower or delete these entries: the file has fewer ternaries now.').toEqual([]);
  });

  it('pins the allowlist size (it only ever shrinks)', () => {
    const total = Object.values(ALLOWLIST).reduce((sum, count) => sum + count, 0);
    const pinned = 'Never grow the allowlist; after a migration, lower ALLOWLIST_FILES / ALLOWLIST_TOTAL to match.';
    expect(Object.keys(ALLOWLIST).length, pinned).toBe(ALLOWLIST_FILES);
    expect(total, pinned).toBe(ALLOWLIST_TOTAL);
  });

  it('actually scans the source tree', () => {
    // Guards against a path change that silently makes the scan empty.
    expect(walk(join(PACKAGE_ROOT, 'src')).length).toBeGreaterThan(500);
  });
});
