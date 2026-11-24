// Violet text means "you can tap this". Eyebrows, headings, kicker lines, labels
// and decorative icons read grey (`--neutral-500` / `--neutral-900`), the same
// rule the mobile app holds in `no-violet-selection.test.ts`.
//
// The scan: any `color`, `fill` or `-webkit-text-fill-color` declaration set to
// `var(--color-primary...)` in a CSS module (fallbacks and inner spaces
// included), counted per file after comments are stripped. Borders, outlines,
// backgrounds and shadows are not matched, so a focus ring or a selected bar is
// free. A file may only hold such declarations if it is on ALLOWLIST below, with
// exactly that count.
//
// ALLOWLIST only shrinks. Never add an entry; when a file stops using violet
// text, delete its line (the test fails on a stale entry so the list can't rot).

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const APP_ROOT = join(__dirname, '..', '..');
const PACKAGE_ROOT = join(APP_ROOT, '..');

const VIOLET_TEXT = /(?:^|[\s;{])(?:color|fill|-webkit-text-fill-color):\s*var\(\s*--color-primary[\w-]*\s*[,)]/g;

const ALLOWLIST: Record<string, { count: number; why: string }> = {
  'app/boards/boards-gallery.module.css': { count: 1, why: 'rail scroll buttons are tappable controls' },
  'app/components/app-guides/app-guide.module.css': {
    count: 1,
    why: 'the "Compare … apps" text action inside a whole-tile board link (hub tiles and spray banner)',
  },
  'app/build-plans/build-plans.module.css': { count: 1, why: 'table-of-contents link hover colour' },
  'app/components/beta-videos/boardsesh-beta.module.css': {
    count: 2,
    why: 'text link and the "Watch" action inside a card link',
  },
  'app/components/board-entity/popular-board-rail.module.css': { count: 1, why: 'gym name is a link' },
  'app/components/site-chrome/marketing-header.module.css': {
    count: 1,
    why: 'the "Start climbing" item in the phone nav menu',
  },
  'app/help/help.module.css': { count: 1, why: 'the "Read the guide" action on a tile link' },
};

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (entry.endsWith('.module.css')) files.push(full);
  }
  return files;
}

function violetTextCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of walk(APP_ROOT)) {
    const count = (stripComments(readFileSync(file, 'utf8')).match(VIOLET_TEXT) ?? []).length;
    if (count > 0) counts[relative(PACKAGE_ROOT, file)] = count;
  }
  return counts;
}

describe('no decorative violet text in CSS modules', () => {
  it('matches the allowlist exactly, file by file', () => {
    const allowed = Object.fromEntries(Object.entries(ALLOWLIST).map(([file, { count }]) => [file, count]));
    expect(violetTextCounts()).toEqual(allowed);
  });
});
