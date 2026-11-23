import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { themeTokens } from '../theme-config';
import { describe, expect, it } from 'vite-plus/test';

function unreadableForegrounds(source: string): string[] {
  return [
    ...source.matchAll(/(?:\bcolor\s*:\s*['"]var\(--neutral-400\)['"]|\bcolor\s*:\s*themeTokens\.neutral\[400\])/g),
  ].map((match) => match[0]);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return [];
    const filename = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(filename) : /\.tsx?$/.test(entry.name) ? [filename] : [];
  });
}

describe('readable public foreground tokens', () => {
  it('detects decorative grey used as text and accepts the readable token', () => {
    expect(unreadableForegrounds("const helperSx = { color: 'var(--neutral-400)' }")).toHaveLength(1);
    expect(unreadableForegrounds('const helperSx = { color: themeTokens.neutral[400] }')).toHaveLength(1);
    expect(unreadableForegrounds("const helperSx = { color: 'var(--neutral-500)' }")).toEqual([]);
  });
  it('keeps climb, board-list and setter reading surfaces out of the decorative tier', () => {
    const appRoot = [resolve(process.cwd(), 'packages/web/app'), resolve(process.cwd(), 'app')].find(existsSync);
    if (!appRoot) throw new Error('Web app source not found');
    const violations = ['components/climb-front-door', 'components/climb-detail', 'setter']
      .flatMap((directory) => sourceFiles(join(appRoot, directory)))
      .flatMap((filename) =>
        unreadableForegrounds(readFileSync(filename, 'utf8')).map((foreground) => `${filename}: ${foreground}`),
      );
    expect(violations).toEqual([]);
  });
  it('keeps the retired /help reading tokens retired', () => {
    const appRoot = [resolve(process.cwd(), 'packages/web/app'), resolve(process.cwd(), 'app')].find(existsSync);
    if (!appRoot) throw new Error('Web app source not found');
    expect(readFileSync(join(appRoot, 'components/index.css'), 'utf8')).not.toContain('--read-');
    expect(Object.keys(themeTokens)).not.toContain('read');
    const stragglers = sourceFiles(join(appRoot, 'help')).filter((filename) =>
      readFileSync(filename, 'utf8').includes('--read-'),
    );
    expect(stragglers).toEqual([]);
  });
});
