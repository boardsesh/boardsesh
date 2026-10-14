// Settings is one stack registered in eight places: the root `settings/`, the
// iOS Account sheet, and every tab, so a page opened from a tab keeps that tab's
// bar and its Back. Each copy is a one-line re-export of the real route. A page
// missing from one copy is a row that pushes into a navigator without it, which
// only shows up on a phone, in that one scope. This test is the guard.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const settingsRoot = join(appRoot, 'settings');

const MIRRORS = [
  'account/settings',
  '(tabs)/home/settings',
  '(tabs)/climbs/settings',
  '(tabs)/record/settings',
  '(tabs)/discover/settings',
  '(tabs)/profile/settings',
  '(tabs)/wall/settings',
];

/** Route files under `root`, as POSIX paths relative to it. Tests are not routes. */
function routeFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((path) => !path.split('/').includes('__tests__'))
    .sort();
}

const realRoutes = routeFiles(settingsRoot);

describe('settings route mirrors', () => {
  it('finds the real settings routes', () => {
    expect(realRoutes).toContain('index.tsx');
    expect(realRoutes).toContain('_layout.tsx');
    expect(realRoutes).toContain('board-look/index.tsx');
  });

  it.each(MIRRORS)('%s carries every settings route, and nothing else', (mirror) => {
    expect(routeFiles(join(appRoot, mirror))).toEqual(realRoutes);
  });

  it.each(MIRRORS)('%s re-exports each route from the real one', (mirror) => {
    for (const route of realRoutes) {
      const source = readFileSync(join(appRoot, mirror, route), 'utf8');
      const target = route.replace(/\.tsx$/, '');
      expect(source.trim()).toMatch(new RegExp(`^export \\{ default \\} from '(\\.\\./)+settings/${target}';$`));
    }
  });
});
