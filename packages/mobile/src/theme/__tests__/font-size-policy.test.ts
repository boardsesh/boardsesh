import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__' || entry.name === 'node_modules') return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? componentFiles(path) : entry.name.endsWith('.tsx') ? [path] : [];
  });
}
it('mobile content and inputs resolve font sizes through theme tokens', () => {
  const violations = [
    ...componentFiles(join(mobileRoot, 'app')),
    ...componentFiles(join(mobileRoot, 'src/components')),
  ].filter((path) => /\bfontSize:\s*\d/.test(readFileSync(path, 'utf8')));
  expect(violations).toEqual([]);
});
