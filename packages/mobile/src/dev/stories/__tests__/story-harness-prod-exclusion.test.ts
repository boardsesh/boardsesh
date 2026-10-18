import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// The story harness must never reach a production bundle. `load.ts` is the one
// door: its requires sit behind `__DEV__`, which Metro folds away in production.
// This test keeps every other app file going through that door. The full proof
// is `vp run check:mobile-bundle`, which fails if the harness shows up in a real
// export.

const MOBILE_DIR = join(__dirname, '..', '..', '..', '..');
const HARNESS_DIR = join(MOBILE_DIR, 'src', 'dev', 'stories');

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name)) files.push(path);
  }
  return files;
}

const IMPORT_SPECIFIER = /(?:from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;

describe('story harness stays out of production code paths', () => {
  it('app code reaches src/dev/stories only through load.ts', () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(join(MOBILE_DIR, 'app')), ...sourceFiles(join(MOBILE_DIR, 'src'))]) {
      if (file.startsWith(HARNESS_DIR) || file.endsWith('.stories.tsx')) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(IMPORT_SPECIFIER)) {
        const specifier = match[1] ?? '';
        const isTypeOnly = /import\s+type\s/.test(source.slice(Math.max(0, (match.index ?? 0) - 200), match.index));
        if (specifier.includes('dev/stories') && !specifier.endsWith('dev/stories/load') && !isTypeOnly) {
          offenders.push(`${relative(MOBILE_DIR, file)} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every require in load.ts is behind __DEV__', () => {
    const source = readFileSync(join(HARNESS_DIR, 'load.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const statements = code.split(';').filter((statement) => statement.includes('require('));
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toMatch(/__DEV__/);
    }
  });
});
