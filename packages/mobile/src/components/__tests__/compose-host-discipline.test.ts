// The guard that keeps every Android Compose surface on the brand palette.
//
// An @expo/ui Host with no `seedColor` builds its Material scheme from the
// phone's wallpaper, so every colour a Compose control doesn't set comes out
// blue, green or red depending on the climber's background (#6919).
// `ComposeHost.android.tsx` is the one place that seeds it; this source scan
// fails when any other app file imports the raw `Host` from `@expo/ui` or
// `@expo/ui/jetpack-compose`. iOS and web files are skipped: their Host is
// SwiftUI / DOM and has no wallpaper palette.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MOBILE_DIR = fileURLToPath(new URL('../../..', import.meta.url));
const SCANNED_DIRS = ['src', 'app'].map((dir) => join(MOBILE_DIR, dir));
const COMPOSE_HOST_FILE = join(MOBILE_DIR, 'src/components/ComposeHost.android.tsx');

const RAW_HOST_IMPORT = /import\s*\{[^}]*\bHost\b[^}]*\}\s*from\s*['"]@expo\/ui(?:\/jetpack-compose)?['"]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.(ios|web)\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

describe('Compose Host discipline', () => {
  it('renders every Android Compose surface through ComposeHost', () => {
    const offenders = SCANNED_DIRS.flatMap(sourceFiles)
      .filter((path) => path !== COMPOSE_HOST_FILE)
      .filter((path) => RAW_HOST_IMPORT.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(MOBILE_DIR.length));
    expect(offenders).toEqual([]);
  });

  it('still finds the seeded Host it guards', () => {
    expect(RAW_HOST_IMPORT.test(readFileSync(COMPOSE_HOST_FILE, 'utf8'))).toBe(true);
  });
});
