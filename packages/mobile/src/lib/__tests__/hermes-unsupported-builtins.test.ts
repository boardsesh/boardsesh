import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The app runs on Hermes, which lacks the ES2023 copying array methods. A call
// to one throws "undefined is not a function" on a phone, and nothing else
// catches it: TypeScript knows the method, and these tests run under Node,
// which has it. `toSorted` in the play drawer's climber logs crashed the drawer
// in QA this way. Use `[...items].sort(compare)` (and friends) instead.
const UNSUPPORTED_CALL = /\.(toSorted|toReversed|toSpliced)\(/;

const REPO_ROOT = resolve(__dirname, '../../../../..');
// Everything Metro can put in the bundle: the app, and the shared packages it imports.
const BUNDLED_ROOTS = ['packages/mobile/src', 'packages/mobile/app', 'packages/shared'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', '__tests__', 'dist', 'generated']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return SKIPPED_DIRECTORIES.has(name) ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('Hermes-unsupported builtins', () => {
  it('no bundled source calls toSorted, toReversed or toSpliced', () => {
    const offenders = BUNDLED_ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root))).flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          UNSUPPORTED_CALL.test(line) ? [`${relative(REPO_ROOT, path)}:${index + 1}: ${line.trim()}`] : [],
        ),
    );
    expect(offenders).toEqual([]);
  });
});
