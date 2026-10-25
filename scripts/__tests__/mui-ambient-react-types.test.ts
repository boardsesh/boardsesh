/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const webRequire = createRequire(new URL('../../packages/web/package.json', import.meta.url));
const mobileRequire = createRequire(new URL('../../packages/mobile/package.json', import.meta.url));
const materialRoot = dirname(webRequire.resolve('@mui/material/package.json'));
const materialRequire = createRequire(join(materialRoot, 'package.json'));
const webReactTypes = join(dirname(webRequire.resolve('@types/react/package.json')), 'index.d.ts');
const mobileReactTypes = join(dirname(mobileRequire.resolve('@types/react/package.json')), 'index.d.ts');
const fixtureDirectories: string[] = [];

afterAll(() => {
  for (const directory of fixtureDirectories) rmSync(directory, { recursive: true, force: true });
});

function compileSpread(sourcePath: string, declaration: string): { status: number | null; output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'boardsesh-mui-react-'));
  fixtureDirectories.push(directory);
  // Relocate the published helper into a context whose ambient React is mobile's.
  // Its explicit imports still resolve the web types, exactly as its consuming app does.
  const muiTypes = join(dirname(materialRequire.resolve('@mui/types/package.json')), 'index.d.ts');
  const styles = resolve(dirname(sourcePath), '../styles/index.d.ts');
  writeFileSync(
    join(directory, 'internal.d.ts'),
    declaration
      .replace(/from ['"]@mui\/types['"]/, `from ${JSON.stringify(muiTypes)}`)
      .replace(/from ['"]\.\.\/styles\/index\.js['"]/, `from ${JSON.stringify(styles)}`),
  );
  writeFileSync(
    join(directory, 'ambient.d.ts'),
    `import type * as MobileReact from ${JSON.stringify(mobileReactTypes)};
declare global {
  namespace React {
    type Ref<T> = MobileReact.Ref<T>;
    type CSSProperties = MobileReact.CSSProperties;
  }
}
export {};
`,
  );
  writeFileSync(
    join(directory, 'spread.ts'),
    `import type * as WebReact from 'react';
import type { AutocompleteRenderInputParams } from ${JSON.stringify(join(materialRoot, 'Autocomplete/Autocomplete.d.ts'))};
import type { TextFieldProps } from ${JSON.stringify(join(materialRoot, 'TextField/TextField.d.ts'))};
import type { InternalStandardProps } from './internal';
type InputProps = InternalStandardProps<WebReact.HTMLAttributes<HTMLDivElement>>;
type ScopedTextFieldProps = Omit<TextFieldProps, 'InputProps'> & { InputProps?: InputProps };
declare const params: AutocompleteRenderInputParams;
export const field: ScopedTextFieldProps = { ...params };
`,
  );
  const configPath = join(directory, 'tsconfig.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        target: 'esnext',
        types: [],
        paths: { react: [webReactTypes] },
      },
      files: ['ambient.d.ts', 'spread.ts'],
    }),
  );
  const result = spawnSync('vp', ['exec', 'tsc', '--project', configPath, '--pretty', 'false'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

describe('MUI refs in a mixed web/mobile React type graph', () => {
  it.each(['internal/index.d.ts', 'esm/internal/index.d.ts'])(
    '%s scopes Autocomplete-to-TextField refs to web React',
    (relativePath) => {
      const sourcePath = join(materialRoot, relativePath);
      const patched = readFileSync(sourcePath, 'utf8');
      const original = patched.replace(/^import type \* as React from ['"]react['"];\r?\n/m, '');
      const before = compileSpread(sourcePath, original);
      expect(before.status).not.toBe(0);
      expect(before.output).toContain('TS2322');
      expect(before.output).toContain('VoidOrUndefinedOnly');

      const after = compileSpread(sourcePath, patched);
      expect(after.output).toBe('');
      expect(after.status).toBe(0);
    },
    20_000,
  );
});
