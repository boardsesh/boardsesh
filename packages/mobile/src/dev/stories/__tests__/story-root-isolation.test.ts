import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { storyRouteName } from '../story-route-name';

const root = readFileSync(new URL('../../../../app/_layout.tsx', import.meta.url), 'utf8');
const isolated = readFileSync(new URL('../StoryRoot.tsx', import.meta.url), 'utf8');

describe('isolated story root', () => {
  it('defers the live application import until the root has chosen its runtime', () => {
    expect(root).not.toMatch(/import\s+(?!type)[^;]*from\s*['"][^'"]*application-root/);
    expect(root).toContain("application ??= require('../src/application-root')");
    const selection = root.slice(root.indexOf('export default function RootLayout'));
    expect(selection.indexOf('const StoryRoot = loadStoryRoot()')).toBeLessThan(
      selection.indexOf('renderApplication()'),
    );
    expect(root).toContain("pathname.startsWith('/dev/stories')");
  });

  it('mounts presentation providers without live data, persistence or device services', () => {
    expect(isolated).toContain('preferences={null}');
    expect(isolated).toContain('<I18nextProvider i18n={localeInstance}>');
    expect(isolated).not.toMatch(
      /\b(?:AuthProvider|DatabaseProvider|QueryProvider|BluetoothProvider|QueueProvider|AnalyticsProvider)\b/,
    );
    expect(isolated).toContain('<Stack.Protected guard={false} redirectTo="/dev/stories">');
  });

  it.each([
    ['index.tsx', 'index'],
    ['./dev/story-tabs/_layout.tsx', 'dev/story-tabs'],
    ['(tabs)/_layout.tsx', '(tabs)'],
    ['dev/stories/index.tsx', 'dev/stories/index'],
    ['dev/stories/[id].tsx', 'dev/stories/[id]'],
    ['users/[userId]/index.tsx', 'users/[userId]/index'],
  ])('guards the root route named by %s', (filename, name) => {
    expect(storyRouteName(filename)).toBe(name);
  });
});
