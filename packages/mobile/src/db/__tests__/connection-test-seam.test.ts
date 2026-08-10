// `resetDatabaseInitializationForTests` drops the single-flight guard that keeps one
// database lifecycle per process. Calling it from the app would let a remount start a
// second retry chain against the same file — the #4104 contention the guard exists to
// prevent. A JSDoc "test-only" label doesn't stop that, so the boundary is checked
// here: only the module that defines it, the ./testing barrel, and tests may reach it.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const SCANNED_ROOTS = ['src', 'app'];
const TESTING_BARREL = join(packageRoot, 'src', 'db', 'testing');
const ALLOWED_FILES = [join('src', 'db', 'connection.ts'), join('src', 'db', 'testing.ts')];

function listApplicationFiles(root: string): string[] {
  return readdirSync(join(packageRoot, root), { recursive: true, encoding: 'utf8' })
    .filter((entry) => /(?<!\.test)\.tsx?$/.test(entry))
    .map((entry) => join(root, entry))
    .filter((entry) => !entry.split(sep).includes('__tests__') && !ALLOWED_FILES.includes(entry));
}

/**
 * Resolves a relative or `@/`-aliased specifier (see tsconfig paths) to an absolute path,
 * extensionless so `'../db/testing'` and `'../db/testing.ts'` compare equal.
 */
function resolveSpecifier(file: string, specifier: string): string {
  const target = specifier.replace(/\.tsx?$/, '');
  if (target.startsWith('@/')) return join(packageRoot, 'src', target.slice(2));
  if (target.startsWith('.')) return resolve(dirname(join(packageRoot, file)), target);
  return target;
}

describe('database test seam', () => {
  const applicationFiles = SCANNED_ROOTS.flatMap(listApplicationFiles);

  it('scans the mobile source tree', () => {
    // A walk that silently matched nothing would make the guard below vacuous.
    expect(applicationFiles.length).toBeGreaterThan(100);
  });

  it('keeps the init-guard reset out of application code', () => {
    const offenders = applicationFiles.filter((file) => {
      const source = readFileSync(join(packageRoot, file), 'utf8');
      if (source.includes('resetDatabaseInitializationForTests')) return true;
      // Also the `import * as` / re-export forms that never spell the name out —
      // src/db/index.ts, the production barrel, is one of the files scanned here.
      return [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].some(
        ([, specifier]) => resolveSpecifier(file, specifier) === TESTING_BARREL,
      );
    });

    expect(offenders).toEqual([]);
  });
});
