/// <reference types="node" />

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The listing copy in fastlane/metadata/ has hard per-field caps that nothing
// checks until upload time: `deliver` and `supply` reject an over-long field
// *after* the merge, from a workflow nobody is watching, and the release stalls
// on a field that was one word too long. Translations are where this bites —
// German and French run 20-30% longer than the English they're translated from,
// and `short_description` (80) and the Play changelog (500) have almost no slack.
//
// Counts are characters (not bytes) with the trailing newline stripped, which is
// what both stores count and what deliver/supply send.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPLE_METADATA = resolve(REPO_ROOT, 'fastlane/metadata');
const PLAY_METADATA = resolve(APPLE_METADATA, 'android');

/** Apple: field -> cap. Files not listed here (the URLs) have no length limit. */
const APPLE_LIMITS: Record<string, number> = {
  'name.txt': 30,
  'subtitle.txt': 30,
  'promotional_text.txt': 170,
  'keywords.txt': 100,
  'description.txt': 4000,
  'release_notes.txt': 4000,
};

const PLAY_LIMITS: Record<string, number> = {
  'title.txt': 30,
  'short_description.txt': 80,
  'full_description.txt': 4000,
};

const PLAY_CHANGELOG_LIMIT = 500;

function contentLength(path: string): number {
  return readFileSync(path, 'utf8').replace(/\n$/, '').length;
}

/** Locale dirs under fastlane/metadata/, excluding the android/ subtree. */
function appleLocales(): string[] {
  return readdirSync(APPLE_METADATA, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'android')
    .map((entry) => entry.name)
    .sort();
}

function playLocales(): string[] {
  return readdirSync(PLAY_METADATA, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** File names in a locale dir, recursed one level so changelogs/ is included. */
function fileSet(root: string, locale: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(join(root, locale), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      names.push(...readdirSync(join(root, locale, entry.name)).map((name) => `${entry.name}/${name}`));
    } else if (entry.name.endsWith('.txt')) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

describe('App Store listing copy', () => {
  it('has locale folders to check', () => {
    expect(appleLocales().length).toBeGreaterThan(0);
  });

  // The length checks below skip a missing file, and nothing else guards Apple
  // metadata file parity — EXPECTED_DELIVER_LOCALES in the Fastfile gates only
  // screenshots. Without this, deleting or renaming de-DE/description.txt ships a
  // locale whose description silently keeps whatever was last uploaded.
  it.each(appleLocales())('gives %s the same file set as en-US', (locale) => {
    expect({ locale, files: fileSet(APPLE_METADATA, locale) }).toEqual({
      locale,
      files: fileSet(APPLE_METADATA, 'en-US'),
    });
  });

  it.each(appleLocales())('keeps every %s field inside its App Store limit', (locale) => {
    for (const [fileName, limit] of Object.entries(APPLE_LIMITS)) {
      const path = join(APPLE_METADATA, locale, fileName);
      if (!existsSync(path)) continue;
      const length = contentLength(path);
      // Assert on an object so a failure names the file and both numbers rather
      // than just "expected 172 to be less than 171".
      expect({ file: `${locale}/${fileName}`, length, within: length <= limit }).toEqual({
        file: `${locale}/${fileName}`,
        length,
        within: true,
      });
    }
  });

  it.each(appleLocales())('keeps %s keywords comma-separated with no padding', (locale) => {
    const path = join(APPLE_METADATA, locale, 'keywords.txt');
    if (!existsSync(path)) return;
    const keywords = readFileSync(path, 'utf8').replace(/\n$/, '');
    // Apple counts the whole string including separators, so a space after each
    // comma silently costs one keyword's worth of budget.
    expect({ locale, padded: / *, +| +,/.test(keywords) }).toEqual({ locale, padded: false });
    expect({ locale, empty: keywords.split(',').some((keyword) => keyword.trim().length === 0) }).toEqual({
      locale,
      empty: false,
    });
  });
});

describe('Play listing copy', () => {
  it('has locale folders to check', () => {
    expect(playLocales().length).toBeGreaterThan(0);
  });

  it.each(playLocales())('gives %s the same file set as en-US', (locale) => {
    // en-US additionally carries images/ (icon + feature graphic), which Play
    // takes once for the whole listing rather than per locale.
    const withoutImages = (files: string[]) => files.filter((name) => !name.startsWith('images/'));
    expect({ locale, files: withoutImages(fileSet(PLAY_METADATA, locale)) }).toEqual({
      locale,
      files: withoutImages(fileSet(PLAY_METADATA, 'en-US')),
    });
  });

  it.each(playLocales())('keeps every %s field inside its Play limit', (locale) => {
    for (const [fileName, limit] of Object.entries(PLAY_LIMITS)) {
      const path = join(PLAY_METADATA, locale, fileName);
      if (!existsSync(path)) continue;
      const length = contentLength(path);
      expect({ file: `android/${locale}/${fileName}`, length, within: length <= limit }).toEqual({
        file: `android/${locale}/${fileName}`,
        length,
        within: true,
      });
    }
  });

  it.each(playLocales())('keeps every %s changelog inside the 500-character cap', (locale) => {
    const changelogDir = join(PLAY_METADATA, locale, 'changelogs');
    if (!existsSync(changelogDir)) return;
    for (const fileName of readdirSync(changelogDir).filter((name) => name.endsWith('.txt'))) {
      const length = contentLength(join(changelogDir, fileName));
      const file = `android/${locale}/changelogs/${fileName}`;
      expect({ file, length, within: length <= PLAY_CHANGELOG_LIMIT }).toEqual({ file, length, within: true });
    }
  });
});
