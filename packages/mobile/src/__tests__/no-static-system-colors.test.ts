// No new static light-mode system colours outside src/theme.
//
// `iosSystemColors.systemGray` / `systemGray4` / `separator` / `systemRed` in
// src/theme/ios-colors.ts are fixed LIGHT-MODE hex values. They do not follow
// dark mode or Increase Contrast, so a grey caption, a hairline or an error line
// built from them is wrong in half the app's states (HIG Dark Mode: "use
// semantic colors"). Read the role from the theme instead:
//
//   systemGray   → systemColors.secondaryLabel / tertiaryLabel / fill (by role)
//   systemGray4  → systemColors.separator / fill
//   separator    → systemColors.separator
//   systemRed    → systemColors.error (iOS systemRed, M3 error on Material)
//
// Where a plain string is required (SVG props, withAlpha, Reanimated colour
// interpolation), use `chartColors.*` or `brandColors.error`.
//
// ALLOWLIST is shrink-only: each entry is a file that still holds that many
// uses, with the reason it cannot read the theme. Never add an entry; when you
// migrate one, lower or delete it (the test fails on a stale count so the list
// can't rot).

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const PACKAGE_ROOT = join(__dirname, '..', '..');
const SOURCE_ROOTS = [join(PACKAGE_ROOT, 'src'), join(PACKAGE_ROOT, 'app')];
const THEME_DIR = 'src/theme/';

const BANNED_KEYS = ['systemGray4', 'systemGray', 'separator', 'systemRed'] as const;
const BANNED = BANNED_KEYS.join('|');

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every name the file reaches `iosSystemColors` by: the import itself, an
 * aliased import (`iosSystemColors as ios`) and a re-bound const
 * (`const colors = iosSystemColors`).
 */
function aliasesOf(source: string): string[] {
  const aliases = new Set(['iosSystemColors']);
  for (const match of source.matchAll(/\biosSystemColors\s+as\s+([A-Za-z_$][\w$]*)/g)) aliases.add(match[1]);
  for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*iosSystemColors\b/g)) {
    aliases.add(match[1]);
  }
  return [...aliases];
}

/** Uses of a banned key: member access, bracket access, or a destructure. */
function countStaticColourUses(source: string): number {
  let count = 0;
  for (const alias of aliasesOf(source)) {
    const name = escapeRegExp(alias);
    const member = new RegExp(`\\b${name}\\s*(?:\\?\\.|\\.)\\s*(?:${BANNED})\\b`, 'g');
    const bracket = new RegExp(`\\b${name}\\s*\\[\\s*['"\`](?:${BANNED})['"\`]\\s*\\]`, 'g');
    count += (source.match(member) ?? []).length + (source.match(bracket) ?? []).length;
    const destructure = new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${name}\\b`, 'g');
    for (const match of source.matchAll(destructure)) {
      count += (match[1].match(new RegExp(`(?:^|[\\s,])(?:${BANNED})\\b`, 'g')) ?? []).length;
    }
  }
  return count;
}

/** File → [count, reason]. Shrink-only. */
const ALLOWLIST: Record<string, [number, string]> = {
  'src/providers/theme-provider.tsx': [
    1,
    'Theme resolution itself: screenshot mode swaps the translucent separator for its opaque static twin.',
  ],
  'src/components/session/SessionTickRow.tsx': [
    1,
    'Solid attempt badge under a white glyph. Neither label role keeps white-on-fill contrast in both schemes, same as the static brand tones beside it.',
  ],
};

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

function countStaticColours(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const root of SOURCE_ROOTS) {
    for (const file of walk(root)) {
      const path = relative(PACKAGE_ROOT, file);
      if (path.startsWith(THEME_DIR)) continue;
      const uses = countStaticColourUses(readFileSync(file, 'utf8'));
      if (uses > 0) counts.set(path, uses);
    }
  }
  return counts;
}

describe('the static-colour scanner', () => {
  it.each([
    ['member access', 'color: iosSystemColors.systemGray', 1],
    ['optional member access', 'iosSystemColors?.systemRed', 1],
    ['bracket access', "iosSystemColors['systemGray4']", 1],
    ['a destructure', 'const { systemGray, white, separator: hairline } = iosSystemColors;', 2],
    ['an aliased import', "import { iosSystemColors as ios } from '../theme/ios-colors';\nios.systemRed", 1],
    ['a re-bound const', 'const palette = iosSystemColors;\nconst { systemGray4 } = palette;', 1],
    ['an allowed key', 'iosSystemColors.white; iosSystemColors.systemGreen', 0],
  ])('counts %s', (_label, source, expected) => {
    expect(countStaticColourUses(source)).toBe(expected);
  });
});

describe('static iOS system colours stay inside src/theme', () => {
  const counts = countStaticColours();

  it('adds no new static systemGray / systemGray4 / separator / systemRed use', () => {
    const offenders = [...counts]
      .filter(([path, count]) => count > (ALLOWLIST[path]?.[0] ?? 0))
      .map(([path, count]) => `${path}: ${count} (allowed ${ALLOWLIST[path]?.[0] ?? 0})`);
    expect(offenders).toEqual([]);
  });

  it('keeps the allowlist shrink-only (no stale counts)', () => {
    const stale = Object.entries(ALLOWLIST)
      .filter(([path, [allowed]]) => (counts.get(path) ?? 0) < allowed)
      .map(([path, [allowed]]) => `${path}: now ${counts.get(path) ?? 0}, allowlist says ${allowed}`);
    expect(stale).toEqual([]);
  });

  it('actually scans the source tree', () => {
    // Guards against a path change that silently makes the scan empty.
    expect(walk(join(PACKAGE_ROOT, 'src')).length).toBeGreaterThan(500);
  });
});
