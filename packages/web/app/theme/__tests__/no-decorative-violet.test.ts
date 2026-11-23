// Violet text means "you can tap this". Eyebrows, headings, kicker lines, labels
// and decorative icons read grey (`--neutral-500` / `--neutral-900`), the same
// rule the mobile app holds in `no-violet-selection.test.ts`.
//
// The scan: any `color: var(--color-primary...)` declaration in a CSS module.
// Borders, outlines, backgrounds and shadows are not matched, so a focus ring or
// a selected bar is free. A file may only hold such a declaration if it is on
// ALLOWLIST below.
//
// ALLOWLIST only shrinks. Never add an entry; when a file stops using violet
// text, delete its line (the test fails on a stale entry so the list can't rot).

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const APP_ROOT = join(__dirname, '..', '..');
const PACKAGE_ROOT = join(APP_ROOT, '..');

const VIOLET_TEXT = /(?:^|[\s;{])color:\s*var\(--color-primary[\w-]*\)/g;

const ALLOWLIST: Record<string, string> = {
  'app/boards/boards-gallery.module.css': 'rail scroll buttons are tappable controls',
  'app/build-plans/build-plans.module.css': 'table-of-contents link hover colour',
  'app/components/beta-videos/boardsesh-beta.module.css': 'text link and the "Watch" action inside a card link',
  'app/components/board-entity/popular-board-rail.module.css': 'gym name is a link',
  'app/components/site-chrome/marketing-header.module.css': 'mobile "Get the app" header link',
  'app/help/help.module.css': 'the "Read the guide" action on a tile link',
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

function filesWithVioletText(): string[] {
  return walk(APP_ROOT)
    .filter((file) => (stripComments(readFileSync(file, 'utf8')).match(VIOLET_TEXT) ?? []).length > 0)
    .map((file) => relative(PACKAGE_ROOT, file));
}

describe('no decorative violet text in CSS modules', () => {
  const offenders = filesWithVioletText();

  it('only allowlisted files set a violet text colour', () => {
    expect(offenders.filter((file) => !(file in ALLOWLIST))).toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    expect(Object.keys(ALLOWLIST).filter((file) => !offenders.includes(file))).toEqual([]);
  });
});
