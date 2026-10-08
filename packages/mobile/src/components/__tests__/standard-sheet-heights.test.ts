import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// HIG Sheets: medium/large or measured content. Scan actual expressions rather
// than lines, including multiline JSX and aliases passed through useMemo.
const MOBILE_ROOT = join(__dirname, '../../..');
const STANDARD_PERCENTS = new Set(['50%', '90%', '100%']);

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...listSourceFiles(fullPath));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function customSnapPercents(source: string): string[] {
  const content = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\w])\/\/.*$/gm, '$1');
  const declarations = new Map<string, string>();
  const expressions: string[] = [];
  for (const match of content.matchAll(/\b(?:const|let|var)\s+([\w$]+)(?:\s*:[^=;]+)?\s*=\s*([\s\S]*?);/g)) {
    declarations.set(match[1], match[2]);
    if (/snap.*point|detent/i.test(match[1])) expressions.push(match[2]);
  }
  for (const match of content.matchAll(/\bsnapPoints\s*=\s*\{([\s\S]*?)\}/g)) expressions.push(match[1]);
  const points = new Set<string>();
  const read = (expression: string, seen: Set<string>) => {
    for (const match of expression.matchAll(/['"](\d+(?:\.\d+)?%)['"]/g))
      if (!STANDARD_PERCENTS.has(match[1])) points.add(match[1]);
    for (const match of expression.matchAll(/\b[\w$]+\b/g)) {
      const name = match[0];
      const initializer = declarations.get(name);
      if (initializer && !seen.has(name)) {
        seen.add(name);
        read(initializer, seen);
      }
    }
  };
  for (const expression of expressions) read(expression, new Set());
  return [...points];
}

const SOURCES = new Map(
  [...listSourceFiles(join(MOBILE_ROOT, 'src')), ...listSourceFiles(join(MOBILE_ROOT, 'app'))].map((filePath) => [
    relative(MOBILE_ROOT, filePath).split(sep).join('/'),
    readFileSync(filePath, 'utf8'),
  ]),
);

describe('standard sheet heights', () => {
  it('scans the production source tree', () => {
    expect(SOURCES.size).toBeGreaterThan(200);
    expect(SOURCES.has('src/components/sheet-snap-points.ts')).toBe(true);
  });

  it('finds inline, multiline, and aliased custom detents', () => {
    expect(customSnapPercents("const SNAP_POINTS = ['72%'];")).toEqual(['72%']);
    expect(customSnapPercents("<Sheet snapPoints={[\n'55%',\n'92%'\n]} />")).toEqual(['55%', '92%']);
    expect(
      customSnapPercents(
        "const heights = ['62%']; const points = useMemo(() => heights, []); <Sheet snapPoints={points} />",
      ),
    ).toEqual(['62%']);
  });

  it('allows standard detents, measured sizing, comments, and unrelated percentages', () => {
    expect(
      customSnapPercents("const SNAP_POINTS = ['50%', '90%', '100%']; <Sheet snapPoints={SNAP_POINTS} />"),
    ).toEqual([]);
    expect(customSnapPercents('const SNAP_POINTS = [measuredHeight]; <Sheet enableDynamicSizing />')).toEqual([]);
    expect(
      customSnapPercents(
        "// snapPoints={['55%']}\nconst styles = { width: '72%' }; <Sheet snapPoints={['50%', '90%']} />",
      ),
    ).toEqual([]);
  });

  it('has no custom percentages in production sheet detents', () => {
    const offenders = [...SOURCES]
      .map(([path, source]) => ({ path, points: customSnapPercents(source) }))
      .filter(({ points }) => points.length > 0)
      .map(({ path, points }) => `${path}: ${points.join(', ')}`);
    expect(offenders).toEqual([]);
  });
});
