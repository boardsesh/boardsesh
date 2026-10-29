import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';
import { SUPPORT_BANNER_HREF, isSupportBannerWindow } from '../support-banner-window';

describe('isSupportBannerWindow', () => {
  it.each([
    ['2026-12-01T00:00:00.000Z', true],
    ['2026-12-15T12:00:00.000Z', true],
    ['2026-12-31T23:59:59.999Z', true],
    ['2026-11-30T23:59:59.999Z', false],
    ['2027-01-01T00:00:00.000Z', false],
    ['2027-12-15T12:00:00.000Z', false],
    ['2026-10-29T00:00:00.000Z', false],
  ])('%s is %s', (iso, expected) => {
    expect(isSupportBannerWindow(new Date(iso))).toBe(expected);
  });
});

describe('the banner link', () => {
  it('goes to /support tagged as the homepage banner', () => {
    expect(SUPPORT_BANNER_HREF).toBe('/support?src=web-home-banner');
  });
});

// The banner belongs on `/` only. Pages the app opens (`/b/`, `/gym/`, `/help/`,
// `/join/`, climb pages) must never carry an ask, so the one way in is the
// homepage's page.tsx. A new import anywhere else fails here.
describe('where the banner can render', () => {
  const appDir = join(__dirname, '..', '..', '..');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === 'node_modules' || name === '__tests__') return [];
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  it('is imported by the homepage alone', () => {
    const importers = sourceFiles(appDir)
      .filter((path) => /from ['"][^'"]*home-support-banner['"]/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(appDir, path));
    expect(importers).toEqual(['page.tsx']);
  });
});
