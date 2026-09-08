import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The screenshot-mode frozen clock (lib/clock.ts, #screenshot-pipeline PR3)
// only reaches relative-timestamp rendering ("3h ago") if every row goes
// through `formatRelativeTime` in `lib/format-relative-time.ts` — the one
// place that passes `nowMs()` into `@boardsesh/profile-stats`'s
// `formatTickRelativeTime`. A component that imports `formatTickRelativeTime`
// straight from `@boardsesh/profile-stats` bypasses that and silently reads
// the real wall clock even in screenshot mode, so this guards the whole
// components/app tree against that regression rather than trusting review.

const mobileRoot = fileURLToPath(new URL('../..', import.meta.url));

const SCAN_DIRECTORIES = ['src/components', 'app'];
const CODE_EXTENSIONS = ['.ts', '.tsx'];
// The named-import form covers every real call site (verified against the
// current tree); `formatTickRelativeTime` never appears as a namespace/default
// import anywhere in this codebase, so this single pattern is sufficient.
const DIRECT_IMPORT_PATTERN = /import\s*\{([^}]*)\}\s*from\s*['"]@boardsesh\/profile-stats['"]/g;

function collectSourceFiles(directory: string): string[] {
  return readdirSync(join(mobileRoot, directory), { recursive: true, encoding: 'utf8' })
    .filter((entry) => CODE_EXTENSIONS.some((extension) => entry.endsWith(extension)))
    .filter((entry) => !entry.split(sep).includes('__tests__'))
    .map((entry) => join(directory, entry));
}

function importsFormatTickRelativeTimeDirectly(source: string): boolean {
  for (const match of source.matchAll(DIRECT_IMPORT_PATTERN)) {
    const importedNames = match[1];
    if (new RegExp(`\\bformatTickRelativeTime\\b`).test(importedNames)) return true;
  }
  return false;
}

describe('relative-time rendering goes through the frozen clock', () => {
  it('no component or route imports formatTickRelativeTime directly from @boardsesh/profile-stats', () => {
    const offendingFiles = SCAN_DIRECTORIES.flatMap(collectSourceFiles).filter((relativePath) => {
      const source = readFileSync(join(mobileRoot, relativePath), 'utf8');
      return importsFormatTickRelativeTimeDirectly(source);
    });

    expect(
      offendingFiles,
      offendingFiles.length > 0
        ? `${offendingFiles.join(', ')} import formatTickRelativeTime directly from @boardsesh/profile-stats. ` +
            `Import formatRelativeTime from 'lib/format-relative-time' instead, so the screenshot-mode frozen ` +
            `clock (lib/clock.ts) reaches this row.`
        : undefined,
    ).toEqual([]);
  });

  it('lib/format-relative-time.ts is still the wrapper that threads nowMs() through', () => {
    // Pins the other half of the contract: the guard above is only meaningful
    // if the one allowed call site actually passes the frozen clock through.
    const wrapperSource = readFileSync(join(mobileRoot, 'src/lib/format-relative-time.ts'), 'utf8');
    expect(importsFormatTickRelativeTimeDirectly(wrapperSource)).toBe(true);
    expect(wrapperSource).toMatch(/formatTickRelativeTime\(iso,\s*nowMs\(\)\)/);
  });
});
