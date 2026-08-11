/**
 * Guard for issue #1884: the profile domain moved off REST onto GraphQL.
 *
 * `GET/PUT /api/internal/profile` and `GET /api/internal/profile/{userId}` are
 * gone; `Query.profile`, `Mutation.updateProfile` and `Query.publicProfile`
 * cover everything they returned. A new caller reaching for the old path would
 * fail at runtime with a 404 rather than at build time, so pin it here.
 *
 * Scoped to the exact retired paths — `/api/internal/profile-percentiles` is a
 * live cron route with a colliding prefix and must keep working.
 */

import { describe, it, expect } from 'vite-plus/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// The web project's tests run from the repo root, but resolve from cwd either
// way so a scoped run still finds the tree.
const APP_DIR = [join(process.cwd(), 'packages/web/app'), join(process.cwd(), 'app')].find((candidate) =>
  existsSync(candidate),
);
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];
// Tests are excluded: this guard and the settings test both name the retired
// paths in prose, and a test mentioning a dead route can't resurrect it.
const SKIP_DIRECTORIES = new Set(['node_modules', '.next', '__tests__']);

// `profile` or `profile/<anything>`, but not `profile-percentiles`.
const RETIRED_PATH = /['"`/]api\/internal\/profile(?![-\w])/;

function collectSourceFiles(directory: string, collected: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      collectSourceFiles(fullPath, collected);
    } else if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      collected.push(fullPath);
    }
  }
  return collected;
}

describe('the /api/internal/profile REST routes stay retired', () => {
  if (!APP_DIR) throw new Error('Could not locate packages/web/app from the test working directory');
  const appDir = APP_DIR;
  const sourceFiles = collectSourceFiles(appDir);

  it('scanned the app directory', () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
  });

  it('has no source file referencing the deleted routes', () => {
    const offenders = sourceFiles.filter((filePath) => RETIRED_PATH.test(readFileSync(filePath, 'utf-8')));
    expect(offenders.map((filePath) => filePath.replace(appDir, ''))).toEqual([]);
  });

  it('leaves the profile-percentiles cron route alone', () => {
    expect(RETIRED_PATH.test("'/api/internal/profile-percentiles'")).toBe(false);
    expect(RETIRED_PATH.test("'/api/internal/profile'")).toBe(true);
    expect(RETIRED_PATH.test('`/api/internal/profile/${userId}`')).toBe(true);
  });
});
