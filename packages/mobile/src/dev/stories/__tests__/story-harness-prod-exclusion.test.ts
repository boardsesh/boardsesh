import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// The story harness must never reach a production bundle. `load.ts` is the one
// door: its requires sit behind `__DEV__`, which Metro folds away in production.
// This test keeps every other app file going through that door. The full proof
// is `vp run check:mobile-bundle`, which fails if the harness shows up in a real
// export.

const MOBILE_DIR = join(__dirname, '..', '..', '..', '..');
const HARNESS_DIR = join(MOBILE_DIR, 'src', 'dev', 'stories');
const HARNESS_DOOR = join(HARNESS_DIR, 'load');

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

type ModuleReference = { specifier: string; typeOnly: boolean };

// One regex per statement shape, so "type-only" is decided by the statement's
// own keyword, never by text nearby.
// `import type … from 'x'` / `export type … from 'x'` (type-only) and every
// other `import … from` / `export … from`. The clause can't hold a quote or a
// semicolon, so a match never runs into the next statement.
const FROM_STATEMENT = /\b(?:import|export)\s+(type\s+)?[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g;
// `import 'x'`: a side-effect import.
const BARE_IMPORT = /\bimport\s*['"]([^'"]+)['"]/g;
// `require('x')` and `import('x')`; `typeof import('x')` is a type.
const CALL = /(\btypeof\s+)?\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]/g;

function moduleReferences(source: string): ModuleReference[] {
  const references: ModuleReference[] = [];
  for (const match of source.matchAll(FROM_STATEMENT)) {
    references.push({ specifier: match[2] ?? '', typeOnly: match[1] !== undefined });
  }
  for (const match of source.matchAll(BARE_IMPORT)) {
    references.push({ specifier: match[1] ?? '', typeOnly: false });
  }
  for (const match of source.matchAll(CALL)) {
    references.push({ specifier: match[2] ?? '', typeOnly: match[1] !== undefined });
  }
  return references;
}

function reachesHarness(file: string, specifier: string): boolean {
  if (specifier.startsWith('.')) {
    const target = resolve(dirname(file), specifier).replace(/\.tsx?$/, '');
    return (target === HARNESS_DIR || target.startsWith(HARNESS_DIR + sep)) && target !== HARNESS_DOOR;
  }
  return /(^|\/)dev\/stories(\/|$)/.test(specifier) && !/(^|\/)dev\/stories\/load$/.test(specifier);
}

/**
 * What `source` (the text of app file `file`) imports that would pull the story
 * harness into a production bundle: a value import of anything under
 * src/dev/stories except `load.ts`, or any import of a `*.stories` file.
 */
function harnessImportOffences(file: string, source: string): string[] {
  const offences: string[] = [];
  for (const { specifier, typeOnly } of moduleReferences(source)) {
    if (/\.stories(\.tsx?)?$/.test(specifier) || (!typeOnly && reachesHarness(file, specifier))) {
      offences.push(specifier);
    }
  }
  return offences;
}

describe('harnessImportOffences', () => {
  const file = join(MOBILE_DIR, 'src', 'providers', 'example.tsx');

  it('flags a value import even when a type-only import sits on the line before', () => {
    const source = "import type { ReactNode } from 'react';\nimport { STORIES } from '../dev/stories/registry';\n";
    expect(harnessImportOffences(file, source)).toEqual(['../dev/stories/registry']);
  });

  it('flags a value import after a type-only harness import', () => {
    const source = [
      "import type { StoryModule } from '../dev/stories/types';",
      "import { findStory } from '../dev/stories/registry-core';",
    ].join('\n');
    expect(harnessImportOffences(file, source)).toEqual(['../dev/stories/registry-core']);
  });

  it('allows type-only imports and exports, typeof import(), and load.ts', () => {
    const source = [
      "import type { StoryModule } from '../dev/stories/types';",
      "export type { ScenarioOverrides } from '../dev/stories/scenario-overrides';",
      "type Screens = typeof import('../dev/stories/screens');",
      "import { DevScenarioOverridesHost } from '../dev/stories/load';",
      "import { loadStoryScreens } from '../dev/stories/load.ts';",
    ].join('\n');
    expect(harnessImportOffences(file, source)).toEqual([]);
  });

  it('treats inline `type` specifiers as a real import', () => {
    expect(harnessImportOffences(file, "import { type StoryModule } from '../dev/stories/types';")).toEqual([
      '../dev/stories/types',
    ]);
  });

  it('flags multi-line, side-effect, re-export, require and dynamic imports', () => {
    const source = [
      'import {',
      '  STORIES,',
      "} from '../dev/stories/registry';",
      "import '../dev/stories/registry';",
      "export * from '../dev/stories/screens';",
      "const screens = require('../dev/stories/screens');",
      "void import('../dev/stories/screens');",
    ].join('\n');
    expect(harnessImportOffences(file, source)).toEqual([
      '../dev/stories/registry',
      '../dev/stories/screens',
      '../dev/stories/registry',
      '../dev/stories/screens',
      '../dev/stories/screens',
    ]);
  });

  it('resolves relative paths that never spell out dev/stories', () => {
    const devFile = join(MOBILE_DIR, 'src', 'dev', 'tools.ts');
    expect(harnessImportOffences(devFile, "import { STORIES } from './stories/registry';")).toEqual([
      './stories/registry',
    ]);
    expect(harnessImportOffences(devFile, "import { DevScenarioOverridesHost } from './stories/load';")).toEqual([]);
  });

  it('flags any import of a *.stories file', () => {
    const source = [
      "import crew from '../components/play-drawer/CrewBrowse.stories';",
      "import type { StoryModule } from './Pill.stories.tsx';",
    ].join('\n');
    expect(harnessImportOffences(file, source)).toEqual([
      '../components/play-drawer/CrewBrowse.stories',
      './Pill.stories.tsx',
    ]);
  });

  it('ignores unrelated imports', () => {
    expect(
      harnessImportOffences(file, "import { Stories } from '../lib/stories';\nimport x from 'dev-stories';"),
    ).toEqual([]);
  });
});

describe('story harness stays out of production code paths', () => {
  it('app code reaches src/dev/stories only through load.ts, and never imports a story file', () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(join(MOBILE_DIR, 'app')), ...sourceFiles(join(MOBILE_DIR, 'src'))]) {
      // The harness and story files are dev-only themselves.
      if (file.startsWith(HARNESS_DIR + sep) || /\.stories\.tsx?$/.test(file)) continue;
      for (const specifier of harnessImportOffences(file, readFileSync(file, 'utf8'))) {
        offenders.push(`${relative(MOBILE_DIR, file)} imports ${specifier}`);
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
